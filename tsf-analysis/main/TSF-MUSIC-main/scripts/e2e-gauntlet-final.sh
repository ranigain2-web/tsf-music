#!/bin/bash
# TSF FINAL GAUNTLET — Musify integration complete
BASE=http://localhost:3000
PASS=0; FAIL=0; declare -a RESULTS
t() {
  if [[ "$3" == *"$2"* ]]; then PASS=$((PASS+1)); RESULTS+=("PASS  $1");
  else FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1 → got: ${3:0:150}"); fi
}

echo "== 1. Core =="
t "health" '"ok":true' "$(curl -s --max-time 10 $BASE/api/health)"
t "home page" '200' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 $BASE/)"

echo "== 2. Search: 7 markets, top-12 duration cleanliness + junk-free =="
for Q in "Kesariya" "Shape of You" "Brown Munde" "Naatu Naatu" "Ilaiyaraaja hits" "Blinding Lights" "Bohemian Rhapsody"; do
  S=$(curl -s --max-time 30 "$BASE/api/ytm/search?q=$(echo $Q | sed 's/ /%20/g')&limit=45")
  t "search: $Q" '"videoId"' "$S"
  R=$(echo "$S" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  ts=d.get('tracks',[])
  print('OK' if ts and all(t.get('duration',0)>0 for t in ts[:12]) else 'TOP-DIRTY')
except: print('ERR')")
  t "  top-12 durations: $Q" 'OK' "$R"
done
J=$(curl -s --max-time 25 "$BASE/api/ytm/search?q=Kesariya&limit=45" | python3 -c "
import json,sys
d=json.load(sys.stdin)
junk=[t for t in d.get('tracks',[]) if any(k in (t.get('title') or '') for k in ['Controversy','Modi is','textile','Podcast'])]
print('CLEAN' if not junk else 'JUNK')")
t "no podcast junk" 'CLEAN' "$J"

echo "== 3. SponsorBlock (ad-free engine) =="
t "segments for Shape of You" '"music_offtopic"' "$(curl -s --max-time 15 "$BASE/api/sponsorblock?id=JGwWNGJdvx8&dur=263")"
t "clean id → empty" '"segments":[]' "$(curl -s --max-time 15 "$BASE/api/sponsorblock?id=zzzznotreal1&dur=100")"
P=$(curl -s --max-time 15 "$BASE/api/sponsorblock?id=JGwWNGJdvx8&dur=263" | python3 -c "
import json,sys
d=json.load(sys.stdin)
segs=d.get('segments',[])
ok=all(s['end'] < 263-2 for s in segs) and all(s['end']-s['start']>=1.5 for s in segs)
print('PLAN-OK' if ok else 'BAD-PLAN')")
t "skip plan sane" 'PLAN-OK' "$P"

echo "== 4. Stream resolution (5 markets) =="
for PAIR in "Shape of You|JGwWNGJdvx8" "Blinding Lights|4NRXx6U8ABQ" "Bohemian Rhapsody|fJ9rUzIMcZQ" "Kesariya|BddP6PYo2gs" "Brown Munde|v82K3BZthDE"; do
  NAME="${PAIR%%|*}"; ID="${PAIR##*|}"
  t "resolve: $NAME" '200' "$(curl -s -I --max-time 40 "$BASE/api/stream?id=$ID&dur=200&title=T&artist=T" | head -1)"
done

echo "== 5. Proxy byte streaming (mobile) =="
R1=$(curl -s -o /tmp/fa.bin -w '%{http_code}:%{size_download}' --max-time 90 "$BASE/api/stream?id=BddP6PYo2gs&title=Kesariya&artist=Arijit%20Singh&dur=269&proxy=1")
CODE1=${R1%%:*}; SZ1=${R1##*:}
if [[ ("$CODE1" == "200" || "$CODE1" == "206") && "$SZ1" -gt 100000 ]]; then PASS=$((PASS+1)); RESULTS+=("PASS  proxy no-Range ($R1 bytes)");
else FAIL=$((FAIL+1)); RESULTS+=("FAIL  proxy no-Range → $R1"); fi
t "proxy Range head" '206' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -H 'Range: bytes=0-1023' "$BASE/api/stream?id=BddP6PYo2gs&title=K&artist=A&dur=269&proxy=1")"
t "proxy mid-seek" '206' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -H 'Range: bytes=500000-501023' "$BASE/api/stream?id=BddP6PYo2gs&title=K&artist=A&dur=269&proxy=1")"

echo "== 6. Download + fresh + cache =="
D=$(curl -s -o /tmp/fb.m4a -w '%{http_code}:%{size_download}' --max-time 90 "$BASE/api/download?id=BddP6PYo2gs&title=Kesariya&artist=Arijit%20Singh&dur=269")
DCODE=${D%%:*}; DSZ=${D##*:}
if [[ "$DCODE" == "200" && "$DSZ" -gt 100000 ]]; then PASS=$((PASS+1)); RESULTS+=("PASS  download ($DSZ bytes)");
else FAIL=$((FAIL+1)); RESULTS+=("FAIL  download → $D"); fi
FR=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$BASE/api/stream?id=BddP6PYo2gs&title=K&artist=A&dur=269&fresh=1")
if [[ "$FR" == "307" || "$FR" == "200" || "$FR" == "206" ]]; then PASS=$((PASS+1)); RESULTS+=("PASS  fresh=1 (redirect $FR)");
else FAIL=$((FAIL+1)); RESULTS+=("FAIL  fresh=1 → $FR"); fi
t "cached resolve" '200' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 40 "$BASE/api/stream?id=BddP6PYo2gs&title=K&artist=A&dur=269&head=1")"

echo; echo "=============== FINAL GAUNTLET RESULTS ==============="
printf '%s\n' "${RESULTS[@]}"
echo "PASS=$PASS FAIL=$FAIL"
