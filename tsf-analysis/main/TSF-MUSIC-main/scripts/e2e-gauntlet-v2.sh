#!/bin/bash
# TSF FULL E2E GAUNTLET v2 — post Musify integration + search fix
BASE=http://localhost:3000
PASS=0; FAIL=0; declare -a RESULTS
t() {
  if [[ "$3" == *"$2"* ]]; then PASS=$((PASS+1)); RESULTS+=("PASS  $1");
  else FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1 → got: ${3:0:150}"); fi
}

echo "== Phase 1: Core =="
t "health" '"ok":true' "$(curl -s --max-time 10 $BASE/api/health)"
t "home page" '200' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 $BASE/)"

echo "== Phase 2: Search quality (5 markets + durations + no junk) =="
for Q in "Kesariya" "Shape of You" "Brown Munde" "Naatu Naatu" "Ilaiyaraaja hits" "Blinding Lights" "Bohemian Rhapsody"; do
  S=$(curl -s --max-time 25 "$BASE/api/ytm/search?q=$(echo $Q | sed 's/ /%20/g')&limit=8")
  t "search: $Q" '"videoId"' "$S"
  # duration completeness
  R=$(echo "$S" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  ts=d.get('tracks',[])
  print('OK' if ts and all(t.get('duration',0)>0 for t in ts) else 'INCOMPLETE')
except: print('ERR')")
  t "  durations: $Q" 'OK' "$R"
done
# junk filter
J=$(curl -s --max-time 25 "$BASE/api/ytm/search?q=Kesariya&limit=12" | python3 -c "
import json,sys
d=json.load(sys.stdin)
junk=[t for t in d.get('tracks',[]) if any(k in (t.get('title') or '') for k in ['Controversy','Modi','textile','Podcast'])]
print('CLEAN' if not junk else 'JUNK:'+str(len(junk)))")
t "no podcast junk in songs" 'CLEAN' "$J"

echo "== Phase 3: SponsorBlock (ad-free) =="
t "segments for Shape of You" '"music_offtopic"' "$(curl -s --max-time 15 "$BASE/api/sponsorblock?id=JGwWNGJdvx8&dur=263")"
t "clean id → empty" '"segments":[]' "$(curl -s --max-time 15 "$BASE/api/sponsorblock?id=zzzznotreal1&dur=100")"
# outro skip plan must not eat track end
P=$(curl -s --max-time 15 "$BASE/api/sponsorblock?id=JGwWNGJdvx8&dur=263" | python3 -c "
import json,sys
d=json.load(sys.stdin)
segs=d.get('segments',[])
ok=all(s['end'] < 263-2 for s in segs) and all(s['end']-s['start']>=1.5 for s in segs)
print('PLAN-OK' if ok else 'BAD-PLAN:'+json.dumps(segs))")
t "skip plan sane (no tail-eating)" 'PLAN-OK' "$P"

echo "== Phase 4: Stream resolution (HEAD, 5 markets) =="
for PAIR in "Shape of You|JGwWNGJdvx8" "Blinding Lights|4NRXx6U8ABQ" "Bohemian Rhapsody|fJ9rUzIMcZQ" "Kesariya|BddP6PYo2gs" "Brown Munde|v82K3BZthDE"; do
  NAME="${PAIR%%|*}"; ID="${PAIR##*|}"
  H=$(curl -s -I --max-time 40 "$BASE/api/stream?id=$ID&dur=200&title=T&artist=T")
  t "resolve: $NAME" '200' "$(echo "$H" | head -1)"
done

echo "== Phase 5: Proxy byte streaming (mobile path) =="
R1=$(curl -s -o /tmp/v2a.bin -w '%{http_code}:%{size_download}' --max-time 90 "$BASE/api/stream?id=BddP6PYo2gs&title=Kesariya&artist=Arijit%20Singh&dur=269&proxy=1")
CODE1=${R1%%:*}; SZ1=${R1##*:}
if [[ ("$CODE1" == "200" || "$CODE1" == "206") && "$SZ1" -gt 100000 ]]; then PASS=$((PASS+1)); RESULTS+=("PASS  proxy no-Range ($R1)");
else FAIL=$((FAIL+1)); RESULTS+=("FAIL  proxy no-Range → $R1"); fi
R2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -H 'Range: bytes=0-1023' "$BASE/api/stream?id=BddP6PYo2gs&title=K&artist=A&dur=269&proxy=1")
t "proxy Range head" '206' "$R2"
R3=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -H 'Range: bytes=500000-501023' "$BASE/api/stream?id=BddP6PYo2gs&title=K&artist=A&dur=269&proxy=1")
t "proxy Range mid-seek" '206' "$R3"

echo "== Phase 6: Download + fresh + cache =="
D=$(curl -s -o /tmp/v2b.m4a -w '%{http_code}:%{size_download}' --max-time 90 "$BASE/api/download?id=BddP6PYo2gs&title=Kesariya&artist=Arijit%20Singh&dur=269")
DCODE=${D%%:*}; DSZ=${D##*:}
if [[ "$DCODE" == "200" && "$DSZ" -gt 100000 ]]; then PASS=$((PASS+1)); RESULTS+=("PASS  download ($DSZ bytes)");
else FAIL=$((FAIL+1)); RESULTS+=("FAIL  download → $D"); fi
# fresh=1: 307 redirect to CDN is the designed desktop behaviour
FR=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$BASE/api/stream?id=BddP6PYo2gs&title=Kesariya&artist=Arijit%20Singh&dur=269&fresh=1")
if [[ "$FR" == "307" || "$FR" == "200" || "$FR" == "206" ]]; then PASS=$((PASS+1)); RESULTS+=("PASS  fresh=1 resolves (redirect $FR)");
else FAIL=$((FAIL+1)); RESULTS+=("FAIL  fresh=1 → $FR"); fi
C=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 40 "$BASE/api/stream?id=BddP6PYo2gs&title=K&artist=A&dur=269&head=1")
t "cached resolve" '200' "$C"

echo; echo "===================== GAUNTLET v2 RESULTS ====================="
printf '%s\n' "${RESULTS[@]}"
echo "PASS=$PASS FAIL=$FAIL"
