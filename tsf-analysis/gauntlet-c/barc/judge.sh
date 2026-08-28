#!/bin/bash
# BAR-C blind critic — randomizes pair order, asks VLM to ID the clone + craft scores
REF=/home/z/my-project/tsf-analysis/spotify-bar
OURS=/home/z/my-project/tsf-analysis/gauntlet-c/barc/ours
OUT=/home/z/my-project/tsf-analysis/gauntlet-c/barc/verdicts
declare -a PAIRS=(
  "d1-home|$REF/desktop-01-home-1440.png|$OURS/desktop-01-home.png"
  "d2-home-scrolled|$REF/desktop-05-home-scrolled-1440.png|$OURS/desktop-05-home-scrolled.png"
  "d3-playlist|$REF/desktop-02-playlist-1440.png|$OURS/desktop-02-playlist.png"
  "d4-browse|$REF/desktop-03-search-browse-1440.png|$OURS/desktop-03-search-browse.png"
  "m1-home|$REF/mobile-01-landing-390.png|$OURS/mobile-01-home.png"
  "m2-search|$REF/mobile-03-search-390.png|$OURS/mobile-03-search.png"
  "m3-results|$REF/mobile-04-search-results-390.png|$OURS/mobile-04-search-results.png"
  "m4-hero|$REF/mobile-05-playlist-hero-390.png|$OURS/mobile-05-playlist-hero.png"
  "m5-tracks|$REF/mobile-06-playlist-tracks-390.png|$OURS/mobile-06-playlist-tracks.png"
)
for entry in "${PAIRS[@]}"; do
  IFS='|' read -r name ref ours <<< "$entry"
  [ -f "$ref" ] || { echo "SKIP $name (no ref)"; continue; }
  # randomize order
  if (( RANDOM % 2 )); then IMG1="$ref"; IMG2="$ours"; MAP='{"image1":"spotify-ref","image2":"tsf-ours"}';
  else IMG1="$ours"; IMG2="$ref"; MAP='{"image1":"tsf-ours","image2":"spotify-ref"}'; fi
  echo "== $name (order: $MAP)"
  z-ai vision \
    -p "You are a strict, skeptical UI design critic. You see two screenshots (Image 1, Image 2) of dark-themed music streaming apps. Exactly one is Spotify's official product; the other is a third-party clone. Judge purely on visual craft; do not assume image order. Note one of them may show cookie banners or logged-out states - judge typography, spacing, color, proportions, component shapes, alignment. Reply with ONLY minified JSON, no prose: {\"spotify_is\":\"image1|image2\",\"confidence\":1-10,\"craft_image1\":1-10,\"craft_image2\":1-10,\"clone_giveaways\":[\"detail1\",\"detail2\",\"detail3\",\"detail4\",\"detail5\"]} where clone_giveaways lists the concrete visual details that reveal the clone and differ from Spotify craft (mention WHICH image has the flaw, e.g. 'image2: title only 52px vs 96px'). Exactly 5 giveaway items." \
    -i "$IMG1" -i "$IMG2" -o "$OUT/$name.json" 2>&1 | tail -1
  echo "{\"map\":$MAP}" > "$OUT/$name.map.json"
done
echo DONE
