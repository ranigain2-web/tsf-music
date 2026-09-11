#!/usr/bin/env bash
#
# TSF Music — one-command macOS installer  (free / ad-hoc signed path)
#
# WHY THIS EXISTS
#   The release is ad-hoc signed (no $99/yr Apple Developer ID), so macOS
#   Gatekeeper blocks the app if you install it the usual way: Safari/Chrome
#   stamps the download with a quarantine flag, and an unsigned quarantined app
#   is refused. The flag is applied by the *browser*, not by GitHub — so a
#   Terminal download never gets it in the first place. This script does the
#   whole install that way: download → verify → install → launch, no prompts.
#
# USAGE
#   curl -fsSL https://raw.githubusercontent.com/ranigain2-web/tsf-music/main/desktop/install-macos.sh | bash
#
#   # or from a checkout:
#   bash desktop/install-macos.sh
#
#   Options (env vars):
#     TSF_DEST=/Applications     where to install        (default /Applications)
#     TSF_TAG=v0.4.1             pin a release           (default: latest)
#     TSF_NO_LAUNCH=1            install but don't open it
#     TSF_FORCE=1                reinstall even if the same version is present
#
set -euo pipefail

REPO="ranigain2-web/tsf-music"
APP_BUNDLE="TSF Music.app"
APP_BIN="TSF Music"
DEST="${TSF_DEST:-/Applications}"
TAG="${TSF_TAG:-}"

# ── pretty output ───────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YEL=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=; DIM=; RED=; GRN=; YEL=; CYN=; RST=
fi
step() { printf '%s▸%s %s\n' "$CYN" "$RST" "$1"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$1"; }
warn() { printf '%s!%s %s\n' "$YEL" "$RST" "$1"; }
die()  { printf '\n%s✗ %s%s\n' "$RED" "$1" "$RST" >&2; exit 1; }

printf '\n%sTSF Music%s %s installer\n' "$BOLD" "$RST" "$DIM(free / ad-hoc signed)$RST"
printf '%s\n' "${DIM}────────────────────────────────────────────${RST}"

# ── 0. platform + tooling guards ────────────────────────────────────────────
[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS only. See desktop/README-MACOS.md for other platforms."
for bin in curl hdiutil ditto xattr; do
  command -v "$bin" >/dev/null 2>&1 || die "Required macOS tool '$bin' not found."
done

HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  arm64)  ARCH="arm64"  ; LABEL="Apple Silicon" ;;
  x86_64) ARCH="x64"    ; LABEL="Intel" ;;
  *)      die "Unsupported CPU: $HOST_ARCH" ;;
esac
ok "Detected ${BOLD}${LABEL}${RST} (${HOST_ARCH}) → asset suffix ${BOLD}-${ARCH}${RST}"

# ── 1. resolve the release ──────────────────────────────────────────────────
if [ -z "$TAG" ]; then
  step "Finding the newest release…"
  # The /releases/latest redirect carries the tag; no API token, no rate drama.
  TAG="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest" 2>/dev/null | sed 's#.*/tag/##')"
  case "$TAG" in v[0-9]*) ;; *) die "Could not resolve the latest release tag (got '${TAG:-empty}')." ;; esac
fi
VERSION="${TAG#v}"
DMG_NAME="TSF-Music-${VERSION}-${ARCH}.dmg"
DMG_URL="https://github.com/${REPO}/releases/download/${TAG}/${DMG_NAME}"
ok "Release ${BOLD}${TAG}${RST} → ${DMG_NAME}"

# ── 2. already installed? ───────────────────────────────────────────────────
INSTALLED="${DEST}/${APP_BUNDLE}"
if [ -d "$INSTALLED" ] && [ -z "${TSF_FORCE:-}" ]; then
  HAVE="$(defaults read "${INSTALLED}/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo '?')"
  if [ "$HAVE" = "$VERSION" ]; then
    ok "TSF Music ${VERSION} is already installed in ${DEST}."
    printf '   %sUse TSF_FORCE=1 to reinstall anyway.%s\n' "$DIM" "$RST"
    [ -z "${TSF_NO_LAUNCH:-}" ] && { step "Launching…"; open "$INSTALLED"; }
    exit 0
  fi
  warn "Upgrading ${HAVE} → ${VERSION}"
fi

# ── 3. download + verify ────────────────────────────────────────────────────
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tsf-install.XXXXXX")"
MOUNTED=""
cleanup() {
  [ -n "$MOUNTED" ] && hdiutil detach "$MOUNTED" -quiet -force >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

step "Downloading ${DMG_NAME} (${DIM}~280 MB, this is the slow part${RST})…"
curl -fL --progress-bar --connect-timeout 20 -o "$WORK/$DMG_NAME" "$DMG_URL" \
  || die "Download failed. Check your connection, or that the release still has ${DMG_NAME}."

SIZE_BYTES="$(stat -f%z "$WORK/$DMG_NAME" 2>/dev/null || echo 0)"
[ "$SIZE_BYTES" -gt 50000000 ] || die "Download looks truncated (${SIZE_BYTES} bytes). Re-run to retry."
ok "Downloaded $(printf '%.0f' "$(echo "$SIZE_BYTES / 1048576" | bc -l 2>/dev/null || echo 0)") MB"

# SHA-256 is verified when the release publishes a checksum (CI does for v0.4.2+).
SUMS_URL="https://github.com/${REPO}/releases/download/${TAG}/SHA256SUMS.txt"
if curl -fsSL --connect-timeout 15 -o "$WORK/SHA256SUMS.txt" "$SUMS_URL" 2>/dev/null; then
  EXPECTED="$(awk -v n="$DMG_NAME" '$2 == n {print $1}' "$WORK/SHA256SUMS.txt" | head -1)"
  if [ -n "$EXPECTED" ]; then
    ACTUAL="$(shasum -a 256 "$WORK/$DMG_NAME" | awk '{print $1}')"
    [ "$EXPECTED" = "$ACTUAL" ] || die "Checksum mismatch — refusing to install a corrupted/unexpected file."
    ok "SHA-256 verified"
  fi
else
  printf '   %s(no SHA256SUMS.txt in this release — skipping checksum, verifying signature instead)%s\n' "$DIM" "$RST"
fi

# ── 4. mount + sanity-check the bundle ──────────────────────────────────────
step "Mounting the disk image…"
hdiutil attach "$WORK/$DMG_NAME" -nobrowse -quiet -noverify || die "Could not mount the DMG."
MOUNTED="$(hdiutil info | awk -v img="$WORK/$DMG_NAME" '$0 ~ img {f=1} f && /\/Volumes\// {print $NF; exit}')"
[ -n "$MOUNTED" ] && [ -d "$MOUNTED" ] || MOUNTED="$(ls -d /Volumes/TSF* 2>/dev/null | head -1)"
[ -n "$MOUNTED" ] && [ -d "$MOUNTED" ] || die "DMG mounted but no /Volumes entry found."
[ -d "${MOUNTED}/${APP_BUNDLE}" ] || die "'${APP_BUNDLE}' not found inside the DMG (bad release?)."
ok "Mounted at ${MOUNTED}"

APP_BIN_PATH="${MOUNTED}/${APP_BUNDLE}/Contents/MacOS/${APP_BIN}"
if [ -f "$APP_BIN_PATH" ] && command -v lipo >/dev/null 2>&1; then
  if lipo -archs "$APP_BIN_PATH" 2>/dev/null | tr ' ' '\n' | grep -qx "$HOST_ARCH"; then
    ok "Bundle architecture matches this Mac (${ARCH})"
  else
    die "This DMG is built for a different CPU than your Mac (${HOST_ARCH}). Re-run without TSF_TAG."
  fi
fi

# ── 5. quit a running copy, then install ────────────────────────────────────
if pgrep -x "$APP_BIN" >/dev/null 2>&1; then
  step "Quitting the running copy…"
  osascript -e "tell application \"${APP_BIN}\" to quit" >/dev/null 2>&1 || true
  sleep 2
  pkill -x "$APP_BIN" >/dev/null 2>&1 || true
fi

if [ ! -w "$DEST" ]; then
  die "${DEST} is not writable by $(whoami). Re-run with: sudo -v first, or set TSF_DEST=~/Applications"
fi

step "Installing to ${DEST}…"
if [ -d "$INSTALLED" ]; then
  rm -rf "$INSTALLED" || die "Could not replace the existing copy (is it running?)."
fi
# `ditto` (not `cp -R`) — it preserves the code signature and xattrs correctly.
ditto "${MOUNTED}/${APP_BUNDLE}" "$INSTALLED" || die "Copy to ${DEST} failed."

# ── 6. clear quarantine (the whole point) ───────────────────────────────────
step "Clearing the Gatekeeper quarantine flag…"
xattr -cr "$INSTALLED" 2>/dev/null || warn "xattr reported an issue; trying again with sudo is unnecessary — verify with the doctor command below."
if xattr -p com.apple.quarantine "$INSTALLED" >/dev/null 2>&1; then
  warn "Quarantine flag is still present — macOS may prompt on first launch."
else
  ok "No quarantine flag on the installed app"
fi

# ── 7. verify the signature honestly (ad-hoc = expected) ────────────────────
if codesign --verify --strict "$INSTALLED" >/dev/null 2>&1; then
  AUTHORITY="$(codesign -dv --verbose=2 "$INSTALLED" 2>&1 | awk -F= '/^Authority=/{print $2; exit}')"
  if [ -n "$AUTHORITY" ]; then
    ok "Signature verified — ${AUTHORITY}"
  else
    ok "Signature verified (ad-hoc, as expected for the free build)"
  fi
else
  warn "codesign --verify did not pass. The app usually still runs; see the doctor command."
fi

step "Detaching the disk image…"
hdiutil detach "$MOUNTED" -quiet -force >/dev/null 2>&1 || true
MOUNTED=""

# ── 8. launch ───────────────────────────────────────────────────────────────
if [ -z "${TSF_NO_LAUNCH:-}" ]; then
  step "Launching TSF Music…"
  open "$INSTALLED" || warn "Could not auto-open — launch it from Launchpad."
fi

printf '\n%s✅ TSF Music %s is installed.%s\n' "$GRN" "$VERSION" "$RST"
printf '%s\n' "${DIM}────────────────────────────────────────────${RST}"
cat <<EOF
  ${BOLD}First launch${RST}  boots the app's own local engine (5-15 s).
                It will feel fastest after that first minute —
                the engine pre-warms your recent tracks on every start.

  ${BOLD}If anything looks wrong${RST}, run the doctor:
    curl -fsSL https://raw.githubusercontent.com/${REPO}/main/desktop/tsf-doctor.sh | bash

  ${BOLD}Logs${RST}          ~/Library/Logs/com.tsfmusic.desktop/
  ${BOLD}Your database${RST} ~/Library/Application Support/com.tsfmusic.desktop/tsf.db

  ${DIM}Uninstall:  rm -rf "${INSTALLED}" ~/Library/Application\\ Support/com.tsfmusic.desktop${RST}
EOF
printf '\n'
