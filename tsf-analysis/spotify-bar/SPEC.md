# SPOTIFY UI — FETCHABLE REFERENCE SPEC (Task 4-c)

Sources:
- LIVE: open.spotify.com logged-out web player, captured in-sandbox via agent-browser (390x844 + 1440x900), Encore CSS variables read from computed styles on 2026 run.
- LITERATURE: developer.spotify.com design guidelines, support.spotify.com (Now Playing / Play Queue / Sort and filter / Search / Lyrics), Mobbin, themeandcolor.com, 9to5Mac, Mashable, Spotify Community.

## 1. DESIGN TOKENS

### 1.1 Colors — LIVE-fetched Encore CSS variables (html.encore-dark-theme)
| Token | Value | Note |
|---|---|---|
| --background-base | #121212 | main bg |
| --background-elevated-base | #1f1f1f | cards/inputs (current Encore) |
| --background-elevated-highlight | #2a2a2a | elevated hover |
| --background-highlight | #1f1f1f | hover surface |
| --background-press | #000 | pressed |
| --text-base | #ffffff | primary text |
| --text-subdued | #b3b3b3 | secondary text / idle controls |
| --essential-base | #ffffff | icons |
| --text-bright-accent / --essential-bright-accent | #1ed760 | Spotify green (interactive) |
| Body computed color | rgb(179,179,179) = #b3b3b3 | |
| Play button (button-primary inner) | bg #1ed760, icon/label #000 | measured on live play buttons |
| buttonSecondary border | 1px solid #7c7c7c, text #fff | |

Literature-supplied brand values:
| Color | Hex | Use |
|---|---|---|
| Spotify Green (brand/logo) | #1DB954 | brand moments, logo |
| Bright green (interactive) | #1ED760 | play buttons, active states (live-confirmed) |
| Pressed green | #1AA34A | pressed state |
| Brand black | #191414 | logo background |
| Legacy elevated | #282828 | menus/NP bar in older spec & context menus |
| Extra grays seen in palettes | #212121, #535353 | player chrome, disabled |
| Destructive (TSF uses) | #e91429 | errors/logout |

### 1.2 Typography — LIVE-fetched
- Stack: `SpotifyMixUI, CircularSp-Arab, CircularSp-Hebr, CircularSp-Cyrl, CircularSp-Grek, CircularSp-Deva, "Helvetica Neue", helvetica, arial` (body 16px).
- Loaded weights: CircularSp 400/700/800; SpotifyMixUI 400/700; SpotifyMixUITitle 700/800 (+variable 100–1000); SpotifyMixMono 400.
- Circular Std (Lineto) official weights: Book(400)/Medium(500)/Bold(700)/Black(900). Spotify replaced Circular with Spotify Mix (variable) in 2024–25 web/app.
- Partner guideline (developer.spotify.com Fonts): default platform sans-serif → Helvetica Neue → Helvetica → Arial (Circular NOT licensed to partners).
- Measured sizes (live):
  - Home h1: 16px/700/#fff
  - Card title: 16px/400/#fff; card subtitle: 13px/400/#b3b3b3
  - listRowTitle (search "Top result"): 20px/700
  - Buttons: 13–16px/700, pill radius
  - Playlist/Album title mobile: 32px/800; desktop: 96px/800

### 1.3 Shape & spacing — LIVE-measured
| Element | Value |
|---|---|
| Card (album/artist tile) | 178×233 desktop incl. 12px padding; radius 6px |
| Artwork corner radius (official rule) | 4px small/medium devices, 8px large; never crop/overlay/blur artwork |
| Search input | bg #1f1f1f, radius 500px (pill), h 48, padding 12/0/12/48, placeholder "What do you want to play?" |
| listRow (search result row) | h 48, radius 6px, gap 8px 12px |
| Track row (tracklist-row) | h 56, grid gap 16px, padding 0 16px, radius 4px |
| Big green play button | 48×48, radius 9999px, bg #1ed760, icon #000 |
| Now Playing bar | h 84 (mobile web), 66 (desktop), full width, black; progress hit-area 12px |
| Desktop layout @1440×900 | panels bg #000 radius 8px, 8px outer margin + 8px gaps; sidebar panel w 280 (slider 280–420, measured 420 expanded), topbar h 60, main w 956, NP bar y 826 |
| Sidebar slider | min 280px (live resize slider reads 280) |

### 1.4 Live Home shelves (logged-out web)
Trending songs → Popular artists → Popular albums and singles → Popular radio → Featured Charts (each a card row/grid; "Show all" links; card 178×233).

### 1.5 Live search-results sections (query "taylor swift")
Top result → Songs → Featuring … → Artists → Albums → Playlists → Podcasts → Episodes → Profiles → Genres & Moods. Rows h48/r6; Top-result card title 20px/700.

## 2. MOBILE APP ANATOMY (literature: official support pages + press/community)

### 2.1 Bottom tab bar
- 3 tabs since 2018 redesign: **Home / Search / Your Library** (icon 24px + ~10px label, active #fff, inactive #b3b3b3, bar bg near-black, safe-area padded).
- 2024+ A/B: 4th "Create" tab appears in some accounts (not Premium). Premium tab is NOT part of standard nav.

### 2.2 Mini-player
- Bar sits directly above tab bar; album art ~40–48px + track title/artist (1–2 lines) + pause + next; hairline progress across top edge; tap (whole bar) expands to Now Playing; swipe down/gesture to dismiss; content continues playing.

### 2.3 Now Playing screen (full)
Vertical order: top row (chevron-down/minimize left, context ⋯ right; devices pill centered/top), large album art (~full-width minus 32px, shadow), below: title/artist row with +/save & ⋯, devices + heart/share row, progress slider with elapsed/remaining times 11–12px mono-ish, control row: shuffle → previous → play (green circle, largest) → next → repeat; then bottom row (queue, lyrics toggle, connect device). Shuffle/repeat active = green dot under icon. Repeat twice = repeat-one.

### 2.4 Lyrics
- Entry: NP screen scroll to "Lyrics" → tap for full screen; preview under art toggleable.
- Full screen: background = solid dominant color extracted from album art; synced lines ~24–28px/700, current line #fff, past/future dimmed; karaoke scroll; tap lines to seek; share highlights lines.

### 2.5 Queue
- Open: tap ⋯/queue icon at bottom of NP view (or notification "Open").
- Add: context menu "Add to queue" or swipe right on a track row.
- Reorder: press-and-hold + drag (handle). Remove: swipe left. Clear: ⋯ → Clear. "Next in queue" + "Next from: <playlist>" sections with divider.

### 2.6 Your Library
- Top: filter chips (Playlists / Artists / Albums / …, dynamic), search + grid/list toggle + sort icon in header row.
- Sort: Recents / Recently added / Alphabetical / By Creator. Pin: swipe right or long-press → Pin.
- Grid: 3 columns (since 2023; was 2). Downloaded/liked sub-filters.

### 2.7 Search
- Idle: recent searches list + "Browse all" colored genre tiles (2-col mobile, 3+ desktop).
- Active: results sections (Top result, Songs…), filter chips per type; "Lyrics match" badge for lyric searches; advanced tags year:/genre:/label:/track:/album:/artist:/tag:new.

### 2.8 Context menu (long-press track)
Typical order: ⋯ header w/ art; Add to playlist / Save; Add to queue; Go to song radio; Go to artist; Go to album; Share; report/quality extras. (Desktop order changed 2023: Add to playlist above Add to queue.)

## 3. FETCHABILITY MAP
- LIVE no-login: home, search, search-results, playlist pages, player bar chrome (controls disabled), Encore tokens, fonts, all web CSS measurements. (Album deep-link tested 404'd — dead ID; playlists fully render.)
- LOGIN-gated: playback audio, full NP interactions, lyrics screen, queue screen.
- NATIVE-APP-ONLY (literature-only): bottom tab bar, mini-player behaviors, NP screen, lyrics full screen, queue gestures, library chips/grid.

## 4. CAPTURED ARTIFACTS
Screenshots in /home/z/my-project/tsf-analysis/spotify-bar/ (12, verified distinct non-blank PNGs):
- @390x844: mobile-01-landing-390.png (logged-out home), mobile-03-search-390.png (Browse all), mobile-04-search-results-390.png ("taylor swift" results), mobile-05-album-390.png (404 evidence: dead album deep-link), mobile-05-playlist-hero-390.png (Today's Top Hits hero), mobile-06-playlist-tracks-390.png (tracklist scrolled), mobile-07-player-bar-390.png (mini NP bar)
- @1440x900: desktop-01-home-1440.png, desktop-05-home-scrolled-1440.png (shelves), desktop-02-playlist-1440.png (96px/800 title), desktop-03-search-browse-1440.png, desktop-04-player-area-1440.png
- Note: logged-out web home does NOT scroll vertically at 390px (main.scrollTop stays 0; shelves are horizontal carousels) — native app vertical Home shelf stack comes from literature.
Research data: /tmp/research-c/{search-results.json,page-reads.json,round2.json,round2b.json,round3.json,round4.json}; scripts mirrored in research-scripts/.

## 5. GAUNTLET BARS (candidates)
- BAR-A "SPOTIFY-LIVE-WEB-TOKENS" — fully fetchable live; assert computed styles on both reference & build (hex/radius/heights above).
- BAR-B "SPOTIFY-MOBILE-ANATOMY-SPEC" — literature-based checklist (2.1–2.8) with pass/fail + measured px on the build at 390×844.
- BAR-C "SCREENSHOT-DIFF-COMPOSITE" — the 11 reference PNGs vs build screenshots: token histogram + layout proportion overlay; web-reachable surfaces only.
