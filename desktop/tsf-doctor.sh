#!/usr/bin/env bash
#
# TSF Music — doctor / diagnostics
#
# Answers the only two questions that matter when something feels wrong:
#   1. Is the app's local engine actually healthy?
#   2. When I press play, am I getting REAL full-length audio, an honest 30 s
#      preview, or the offline synth fallback?
#
# It deliberately avoids a JSON parser (macOS doesn't guarantee python3/jq) and
# reads the app's own response *headers* instead — the same honesty headers the
# UI's coloured source badge is built from.
#
# USAGE
#   curl -fsSL https://raw.githubusercontent.com/ranigain2-web/tsf-music/main/desktop/tsf-doctor.sh | bash
#   bash desktop/tsf-doctor.sh
#   TSF_PORT=3000 bash desktop/tsf-doctor.sh     # check a `bun run dev` server
#
set -uo pipefail

REPO="ranigain2-web/tsf-music"
APP_BUNDLE="TSF Music.app"
APP_BIN="TSF Music"
APP="${TSF_APP:-/Applications/${APP_BUNDLE}}"
SUPPORT="${HOME}/Library/Application Support/com.tsfmusic.desktop"
LOGS="${HOME}/Library/Logs/com.tsfmusic.desktop"
TEST_TRACK="${TSF_TEST_TRACK:-dQw4w9WgXcQ}"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YEL=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=; DIM=; RED=; GRN=; YEL=; CYN=; RST=;
fi
PASSED=0; WARNED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '  %s✓%s %s\n' "$GRN" "$RST" "$1"; }
warn() { WARNED=$((WARNED + 1)); printf '  %s!%s %s\n' "$YEL" "$RST" "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
row()  { printf '  %s%-17s%s %s\n' "$DIM" "$1" "$RST" "$2"; }
head_() { printf '\n%s%s%s\n' "$BOLD" "$1" "$RST"; }

printf '\n%sTSF Music — doctor%s\n' "$BOLD" "$RST"
printf '%s\n' "${DIM}────────────────────────────────────────────────────────${RST}"

# ── environment ─────────────────────────────────────────────────────────────
head_ "This Mac"
if [ "$(uname -s)" = "Darwin" ]; then
  OSVER="$(sw_vers -productVersion 2>/dev/null || echo '?')"
  ARCH="$(uname -m)"
  case "$ARCH" in arm64) ANAME="Apple Silicon" ;; x86_64) ANAME="Intel" ;; *) ANAME="$ARCH" ;; esac
  row "macOS" "${OSVER} (${ANAME})"
  pass "Running macOS ${OSVER}"
else
  fail "Not macOS ($(uname -s)) — this app is macOS-only. (Doctor will keep going; engine checks still work.)"
fi

# ── the app bundle ──────────────────────────────────────────────────────────
head_ "The app"
if [ -d "$APP" ]; then
  VERSION="$(defaults read "${APP}/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo '?')"
  row "Location" "$APP"
  pass "Installed (version ${BOLD}${VERSION}${RST})"

  if xattr -p com.apple.quarantine "$APP" >/dev/null 2>&1; then
    warn "Quarantine flag is present — macOS may block the first launch."
    printf '     %sFix: xattr -cr "%s"   (or re-run desktop/install-macos.sh)%s\n' "$DIM" "$APP" "$RST"
  else
    pass "No quarantine flag"
  fi

  if codesign --verify --strict "$APP" >/dev/null 2>&1; then
    AUTHORITY="$(codesign -dv --verbose=2 "$APP" 2>&1 | awk -F= '/^Authority=/{print $2; exit}')"
    if [ -n "$AUTHORITY" ]; then
      pass "Signature valid — ${AUTHORITY}"
    else
      pass "Signature valid (ad-hoc — expected for the free build)"
    fi
  else
    fail "codesign --verify failed — the bundle may be corrupt or modified."
  fi

  # The engine is spawned from the bundle; if these are missing the app cannot play.
  MISSING=""
  for rel in "Contents/Resources/runtime/bun" "Contents/Resources/server/server.js" "Contents/Resources/bin/yt-dlp"; do
    [ -e "${APP}/${rel}" ] || MISSING="${MISSING} ${rel}"
  done
  if [ -z "$MISSING" ]; then
    pass "Bundled engine present (bun + server + yt-dlp)"
  else
    fail "Bundled engine incomplete — missing:${MISSING}"
  fi
  if [ -x "${APP}/Contents/Resources/bin/yt-dlp" ]; then
    YTV="$("${APP}/Contents/Resources/bin/yt-dlp" --version 2>/dev/null | head -1)"
    row "Bundled yt-dlp" "${YTV:-unknown}"
  fi
else
  fail "Not installed at ${APP}"
  printf '     %sInstall with:%s\n' "$DIM" "$RST"
  printf '     curl -fsSL https://raw.githubusercontent.com/%s/main/desktop/install-macos.sh | bash\n' "$REPO"
fi

if pgrep -x "$APP_BIN" >/dev/null 2>&1; then
  pass "App is running (pid $(pgrep -x "$APP_BIN" | head -1))"
else
  warn "App is not running — launch it, then re-run this doctor for engine checks."
fi

# ── find the engine ─────────────────────────────────────────────────────────
head_ "The engine"
BASE=""
if [ -n "${TSF_PORT:-}" ]; then
  CANDIDATES="$TSF_PORT"
else
  # The shell binds find_free_port(8137, 12); a dev server usually sits on 3000.
  CANDIDATES="8137 8138 8139 8140 8141 8142 8143 8144 8145 8146 8147 8148 3000"
fi
probe_port() { # $1=timeout seconds  $2=port
  curl -fsS -m "$1" -o /dev/null -w '%{http_code}' "http://127.0.0.1:${2}/api/health" 2>/dev/null || echo 000
}
# Pass 1 — a quick scan finds an already-warm engine immediately.
for p in $CANDIDATES; do
  if [ "$(probe_port 2 "$p")" = "200" ]; then BASE="http://127.0.0.1:${p}"; PORT="$p"; break; fi
done
# Pass 2 — a just-launched engine needs 5-15 s before it answers at all, and
# its very first request is the slowest. Give it a real chance before crying
# "not running", otherwise the doctor reports a healthy app as broken.
if [ -z "$BASE" ]; then
  printf '  %s…no engine yet, waiting up to 20s for a cold one to answer%s\n' "$DIM" "$RST"
  for _ in 1 2 3 4; do
    for p in $CANDIDATES; do
      if [ "$(probe_port 8 "$p")" = "200" ]; then BASE="http://127.0.0.1:${p}"; PORT="$p"; break 2; fi
    done
    sleep 2
  done
fi

if [ -z "$BASE" ]; then
  fail "No healthy engine found on ports: ${CANDIDATES}"
  printf '     %sLaunch the app and give it ~15 s, or start a dev server:%s\n' "$DIM" "$RST"
  printf '     %sbun run dev%s\n' "$DIM" "$RST"
  printf '     %sLogs: %s%s\n' "$DIM" "$LOGS" "$RST"
else
  pass "Engine healthy at ${BASE}"

  HEALTH_MS="$(curl -fsS -m 20 -o /tmp/tsf-health.$$ -w '%{time_total}' "${BASE}/api/health" 2>/dev/null || echo '?')"
  row "Health latency" "$(awk -v t="$HEALTH_MS" 'BEGIN{printf "%.0f ms", t*1000}' 2>/dev/null || echo "$HEALTH_MS s")"

  HEALTH="$(cat /tmp/tsf-health.$$ 2>/dev/null)"
  rm -f "/tmp/tsf-health.$$"

  # No JSON parser needed, but each grep MUST be scoped to one sub-object:
  # the body is minified and the same key names recur elsewhere (`"ok":true`
  # also appears on resolve-feed rows, `"p50"` inside byProvider, …). Slicing
  # on our own stable key order is what keeps these numbers honest.
  PROVIDERS_JSON="$(printf '%s' "$HEALTH" | sed 's/.*"providers":\[//; s/\],"anyLive".*//')"
  YTDLP_JSON="$(printf '%s' "$HEALTH" | sed 's/.*"ytdlp":{//; s/},"ai".*//')"
  AI_JSON="$(printf '%s' "$HEALTH" | sed 's/.*"ai":{//; s/},"resolveMetrics".*//')"
  METRICS_JSON="$(printf '%s' "$HEALTH" | sed 's/.*"resolveMetrics":{//; s/},"recentResolves".*//')"
  METRICS_CORE="$(printf '%s' "$METRICS_JSON" | sed 's/,"byProvider":.*//')"

  if printf '%s' "$YTDLP_JSON" | grep -q '"available":true'; then
    YTVER="$(printf '%s' "$YTDLP_JSON" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
    YTPATH="$(printf '%s' "$YTDLP_JSON" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p')"
    pass "yt-dlp available${YTVER:+ (${YTVER})}"
    [ -n "${YTPATH:-}" ] && row "yt-dlp path" "$YTPATH"
  else
    fail "yt-dlp NOT available — full-length YouTube playback will fall back to previews."
    printf '     %sSee %s/pot-provider.log%s\n' "$DIM" "$LOGS" "$RST"
  fi

  P_TOTAL="$(printf '%s' "$PROVIDERS_JSON" | grep -o '"provider":"[^"]*"' | wc -l | tr -d ' ')"
  P_LIVE="$(printf '%s' "$PROVIDERS_JSON" | grep -o '"provider":"[^"]*","ok":true' | wc -l | tr -d ' ')"
  # paste only honours its FIRST delimiter for a single column, so join with a
  # comma and expand — `-d', '` would emit "a,b c".
  P_LIVE_NAMES="$(printf '%s' "$PROVIDERS_JSON" | grep -o '"provider":"[^"]*","ok":true' | sed 's/.*"provider":"//; s/".*//' | paste -sd, - 2>/dev/null | sed 's/,/, /g')"
  if [ "${P_LIVE:-0}" -gt 0 ]; then
    pass "${P_LIVE}/${P_TOTAL} providers healthy${P_LIVE_NAMES:+ — ${P_LIVE_NAMES}}"
  else
    warn "0/${P_TOTAL} providers healthy — they re-probe automatically; all-cooling is normal for a minute after boot."
  fi

  AI_PROVIDER="$(printf '%s' "$AI_JSON" | sed -n 's/.*"provider":"\([^"]*\)".*/\1/p')"
  if printf '%s' "$AI_JSON" | grep -q '"fastAvailable":true'; then
    pass "Local AI gateway ready${AI_PROVIDER:+ (${AI_PROVIDER})}"
  else
    warn "Local AI gateway unavailable — AI features use the keyless fallback chain (slower, still works)."
  fi

  M_TOTAL="$(printf '%s' "$METRICS_CORE" | sed -n 's/.*"total":\([0-9]*\).*/\1/p')"
  M_OK="$(printf '%s' "$METRICS_CORE" | sed -n 's/.*"okRate":\([0-9.]*\).*/\1/p')"
  M_P50="$(printf '%s' "$METRICS_CORE" | sed -n 's/.*"p50":\([0-9.]*\).*/\1/p')"
  M_P95="$(printf '%s' "$METRICS_CORE" | sed -n 's/.*"p95":\([0-9.]*\).*/\1/p')"
  if [ -n "${M_TOTAL:-}" ]; then
    row "Resolves" "${M_TOTAL} total, ${M_OK}% ok, p50 ${M_P50}ms, p95 ${M_P95}ms"
    printf '%s' "$METRICS_JSON" \
      | grep -o '"provider":"[^"]*","count":[0-9]*,"ok":[0-9]*' \
      | sed 's/"provider":"//; s/","count":/ /; s/,"ok":/ /' \
      | head -5 \
      | while read -r nm cnt okc; do
          [ -n "$nm" ] && printf '     %s%-24s%s %s/%s ok\n' "$DIM" "$nm" "$RST" "$okc" "$cnt"
        done
  fi
fi

# ── the test that actually matters ──────────────────────────────────────────
head_ "Live playback test  (${DIM}track ${TEST_TRACK}${RST})"
if [ -z "$BASE" ]; then
  warn "Skipped — no engine to test against."
else
  HDRS="$(mktemp /tmp/tsf-doctor-hdrs.XXXXXX)"
  STATS="$(curl -fsS -m 60 -o /dev/null -D "$HDRS" \
      -w '%{http_code} %{size_download} %{time_total}' \
      "${BASE}/api/stream?id=${TEST_TRACK}&proxy=1&fresh=1" 2>/dev/null || echo '000 0 0')"
  set -- $STATS
  CODE="${1:-000}"; BYTES="${2:-0}"; SECS="${3:-0}"
  PROVIDER="$(awk 'BEGIN{IGNORECASE=1}/^x-stream-provider:/{sub(/^[^:]*:[[:space:]]*/,""); gsub(/\r/,""); print; exit}' "$HDRS")"
  BITRATE="$(awk 'BEGIN{IGNORECASE=1}/^x-stream-bitrate:/{sub(/^[^:]*:[[:space:]]*/,""); gsub(/\r/,""); print; exit}' "$HDRS")"
  rm -f "$HDRS"

  row "HTTP" "${CODE} in $(awk -v t="$SECS" 'BEGIN{printf "%.2f", t}')s, ${BYTES} bytes"
  row "Provider" "${PROVIDER:-<none>}"
  [ -n "${BITRATE:-}" ] && row "Bitrate" "${BITRATE}"

  case "$PROVIDER" in
    *synth*)
      warn "Fell all the way back to the OFFLINE SYNTH (generated music, not the real track)."
      printf '     %sThis means every real provider failed or is rate-limited right now.%s\n' "$DIM" "$RST"
      printf '     %sTry: curl -fsS "%s/api/health?fresh=1"  then retry.%s\n' "$DIM" "$BASE" "$RST"
      ;;
    *itunes*|*preview*)
      warn "Got a 30-SECOND PREVIEW (iTunes) — the free tier of the chain."
      printf '     %sYouTube is refusing full-length for this track/network right now.%s\n' "$DIM" "$RST"
      printf '     %sTracks already in your library/cache often still play full-length:%s\n' "$DIM" "$RST"
      ;;
    "")
      fail "No X-Stream-Provider header — the stream route did not resolve (HTTP ${CODE})."
      ;;
    *)
      if [ "$CODE" = "200" ] || [ "$CODE" = "206" ]; then
        pass "FULL-LENGTH real audio via ${BOLD}${PROVIDER}${RST}"
      else
        fail "Provider reported '${PROVIDER}' but HTTP ${CODE}."
      fi
      ;;
  esac

  if [ "${BYTES:-0}" -gt 0 ] 2>/dev/null; then
    pass "Real bytes returned (${BYTES}) — the pipe is working"
  else
    fail "Zero bytes returned."
  fi
fi

# ── verdict ─────────────────────────────────────────────────────────────────
printf '\n%s\n' "${DIM}────────────────────────────────────────────────────────${RST}"
if [ "$FAILED" -eq 0 ] && [ "$WARNED" -eq 0 ]; then
  printf '%s✅ All %d checks passed — everything looks healthy.%s\n\n' "$GRN" "$PASSED" "$RST"
elif [ "$FAILED" -eq 0 ]; then
  printf '%s⚠  %d passed, %d warning(s), 0 failures.%s\n' "$YEL" "$PASSED" "$WARNED" "$RST"
  printf '%s   Warnings above are the honest-degradation cases, not crashes.%s\n\n' "$DIM" "$RST"
else
  printf '%s✗  %d passed, %d warning(s), %d failure(s).%s\n' "$RED" "$PASSED" "$WARNED" "$FAILED" "$RST"
  printf '%s   Scroll up — each failure prints how to fix it.%s\n\n' "$DIM" "$RST"
fi

cat <<EOF
${DIM}Useful paths${RST}
  Engine log        ${LOGS}/server.log
  POT provider log  ${LOGS}/pot-provider.log
  Database          ${SUPPORT}/tsf.db
  Raw health JSON   ${BASE:-http://127.0.0.1:8137}/api/health
EOF
printf '\n'

exit $([ "$FAILED" -eq 0 ] && echo 0 || echo 1)
