# TSF Music — Spotify-grade personal music streaming PWA

Single-user, dark-only, English music app. No login/sign-up. Spotify-like onboarding
asks your name, bio, music taste, favorite artists → AI home + all features
personalized around your picks. NO AI DJ voice — only AI playlists / mixes / radios.

## Stack

- **Next.js 16 App Router** + TypeScript + Tailwind 4 + shadcn/ui
- **Prisma + SQLite** for catalog, likes, history, playlists, AI provenance, cache
- **Zustand** stores for player + nav + library + preferences
- **Media Session API** for lock-screen/notification controls
- **OpenCode Zen** (`https://opencode.ai/zen/v1`, keyless, model `x-preview-f-free`)
  for AI Playlist Generator only — every other AI feature is deterministic and
  uses YouTube InnerTube metadata (so they work even if Zen is down)
- **YouTube InnerTube** (`music.youtube.com/youtubei/v1/*` via WEB_REMIX client)
  for metadata (search, artist pages, albums, radios, lyrics via LRCLIB)
- **6-layer stream resolver chain** for audio: server InnerTube iOS → ANDROID_VR →
  client-side browser resolver → Piped → Invidious → demo-tone fallback (audible
  on bot-blocked IPs, real InnerTube audio on clean IPs)

## Features

### AI Layer (Spotify-equivalent, no DJ voice)
1. **Discover Weekly** — 30-track weekly mixtape (Mon-anchored, 7d cache) mixing
   your favorite artists' radios + their related artists' radios
2. **Release Radar** — new releases from your favorite artists (Fri-anchored, 7d cache)
3. **Daylist** — time-of-day playlist (Rise&Shine / Focus Flow / Lunch Break /
   Energy Boost / Unwind / Wind Down), 6h bucket
4. **On Repeat** — your top-played tracks from last 30 days (weekly bucket)
5. **Daily Mixes** — up to 6 mixes, one per favorite artist (12h cache)
6. **Smart Radio** — single 50-track queue interleaving all your artists' radios
7. **Mood Hubs** — 10 moods (Chill / Focus / Workout / Sleep / Party / Energy /
   Sad / Happy / Romance / Throwback), each builds an instant 25-track playlist
8. **AI Playlist Generator** — type a vibe/mood prompt → Zen AI returns a JSON
   playlist spec → we resolve each song via InnerTube search → saved as a real
   Playlist (source='ai') in your library with AI provenance (AiPlaylist + AiSeedTrack)
9. **Smart Shuffle** — instead of just randomizing, sprinkles in AI recommendations
   (one per 3 queue tracks) drawn from your queue's seed radios + favorite artists
10. **Recommended Songs** — at the bottom of every playlist, get 12 AI recs seeded
    by your playlist's first/middle/last tracks; Plus button adds to playlist
11. **Personalized Home** — every shelf is derived from your onboarding selections
    (top artists, top tracks, more like, discography, "Because you like [genre]")

### Player
- Full-screen Now Playing (color-extracted blurred backdrop, big art, transport,
  seek bar, like, Lyrics toggle, Queue toggle, Smart Shuffle button, sleep timer
  5/10/15/30/60 min, PiP placeholder, volume)
- Synced karaoke-style lyrics (LRCLIB)
- Queue drawer (slide-out right) + in-now-playing queue panel
- Mini NowPlayingBar (3-zone Spotify layout)
- Media Session API (lock-screen metadata + transport)
- Crossfade store field (UI placeholder; not yet wired to <audio>)

### Library
- Liked Songs (purple gradient tile)
- Playlists (manual create + AI-generated, with proper track counts in sidebar)
- History tab (Recently played)

### Onboarding (no sign-up)
- 6-step Spotify-like wizard: Welcome → Name → Bio → Artists → Genres → Summary
- Artist picker: 48 curated artists across 8 genres, live InnerTube resolution
  for browseIds + thumbnails, sticky search bar, sticky counter (min 3 selected)
- All AI features are gated behind your onboarding selections

### Content safety filter (`lib/safety.ts`)
- Keyword denylist for sexual / explicit / drug / violence content
- Allow-override list for cultural items (Sex Pistols, Sexy Back, Kiss From a Rose)
- Applied at every lib/ytm boundary (search / home / artist / album / radio)
- AI Playlist Generator also runs prompts through safety check before Zen call

## Setup (local)

```bash
# 1. Install deps (Bun recommended — fastest; npm works too)
bun install        #  or: npm install

# 2. Run it — the database is created automatically on first start
bun run dev        #  or: npm run dev

# 3. Open http://localhost:3000 — first launch shows the onboarding wizard
```

That's the whole setup. `bun run dev` runs `prisma db push` first, which
creates `db/custom.db` and generates the Prisma client — no manual DB steps,
no environment variables to set, no API keys anywhere.

Node 20+ (or Bun 1.1+) is required. Works on macOS, Linux and Windows.

## How AI features actually work

The most common confusion: "Is everything actually AI?" Yes — but with two tiers:

**Tier A: Deterministic AI (works without LLMs):**
- Discover Weekly, Release Radar, Daylist, On Repeat, Daily Mixes, Smart Radio,
  Mood Hubs, Recommended Songs, Smart Shuffle
- All of these compose Spotify-equivalent playlists using:
  - your onboarding preferences (favorite artists + genres)
  - your listening history (On Repeat)
  - InnerTube radios (RDAMVM endpoint) seeded from favorite artists + their related
  - time-of-day + mood query templates
- They cache in `ApiCache` for 6h–7d (varies per feature)
- They don't need any LLM call at runtime, so they're instant and reliable

**Tier B: LLM-powered AI (uses OpenCode Zen):**
- AI Playlist Generator only
- Workflow: user prompt → Zen in JSON mode (model `x-preview-f-free`, fallback
  chain: `muse-spark-1.2-contributor-free → hy3-free → mimo-v2.5-free →
  nemotron-3-ultra-free → claude-sonnet-5 → gemini-3.x-flash`) →
  list of (query, title, artist, reason) → resolve each query via InnerTube search
  → save as Playlist + AiPlaylist + AiSeedTrack
- Even if Zen fails, falls back to deterministic expansion (search queries built
  from prompt + user's favorite artists)

## Audio streaming

The app talks to InnerTube's `next` endpoint to fetch ~50-track radios. For
**actual audio bytes**, there's a provider chain with full-length sources
FIRST:

1. **InnerTube VISIONOS / IOS / TVHTML5 / ANDROID_VR / IOS_MUSIC /
   ANDROID_MUSIC clients** — all queried in parallel, plus Piped and
   Invidious relays in the same race. The chain head is the **VISIONOS
   client** — yt-dlp's only default tokenless client as of 2026-08 (no PO
   Token needed), ported from the Musify project's yt-dlp-synced client
   configs. IOS runs the current 21.26.4 build; TVHTML5 covers restricted
   videos (`contentCheckOk`/`racyCheckOk` path); ANDROID_VR is a legacy
   long-shot (YouTube 403'd all its formats on 2026-08-17 but enforcement
   rolls back). On a normal home/residential IP (i.e. running the app
   locally) one of these answers in under a second with the **FULL-LENGTH
   official stream** (m4a/AAC, typically 128kbps, native seek + Range
   support; Opus/webm accepted as fallback). This is the primary path —
   international + Indian catalog alike.
2. **iTunes preview** (Apple Music catalog) — a real 30-second clip of the
   actual studio recording. Reached only when the whole YouTube chain was
   bot-blocked (datacenter / VPN IPs). Cached 2h.
3. **TSF Synth** — procedural full-length audio, effectively never reached
   on a clean IP (every catalog track has a videoId, so YouTube resolves it).

**Why the difference?** YouTube bot-walls the `player` API by IP reputation.
Datacenter/cloud IPs get `LOGIN_REQUIRED`; residential IPs get the stream.
There is no key or config that changes this — it's IP reputation, which is
why running the app locally gives you full-length everything.

**Byte fetching is UA-matched** (Musify-ported fix): googlevideo URLs
resolved by app-style clients are signed against the resolving client's
User-Agent, so the proxy/download routes forward the exact UA that resolved
the URL. Range-less full-file GETs always send `Range: bytes=0-` (googlevideo
403s range-less requests), with a `&range=a-b` query-param retry as the last
resort.

**Downloads** use the same chain: on a clean IP you get the full-length m4a
attachment; on blocked IPs the 30s real clip.

A quick way to see which provider served a track: `GET /api/health` shows
per-provider health (`innertube-*` blocked = your IP is bot-walled).

### Field-verified behaviour (residential-IP diagnostic, 2026-08)

- **`innertube-IOS` is the workhorse**: resolves full-length audio for
  international + Indian tracks alike (~500ms, HTTP 206, correct duration).
- **`innertube-VISIONOS` is the future-proof head** — yt-dlp's sole default
  tokenless client right now. If YouTube ever tightens IOS, this takes over
  automatically (it races in parallel on every resolution).
- The other clients (`ANDROID_VR`, `IOS_MUSIC`, `ANDROID_MUSIC`) answer
  `LOGIN_REQUIRED` on consumer IPs, and all public Piped/Invidious relays
  are currently dead (4xx/5xx). This is EXPECTED — a **circuit breaker** in
  `src/lib/ytm/stream.ts` automatically skips any provider that failed in
  the last 10 minutes (VISIONOS/IOS always stay in the race), cutting
  bot-check pressure and log noise.
- Resolved `googlevideo` URLs are **IP-bound** and carry their own signed
  `expire` epoch — cache TTL honours it (2-min safety margin), so a cached
  URL never outlives its signature.

### Skip non-music segments (SponsorBlock, "ad-free" playback)

Ported from Musify: on every track load the player asks
`GET /api/sponsorblock?id=<videoId>` for the community-curated non-music
segments of that upload (sponsor plugs, self-promos, like/subscribe
beggings, intros, outros, tagged non-music sections). When present, the
playhead hops straight over them — a music video with a 20s talking intro
plays like the clean radio edit. Most studio recordings have no segments
and are untouched. Segment data is cached 24h (empty) / 7 days (present);
failures degrade silently to no skipping. Toggle it in **Your Library →
Playback → Skip non-music segments** (default on; `localStorage`
`tsf-skip-segments`).

### Search quality

Search merges three InnerTube responses in parallel (unfiltered +
songs-filtered + videos-filtered) and re-orders songs-first (Spotify-style):
every song row carries a duration, music videos follow, and podcast/
episode/profile rows are filtered out of the songs list entirely.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Track shows `0:00` / won't play right after switching Wi-Fi ↔ hotspot / toggling VPN | Cached stream URL was signed for the old egress IP | Automatic: the player retries once with `?fresh=1` (bypasses cache). Manual: `npm run db:clear-cache`, reload the app |
| `Middleware is missing expected function export name` on another machine | A stray `package.json` (or `src/middleware.ts`) in a PARENT folder (e.g. your home dir) makes Next treat that folder as the workspace root | Already fixed by `turbopack.root: __dirname` in `next.config.ts`; ideally move the stray project out of the home directory |
| Turbopack dev crash (`unexpected Turbopack error` / CSS panic) | Tailwind v4 + Turbopack bug when the project path contains a SPACE (e.g. `Downloads/tsf-music 3`) | `npm run dev` already uses webpack. Prefer a space-free folder name; `npm run dev:turbo` opts back into Turbopack |
| `/api/health` shows `LOGIN_REQUIRED` for 3 of 4 innertube clients | Normal on residential IPs — bot checks apply per client | Nothing; IOS carries playback. If ALL providers fail you're on a flagged IP (VPN/datacenter) — the iTunes 30s preview takes over |
| `npm run db:clear-cache` errors "database not found" | DB was never created | Run `npm run dev` once first (auto-creates SQLite at `db/custom.db`) |
| `npm install` times out fetching `next-16.x.tgz` / `@prisma/client` on slow links | npm's 120s per-request cap | Use `bun install` (8s for 819 packages on a Mac) — `bun run dev` works identically |
| Search rows briefly show no duration (mostly YouTube-video results like live clips / reactions) | An InnerTube response variant omits duration for some video rows | Cosmetic only — the correct duration appears the moment the track loads (audio metadata). Songs always carry durations |
| `curl -I /api/stream?id=...` (HEAD) returns `200` with no `Location` | By design: HEAD never redirects; use `curl -s -D -` (GET) to see the `307` | — |

## File layout

```
src/
  app/
    api/
      ai/                  # ← ALL AI endpoints
        discover-weekly/   # 30-track weekly mixtape
        release-radar/     # new releases from favorites
        daylist/           # time-of-day playlist
        on-repeat/         # top-played from history
        mood-playlists/    # 10 mood hubs
        playlist-generator/ # Zen-powered prompt → playlist
        smart-shuffle/     # augment queue with AI recs
        recommended-songs/# per-playlist recs
        featured/          # lightweight metadata for all hubs
        home/             # personalized home shelves
        daily-mixes/       # per-artist mixes
        smart-radio/       # interleaved radios
      library/
        likes/             # POST: add/remove, GET: list
        playlists/         # POST: create/add/remove/rename; GET: list/detail
        history/           # POST: record play; GET: recently played
      onboarding/          # GET/POST profile; seed-artists endpoint
      stream/              # Range proxy w/ 6-layer chain; demo/ for fallback
      ytm/                 # search/home/album/artist/radio/lyrics InnerTube proxies
      health/              # provider health endpoint
    layout.tsx
    page.tsx               # renders OnboardingGate (which renders AppShell)
  components/
    ai/                    # ← AI Playlist Generator dialog
    onboarding/            # 6-step wizard + gate
    player/                # AudioEngine + NowPlayingBar + FullScreenNowPlaying
                           # + SyncedLyrics + QueuePanel + QueueDrawer
    shell/                 # AppShell + Sidebar + TopBar + MobileNav
    views/                 # HomeView + AiGeneratedView + SearchView +
                           # AlbumView + ArtistView + PlaylistView +
                           # LibraryView + LikedView
    ui/                    # shadcn primitives
    shared.tsx             # TrackRow + Shelf + AlbumCard + ArtistCard + dialogs
  lib/
    ai/zen.ts              # ← OpenCode Zen adapter
    ytm/                   # InnerTube client + parser + seed + stream chain
    safety.ts              # ← content safety filter
    db.ts                  # Prisma client singleton
    utils.ts               # cn + helpers
  store/
    player.ts              # ← Zustand player store + smart shuffle state
    nav.ts                 # view stack + browser history
    library.ts             # likes/playlists optimistic CRUD
    preferences.ts         # onboarding profile mirror
    audio.ts               # singleton audio handle
    engine-types.ts
prisma/
  schema.prisma            # Track/Artist/Album/Like/HistoryItem/Playlist/
                           # PlaylistTrack/Setting/ApiCache/StreamCache/
                           # ProviderHealth/AiPlaylist/AiSeedTrack
public/                    # PWA manifest + icons
```

## Known limitations

- **Audio on datacenter/VPN IPs**: YouTube bot-walls its player API by IP
  reputation. On cloud IPs the app falls back to real 30-second iTunes
  previews. On residential IPs (normal home internet — i.e. running the app
  locally) the full YouTube catalog plays **full-length**.
- **Lyrics coverage**: LRCLIB is community-maintained; some songs (esp. Hindi /
  filmi) have no synced lyrics and fall back to plain text or empty.
- **Some artist discography**: InnerTube occasionally returns empty for obscure
  artists; seed catalog fills in for the most common ones.
- **Single user**: No auth, no accounts. All preferences/history/playlists are
  stored locally in the same SQLite DB.

## Phase history

- **Phase 0**: env init, InnerTube reconnaissance, Prisma schema, lib/ytm/, API
  routes, stream chain, demo-tone fallback, PWA manifest
- **Phase 1**: Spotify-exact dark theme + globals.css, AppShell + Sidebar +
  TopBar + MobileNav, HomeView + SearchView + AlbumView + ArtistView + LibraryView
  + LikedView + PlaylistView, shared TrackRow/Shelf/cards, AudioEngine +
  NowPlayingBar + Media Session
- **Phase 2**: Spotify-style 6-step onboarding wizard (Welcome → Name → Bio →
  Artists → Genres → Summary), preferences store, AI Daily Mixes + Smart Radio +
  AI Home shelves (all derived from user's onboarding)
- **Phase 3**: FullScreenNowPlaying + SyncedLyrics + QueuePanel + QueueDrawer +
  Sleep timer + Crossfade field
- **Phase 3 AI features (THIS RELEASE)**: Discover Weekly + Release Radar +
  Daylist + On Repeat + Mood Hubs + AI Playlist Generator + Smart Shuffle +
  Recommended Songs + Featured endpoint + 3 critical bug fixes (Track FK silent
  failures, playlist endpoint videoId mapping, trackCount logic)

---

Made with the **gauntlet-loop** methodology — bar = real Spotify, no compression
across session restarts, builder+critic blind A/B until ours wins.
