#!/bin/bash
# TSF Music — End-to-end gauntlet test
# Hits every important endpoint to verify the app is fully functional.
set -e

BASE="http://127.0.0.1:3000"

green() { echo -e "\033[32m$1\033[0m"; }
red()   { echo -e "\033[31m$1\033[0m"; }
yel()   { echo -e "\033[33m$1\033[0m"; }

PASS=0
FAIL=0
test_endpoint() {
  local name="$1"
  local url="$2"
  local want_code="${3:-200}"
  local extra="${4:-}"
  local out_code size
  # shellcheck disable=SC2086
  out_code=$(curl -s -o /tmp/gauntlet.out -w "%{http_code}" $extra "$url" 2>/dev/null | tr -d '\0')
  size=$(stat -c %s /tmp/gauntlet.out 2>/dev/null || echo 0)
  if [ "$out_code" = "$want_code" ]; then
    green "  ✓  $name  (HTTP $out_code, $size bytes)"
    PASS=$((PASS+1))
  else
    red "  ✗  $name  (got $out_code, expected $want_code; $size bytes)"
    FAIL=$((FAIL+1))
  fi
}

test_range() {
  local name="$1"
  local url="$2"
  local out_code size
  out_code=$(curl -s -o /tmp/gauntlet.out -w "%{http_code}" -H "range: bytes=0-1" "$url" 2>/dev/null | tr -d '\0')
  size=$(stat -c %s /tmp/gauntlet.out 2>/dev/null || echo 0)
  if [ "$out_code" = "206" ]; then
    green "  ✓  $name  (HTTP 206, $size bytes)"
    PASS=$((PASS+1))
  else
    red "  ✗  $name  (got $out_code, expected 206; $size bytes)"
    FAIL=$((FAIL+1))
  fi
}

echo "TSF Music — Gauntlet Test Suite"
echo "================================"
echo ""

# --- 1. Core health & onboarding ---
echo "## Core / onboarding"
test_endpoint "Health"        "$BASE/api/health"
test_endpoint "Onboarding"   "$BASE/api/onboarding"
test_endpoint "Seed artists"  "$BASE/api/onboarding/seed-artists"
echo ""

# --- 2. AI features ---
echo "## AI features"
test_endpoint "AI home"        "$BASE/api/ai/home"
test_endpoint "AI featured"    "$BASE/api/ai/featured"
test_endpoint "Discover weekly" "$BASE/api/ai/discover-weekly"
test_endpoint "Release radar"  "$BASE/api/ai/release-radar"
test_endpoint "Daily mixes"    "$BASE/api/ai/daily-mixes"
test_endpoint "On repeat"     "$BASE/api/ai/on-repeat"
test_endpoint "Daylist"       "$BASE/api/ai/daylist"
test_endpoint "Smart radio"   "$BASE/api/ai/smart-radio"
test_endpoint "Mood playlists (workout)" "$BASE/api/ai/mood-playlists?mood=workout"
echo ""

# --- 3. Library ---
echo "## Library"
test_endpoint "Likes"          "$BASE/api/library/likes"
test_endpoint "History"       "$BASE/api/library/history?limit=8"
test_endpoint "Playlists"      "$BASE/api/library/playlists"
echo ""

# --- 4. Streams (demo fallback path) ---
echo "## Streams (demo-tone path)"
test_endpoint "Demo stream (full)"  "$BASE/api/stream/demo?id=tsf001"
test_range    "Demo stream (range)"  "$BASE/api/stream/demo?id=tsf001"
test_endpoint "Stream HEAD preflight" "$BASE/api/stream?id=tsf001&head=1"
echo ""

# --- 5. Download ---
echo "## Download"
test_endpoint "Download endpoint" "$BASE/api/download?id=tsf001&title=test"
echo ""

# --- 6. Home page ---
echo "## Pages"
test_endpoint "Home page" "$BASE/"
echo ""

echo "================================"
if [ $FAIL -eq 0 ]; then
  green "ALL PASS — $PASS/$PASS"
else
  red "FAILED — $FAIL failed, $PASS passed"
fi
exit $FAIL
