# TSF-MUSIC — Deep Codebase Understanding (Worklog)

---
Task ID: 1
Agent: Z.ai Code (main orchestrator)
Task: Extract user-uploaded archives and deeply understand the complete TSF-MUSIC codebase A-to-Z.

Work Log:
- Located user uploads in /home/z/my-project/upload/: TSF-MUSIC-main.zip (2.7MB), tsf-music (3).zip (430KB), tsf-music-android-debug.zip (5MB)
- Extracted all three to /home/z/my-project/tsf-analysis/{main,web,android}/
- Read all root configs: package.json, next.config.ts, tailwind.config.ts, tsconfig, Caddyfile, capacitor.config.json, .env.example, components.json, eslint config
- Read all docs: README.md, MOBILE-PROGRESS.md, MOBILE-SOLUTION.md, QA-REPORT-2026-08-27.md, docs/full-length-audio-research.md
- Read prisma/schema.prisma (13 models), .github/workflows (ci.yml + android.yml), mobile-shell/index.html
- Launched 4 parallel Explore agents that read every source file (~150 files, ~15,000 LOC):
  - Agent A: all 30 API route files (~3,557 LOC)
  - Agent B: all 22 lib/engine files (~5,100 LOC) — ytm/, ai/, synth/
  - Agent C: all stores + player/shell components
  - Agent D: all views + onboarding + AI UI + docs
- Compared the 3 archives: src/ is IDENTICAL between TSF-MUSIC-main and tsf-music(3); main adds Capacitor deps + android/ native shell; android zip = app-debug.apk Capacitor WebView shell (10.9MB)

Stage Summary:
- Archive contents fully understood; complete deep-analysis below. Key artifacts: analysis lives at /home/z/my-project/tsf-analysis/. CRITICAL KNOWN BLOCKER: YouTube SABR migration degrades 100% of tracks to synth/preview in datacenter environments (QA-REPORT-2026-08-27).

---

# TSF-MUSIC — COMPLETE ARCHITECTURE REPORT

## 1. What this project is

**TSF Music** — a Spotify-grade, single-user, dark-only, personal music streaming app.
- **Server**: Next.js 16 (App Router, single route `/` — everything else is a client-side view stack), Prisma + SQLite, runs on a laptop/Mac/VPS.
- **Audio**: resolves + streams REAL full-length tracks via a ranked provider race (JioSaavn 320kbps → yt-dlp → InnerTube clients → Piped/Invidious relays → iTunes 30s preview → offline procedural synth).
- **AI**: natural-language playlist generator (SSE token-streaming, first track ≈1s, 24h prompt cache), Discover Weekly / Release Radar / Daylist / On Repeat / Daily Mixes / Smart Shuffle / Smart Radio / Mood stations.
- **Mobile**: same-origin byte-proxy streaming (`?proxy=1`) for WebView fragility + Capacitor Android shell (appId `com.tsf.music`) built by GitHub Actions; WebView's origin IS the server (`server.url` in capacitor.config.json, default `http://10.125.110.1:3000`, cleartext allowed).
- No auth, no ads, no accounts. Single Next.js page mount: `page.tsx` → `OnboardingGate` → `AppShell`.

## 2. Three archives compared

| Archive | Contents | Delta |
|---|---|---|
| TSF-MUSIC-main.zip | Full repo incl. android/ Capacitor shell + mobile-shell/ + assets | Canonical |
| tsf-music (3).zip | Same src/ byte-identical, NO android/, NO Capacitor deps | Earlier web-only snapshot |
| tsf-music-android-debug.zip | app-debug.apk (Capacitor WebView: classes.dex, native-bridge.js, capacitor.config.json) | Build artifact |

## 3. Tech stack

- Next.js 16.1.1 (App Router, webpack for dev, turbopack root pinned), React 19, TypeScript 5 (build errors ignored), Tailwind 4 (CSS-first @theme, hex tokens — NO oklch), shadcn/ui (new-york) full set, Zustand 5 (5 stores), framer-motion 12, Prisma 6 + SQLite, z-ai-web-dev-sdk (AI), des.js (JioSaavn URL decrypt), Capacitor 8.5.
- Dev: `bun run dev` = prisma db push + next dev -p 3000. Build: standalone output.
- package name is still "nextjs_tailwind_shadcn_ts" v0.2.1 (scaffold origin).

## 4. Data model (prisma/schema.prisma — 13 models)

- Catalog: **Track** (id=videoId, denormalized artist/album text, duration, thumbnail, bitrate, isExplicit), **Artist** (id=browseId), **Album** (id=browseId).
- User data (no auth): **Like** (@@unique trackId), **HistoryItem** (playedAt idx, msPlayed), **Playlist** (source: manual|ai|radio) + **PlaylistTrack** (position, @@unique [playlistId,trackId]), **Setting** (onboarding profile KV).
- Cache: **ApiCache** (generic JSON TTL cache), **StreamCache** (videoId @id — bare or `videoId::titleHash` for title-bound providers), **ProviderHealth** (circuit breaker state), **RelayInstance** (Piped/Invidious registry).
- AI: **AiPlaylist** (prompt→playlist) + **AiSeedTrack** (videoId+reason).

## 5. THE CORE: stream resolution chain (lib/ytm/stream.ts, 729 lines)

`resolveStream(videoId, {skipCache, durationSec, title, artist})` order:
1. Malformed id (VIDEO_ID_RE) → synth immediately.
2. In-flight dedup (`globalThis.__tsfResolveInflight`).
3. **Ranked cache**: all StreamCache rows for videoId (bare + `::titleHash`), rank FULL(3: jiosaavn|yt-dlp|innertube-*|piped-*|invidious-*) > PREVIEW(2: itunes-preview) > SYNTH(1), bitrate tiebreak; 500-entry memory LRU in front.
4. **Circuit breaker**: ProviderHealth rows failed <10min excluded; all-cooling → reset chain to [VISIONOS, IOS].
5. yt-dlp launched CONCURRENTLY (result warms cache in background); semaphore max 2 subprocesses, 25s cap, argv-array spawn, HLS rejected, 2-attempt client rotation (tv_embedded,mweb,web_safari).
6. **Wave 1 fail-fast race (4s cap)**: JioSaavn (only w/ title; DES-ECB key '38346591', _96→_320 upgrade after live 1-byte probe, 4 anti-masquerade gates: performers-only artist ≥0.5, language blocklist english/instrumental, Δdur ≤15s, title overlap ≥0.6; 7-day TTL) ∥ 6 InnerTube clients (VISIONOS tokenless head → IOS 21.26.4 → TVHTML5 → ANDROID_VR (dead since 2026-08-17) → IOS_MUSIC → ANDROID_MUSIC; 4s each; UA-signed URLs — proxy must replay client UA) ∥ Piped (4 instances, Promise.any, 1.5s) ∥ Invidious (3 instances).
7. yt-dlp fair wait 7s if wave 1 whiffed.
8. iTunes 30s preview (title gate 0.65, 300ms serialized queue, 2h TTL, bitrate 256000).
9. TSF Synth last resort (30min TTL so real providers re-probe).
- Full-length hit purges all preview/synth rows + upgrades Track.thumbnail from JioSaavn 500x500 art.
- googlevideo expiry: parse `expire`, clamp [now+30s, min(now+30min, (exp-120)*1000)].

### /api/stream route (258 lines)
- Params: id (regex-gated), url passthrough (host whitelist: googlevideo/youtube/ytimg/itunes/saavncdn/piped/invidious), head=1, fresh=1 (skip cache), proxy=1 (mobile).
- tsf-synth → inline WAV via synth renderer; demo-tone → forwarded legacy; real → **307 redirect (desktop)** or **byte-proxy (mobile)**: pipeUpstream sends resolving client's exact UA (googlevideo signs vs UA), always sends Range (defaults bytes=0-; googlevideo 403s range-less), 3min timeout, self-heal ladder 403/416 → bytes=0- → &range=a-b query param; stale-URL heal: purgeVideoId + fresh re-resolve + retry.
- Honesty headers: X-Stream-Provider / X-Stream-Bitrate / X-Stream-Art.

### InnerTube metadata layer (innertube.ts + clients.ts + parse.ts + index.ts)
- ytmFetch: 3-tier cache (memory 5-30min → in-flight dedup → ApiCache 24h), 2 retries (400ms/1.2s), 12s timeout.
- WEB_REMIX for metadata; search does TRIPLE parallel merge (unfiltered + songs + videos filters) to fix missing durations; songs-first ordering.
- parse.ts: 607 lines of path-agnostic JSON walkers (findAll/walk), junk filter (Episode/Podcast/Profile rows dropped), musicCardShelf handling.
- Lyrics: LRCLIB primary (8s timeouts) → InnerTube lyrics tab (24h cache) → empty offline.
- Offline seed fallback (seed.ts): 10 artists/26 tracks/5 albums so UI never blanks.

## 6. AI engine (lib/ai/*)

- **Provider chain**: (1) "fast" local Z AI gateway (OpenAI-compatible SSE; config from ./.z-ai-config → ~ → /etc; thinking disabled; JSON mode; HTTP failure marks probe 'dead' permanently for process); (2) keyless `https://opencode.ai/zen/v1` with HEDGED RACING: 3 models fired concurrently (nemotron-3-ultra-free, hy3-free, mimo-v2.5-free), 40ms arbiter polls, first content wins, losers aborted; reasoning_content fallback.
- **partial.ts**: incremental JSON extractor — emits title/description the moment strings close, each {q,r} seed the moment its brace closes; tolerant of fences/escapes/trailing commas; 512KB scan cap.
- **sanitize.ts**: strips LLM-leak patterns (provider/model identities NEVER reach client), filler phrases, fences.
- **cache.ts cachedJson**: stale-while-revalidate; empty builds NEVER cached (fixes "empty cached 4h" bug); refresh() hook re-derives greeting on serve.

### /api/ai/playlist-generator (552 lines, the flagship)
- POST {prompt, count 5-50 default 25} → SSE `phase|meta|track|done|error` events.
- Cache key `ai:plgen:v3:{djb2(prompt)}:{count}:{profileSig}` TTL 24h → replay ~300ms (still creates fresh Playlist row).
- Speed architecture: (a) ≤4 deterministic starter queries resolved immediately (real tracks ~1s); (b) TWO parallel LLM shards (head 48% w/ title+description, tail remainder; temp 0.75, 1800 tokens, 45s); (c) seeds resolve DURING token streaming via createExtractor.onDelta; (d) resolver pool concurrency 6; (e) intent gate ≥0.34 (retry truncated query, hard floor 0.25); (f) deterministic filler backfill ("{prompt} hits/mix", artist mixes, "{prompt} song N") if under-delivered.
- Ordered emission: pending map + nextEmit cursor + seen Set (cross-shard dedup).
- Persistence: incremental (Playlist on first track, Track upserts, AiPlaylist+AiSeedTrack at finalize); 24h payload cache.

### Other AI routes (TTLs)
- ai/home: personalized feed (self-invalidating key w/ profile sig, 4h, cachedJson SWR, greeting refresh).
- discover-weekly: 30 tracks, round-robin across favorite+related artist radios, **Monday-anchored bucket, 7d TTL**.
- release-radar: 25 tracks, new-releases shelves w/ per-artist search fallback, **Friday-anchored, 7d**.
- daylist: 6 time blocks (incl. 22-28h wrap), hourBucket=floor(h/6), 6h TTL, non-empty only.
- on-repeat: top-15 from HistoryItem 30d, 6h TTL, pure DB.
- daily-mixes: 6 mixes (one per favorite artist), 12h.
- recommended-songs: ≤3 seed radios parallel, 12 target, exclude set.
- smart-shuffle: 2-3 spread seeds, insert after every 3rd track, never before index 0.
- smart-radio: top-8 artist radios interleaved to 50.
- mood-playlists: 10 mood stations; ?mood= returns tracks, else metadata.
- featured: card metadata + peeking into sibling caches for real covers (no expiresAt check — intentional).
- Cross-route quirk: readProfile imported FROM onboarding route module; featured↔hub cache-key templates must stay byte-identical.

## 7. Synth engine (lib/synth/*) — deterministic procedural music

- arrangement.ts: buildPlan(videoId, dur) — FNV-1a seed → mulberry32 PRNG → 8 genre presets (bpm/scales/chords/drums/bass/arp/swing), song structure (intro4 → verse8/chorus8 → bridge6+chorus8 → outro), motifs, per-bar events (kick/snare/hat/clap, bass styles, pads, arps, lead w/ chorus +12 semitones, risers). Duration derived 138-278s if unknown; clamp 21-600.
- render.ts: 16-bit mono 44.1kHz WAV; EVERY instrument is a pure closed-form function of absolute sample index (4096 wavetable sine, deterministic noise) → any byte range renderable on demand; 192KB pull-based ReadableStream chunks (~15ms each); proper 206/Content-Range; abort stops rendering; X-Synth-Genre/Bpm headers.

## 8. Client architecture

- **Stores (Zustand)**: player.ts (325-line state machine: queue/queueIndex/originalQueue, shuffle w/ shuffleWithFirst, repeat off|all|one, prev>3s→restart rule, sleep timer, smartShuffle; window.__player debug handle), audio.ts (module singleton {audio}; seekTo imperative path), library.ts (likes Set optimistic w/ revert; playlists action-dispatch), nav.ts (View union stack + pushState/popstate), preferences.ts (server-mirrored Settings profile).
- **AudioEngine.tsx (462 lines, headless)**: owns the <audio>; store→engine one-way loop (player holds INTENT, engine EXECUTES); SponsorBlock skip on timeupdate (0.15s guard); resolve-then-play "HARDENED v2" (pendingPlayRef flush on loadedmetadata/canplay; AbortError deferred, NotAllowedError = real autoplay block); error codes 2/4 → one fresh=1 retry → auto-skip after 1.2s; HEAD preflight harvests X-Stream-* headers + warms cache; prefetch next 3 tracks (120ms stagger); MediaSession full wiring (artwork 96/256/512, positionState, seek handlers).
- streamModeParam(): touch devices (matchMedia hover:none/pointer:coarse) get &proxy=1.
- **Player UI**: NowPlayingBar (mobile compact 2px progress line; desktop 3-zone grid; keyboard: Space, Shift±arrows, arrows seek±5s, up/down vol±5%; scrub/commit protocol with effectiveDuration fix); FullScreenNowPlaying (drag="y" armed ONLY from top bar, closes at offset>110 or velocity>700; dual tsf-ambient blurred layers; sleep timer presets 5/10/15/30/60); QueuePanel (GripVertical visual only — no drag reorder); SyncedLyrics (LRCLIB-synced karaoke, center-lock autoscroll, 4s manual-scroll override, distance-based opacity, green glow on current line); SourceBadge (emerald=full/amber=30s preview/slate=synth — honest degradation).
- **Shell**: AppShell (h-dvh flex, sidebar 280px hidden<lg, view-enter remount animation per navigation), Sidebar (Liked purple tile, create playlist dialog, AI generator entry, eq-bar animation on playing playlist), TopBar (scroll-aware tsf-glass), MobileNav (3 tabs, safe-area).
- **Views**: HomeView (Quick Picks from history/fallback/shelves, Featured AI hubs w/ hover-prefetch, Daily Mixes, Moods grid, likes shelf), SearchView (350ms debounce, tab filters, recent localStorage max 10, offline synthetic results), LibraryView (playlists/history/playback tabs; playback = SponsorBlock toggle localStorage tsf-skip-segments + stream engine explainer), LikedView (pure client), PlaylistView (recommended-songs integration w/ exclude), AlbumView, ArtistView (immersive hero, top-5 toggle, about expand), AiGeneratedView (generic {id,title,tracks} contract — also serves moods).
- **Onboarding**: Gate (splash → flow or shell) → welcome/name/bio/artists(min 3)/genres(min 2 or skip, auto-inferred from artists)/summary; every step persists immediately (refresh-safe); seed-artists: 48 curated artists, 6s hard cap, synthetic fallback never blanks.
- **AiPlaylistGenerator.tsx**: SSE consumption over fetch reader (buffer on \n\n), 8 suggestion chips, 10/25/40 sizes, rotating hints 2.2s, auto-scroll, per-track reason lines, Stop/Make another/Open playlist.

## 9. Design system (globals.css)

- Spotify-exact hex: bg #121212, card #181818, popover #282828, primary #1ed760, destructive #e91429, elevated #1f1f1f, subdued #6a6a7a-ish, sidebar #000. Dark hard-coded (html.dark), body select-none.
- Font stack 'Figtree','Circular',-apple-system... (NOT bundled via next/font).
- Animation inventory: marquee, eq-bounce (4-bar EQ), card-play-btn/play-pop, view-enter (240ms fade+rise), now-playing-enter (320ms slide-up), heart-pop, ring-spin, tsf-skeleton shimmer, tsf-grain (SVG film grain), tsf-ambient (26s blurred art drift), tsf-breathe (5.2s pulse), tsf-rise stagger (40-240ms delays), tsf-glass, tsf-progress-fill, tsf-wave, tsf-press, motion tokens (--ease-emphasized/spring), prefers-reduced-motion kill-switch, Spotify-thin scrollbars, touch overrides (@media hover:none), focus-visible white outline.

## 10. CI/CD

- ci.yml: bun install frozen → prisma generate → tsc -p tsconfig.ci.json (src-only) → next build.
- android.yml: dispatch/push(android|mobile-shell|capacitor|assets)/v* tags → bake TSF_SERVER_URL into capacitor.config.json → cap sync → versionCode=run_number → optional keystore decode (ANDROID_KEYSTORE_BASE64) → JDK21 + SDK36 → assembleDebug+assembleRelease → artifacts + GitHub Release on tags. NO next build in APK path (WebView loads server at runtime).
- mobile-shell/index.html: static "Connecting to your TSF server…" splash (only seen if server unreachable).

## 11. QA state (QA-REPORT-2026-08-27) — CRITICAL

- ✅ Passed: bring-up, /api/health, search 8/8 <2s, proxy streams 8/8 w/ Range, download route, mobile nav plumbing.
- ❌ **BLOCKER #1: 100% tracks degraded** — YouTube **SABR migration** (2026-08-27): InnerTube returns LOGIN_REQUIRED or playabilityStatus OK with 23 adaptiveFormats but NO `f.url` (only serverAbrStreamingUrl); stream.ts filters on f.url → "no audio url". Piped/Invidious relays dead. Result: everything falls to iTunes preview/synth in datacenter envs. (Residential IPs still get full-length via InnerTube — hence "your Mac" architecture; JioSaavn works from datacenter for Indian catalog.)
- ⚠️ MAJOR #2: resolve latency 15-22s vs ≤3s target.
- Must-fix list: SABR/serverAbrStreamingUrl handling, latency, device checklist C1-C5.

## 12. Known quirks / improvement backlog (from deep read)

1. ANDROID_VR known-dead still in wave-1 list (burns a race slot each resolve until breaker trips).
2. AI gateway 'dead' state permanent per process (no time-based re-probe).
3. cacheLookup hardcodes mime audio/mp4 (cached webm rows mislabeled).
4. daylist cache key mixes UTC date + local hour; cached subtitle hour goes stale.
5. stream self-heal only fires when fromCache=true.
6. In-process maps can grow: synth planCache unbounded, demo pcmCache clear-all>256, iTunes/JioSaavn MEMs (3000/2000).
7. Dead/stub UI: crossfadeMs state unused, PiP button decorative, LikedView Search/Sort unwired, "More" buttons no-op, QueuePanel grip no drag, nav.tab param unused, ai view type has no case, TrackRow onRemove uses ListPlus icon (mismatch), Content-Disposition double-encoding in download.
8. Artwork component bypassed by several views (raw <img>).
9. LibraryView history uses raw <img>; removeFromPlaylist skips refresh.
10. History POST unthrottled; sleep timer interval only ticks while fullscreen open.
11. Fonts not bundled; package.json name still scaffold default.
12. No react-query despite dependency; no SWR — manual fetch + cancelled guards everywhere.
13. forward button permanently disabled (decorative).
14. Backdrop-filter / heavy blurs on mobile could cost perf; acceptable.

## 13. Suggested next-phase priorities (for future rounds)

- P0: SABR mitigation research (serverAbrStreamingUrl extraction, Musify youtube_explode_dart fork study) + drop ANDROID_VR from wave-1.
- P1: latency work (parallel-first resolve, pre-warm on search/hover), gateway dead-state re-probe timer.
- P2: wire dead UI (drag-reorder queue, More menus, crossfade), Artwork everywhere, bundled fonts.
- P3: port latest fixes into this sandbox project if user wants to develop here (src/ identical to main).

---
Task ID: 2
Agent: Z.ai Code (cron review round 1)
Task: Assess project status, browser QA, then improve styling + add features.

Work Log:
- Ported TSF-MUSIC from tsf-analysis/main/TSF-MUSIC-main/ into /home/z/my-project (src/, prisma/schema.prisma, public assets, next.config.ts, capacitor.config.json, mobile-shell/, tsconfig.ci.json)
- Installed missing dep des.js@1.1.0 (JioSaavn DES-ECB URL decryption); all other deps already present
- Ran bun run db:push — all 13 TSF tables created in SQLite; Prisma Client regenerated
- Added tsf-analysis/upload/mobile-shell to eslint ignores; disabled new react-hooks/* compiler-era rules to match original repo lint posture → lint clean (0 errors)
- Browser QA via agent-browser (1440x900): onboarding welcome → name "Alex" → bio → 3 artists (Taylor Swift/Ariana Grande/Ed Sheeran) → Pop+Electronic → summary → finish. ALL 6 steps work with server persistence.
- Verified personalized home: "Good morning, Alex" greeting, quick picks from history, "Made for Alex" hubs (Discover Weekly/Release Radar/Rise & Shine/On Repeat), Daily Mixes 1-3 with real art, moods grid
- CRITICAL FLOW VERIFIED: playing "Blank Space" → /api/stream 206 via byte proxy (proxy=1), provider = itunes-preview 256kbps (expected SABR degradation in datacenter — honest amber badge), HEAD preflight + 3-track prefetch working, SponsorBlock fetch OK, history recorded, auto-advance to next track works
- Stream cache warming verified: resolves dropped 2.2s → 6ms on repeat plays
- FLAGSHIP VERIFIED: AI playlist generator "late night coding session with dark synthwave energy" → CREATED IN 5.3S, 13 tracks with per-track reasons (Kavinsky, The Midnight, Perturbator), playlist persisted to sidebar as "AI Playlist"
- FEATURE ADDED 1: Queue drag-and-drop reorder — new reorderQueue(from,to) action in player store (playing track pinned), QueuePanel rewritten with @dnd-kit sortable (PointerSensor 6px + KeyboardSensor), drag handle wired to previously-dead GripVertical affordance. Browser-verified: dragged Blank Space above Shake It Off successfully.
- FEATURE ADDED 2: Keyboard shortcuts overlay (? key) — new ShortcutsOverlay component mounted in AppShell, Spotify-styled dialog with keycaps, two groups (Playback, Volume & Panels), Esc closes. Browser-verified.
- STYLING ADDED 3: FeaturedCard gradient covers — AI hub cards without built covers now render branded gradient tiles (linear-gradient from card.gradient + radial highlight + emoji) instead of gray ♪ placeholder. Browser-verified on Discover Weekly (purple ✨) and AI Playlist cards.

Stage Summary:
- TSF-MUSIC is now LIVE in the sandbox at /home/z/my-project: onboarding, personalized AI home, search (real InnerTube results), streaming (206 byte-proxy), AI playlist generator (z-ai fast gateway), library — all functional.
- QA screenshots: tsf-analysis/qa-01..07*.png (welcome, home, playing, AI playlist, shortcuts, queue before/after)
- Known limitation (unchanged): datacenter IP → InnerTube full-length blocked by SABR → iTunes 30s preview is the ceiling for international tracks here; JioSaavn full-length works for Indian catalog; synth fallback intact.
- Unresolved: SABR mitigation (P0 research), resolve latency 15-22s worst-case, remaining dead UI (More menus, PiP button, crossfade stub), Artwork component bypass in some views.
- Recommended next: wire remaining dead buttons (More menu → context actions), AddToPlaylist from fullscreen player, drag-reorder persistence polish; then SABR research spike (serverAbrStreamingUrl).
