#!/bin/bash
# TSF baseline gauntlet — tests the running server end-to-end
BASE=http://localhost:3000
PASS=0; FAIL=0; declare -a RESULTS

t() { # name, expected, actual
  if [[ "$3" == *"$2"* ]]; then PASS=$((PASS+1)); RESULTS+=("PASS  $1 → $3");
  else FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1 → expected '$2' got: $3"); fi
}

# 1. health
t "health" '"ok":true' "$(curl -s --max-time 10 $BASE/api/health)"

# 2. pages
t "home page" '200' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 $BASE/)"
t "search page" '200' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 $BASE/search)"

# 3. search API (WEB_REMIX metadata — should work from datacenter IP)
S=$(curl -s --max-time 15 "$BASE/api/ytm/search?q=Kesariya&limit=3")
t "search API returns tracks" '"title"' "$S"
t "search durations present" '"duration"' "$S"
echo "search sample: $(echo $S | head -c 300)"

# 4. stream resolve (HEAD) — datacenter IP: expect iTunes/synth fallback
H=$(curl -s -I --max-time 30 "$BASE/api/stream?id=BddP6PYo2gs&title=Kesariya&artist=Arijit%20Singh&dur=269")
t "stream HEAD 200" '200' "$(echo "$H" | head -1)"
echo "provider: $(echo "$H" | grep -i x-stream-provider)"

# 5. stream GET no-Range (QA Bug #1 regression check)
R=$(curl -s -o /tmp/stream_test.bin -w '%{http_code} %{size_download}' --max-time 60 "$BASE/api/stream?id=BddP6PYo2gs&title=Kesariya&artist=Arijit%20Singh&dur=269&proxy=1")
t "stream GET proxy no-Range succeeds" '200' "$R"
echo "bytes: $R"

# 6. stream GET with Range
RR=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -H 'Range: bytes=0-1023' "$BASE/api/stream?id=BddP6PYo2gs&title=Kesariya&artist=Arijit%20Singh&dur=269&proxy=1")
t "stream GET proxy Range=206" '206' "$RR"

# 7. download route (QA Bug #3 regression check)
D=$(curl -s -o /tmp/dl_test.m4a -w '%{http_code} %{size_download}' --max-time 90 "$BASE/api/download?id=BddP6PYo2gs&title=Kesariya&artist=Arijit%20Singh&dur=269")
t "download succeeds" '200' "$D"
echo "download: $D bytes"

echo ""; echo "===== RESULTS ====="
printf '%s\n' "${RESULTS[@]}"
echo "PASS=$PASS FAIL=$FAIL"
