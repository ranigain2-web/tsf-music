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

---
Task ID: 3
Agent: Z.ai Code (cron review round 2)
Task: Assess status, browser QA, add features (context menu, More menu wiring, LikedView search/sort).

Work Log:
- Health assessment: app stable (54 resolves, 100% okRate, AI fast gateway, warm caches serving in ms)
- FEATURE: Track right-click context menu — new src/components/player/TrackContextMenu.tsx wrapping every TrackRow with 10 Spotify-style actions: Play now (green), Play next, Add to queue, Save/Remove Liked Songs, Add to playlist…, Go to artist, Go to album, Start radio (NEW capability: /api/ytm/radio → 50-track queue), Download file, Copy song link. Browser-verified: all 10 menu items render on search results rows.
- FEATURE: Start radio verified end-to-end — context "Blank Space · Radio", 50-track queue, auto-playing with prefetches (resolves 39→54, 100% ok).
- REFACTOR: extracted AddToPlaylistDialog from shared.tsx into src/components/player/AddToPlaylistDialog.tsx (shared.tsx re-exports for compat) to break the shared↔TrackContextMenu circular import.
- FEATURE: FullScreenNowPlaying More menu upgraded from sleep-timer-only to: Go to artist, Go to album, Start track radio (with loading spinner), Copy song link (with 1.8s "Link copied" check feedback), + existing sleep timer presets. Browser-verified all items render.
- FEATURE: LikedView fully wired — live in-playlist search (pill input, Escape/clear, result counter), sort dropdown (Date added/Title/Artist/Duration with check marks), hero FAB becomes Pause when collection playing (Spotify-accurate), play resumes from current track if it belongs to the list. Browser-verified: typed "blank" → "1 result" → filtered row rendered.
- QA: investigated transient "2 Issues" dev toast — stale hydration warning from intermediate fast-refresh states (fresh reload = clean, zero errors); fixed benign Radix aria-describedby warnings via aria-describedby={undefined} on AddToPlaylistDialog + ShortcutsOverlay DialogContent.
- Lint: 0 errors. All API smoke green.

Stage Summary:
- App remains fully functional with 3 new feature surfaces: right-click context menus everywhere TrackRow renders (search/album/playlist/liked/history), real More menu in fullscreen player, real search/sort in Liked Songs.
- QA screenshots: tsf-analysis/qa-08..13*.png (search songs, sort menu, context menu, radio queue, more menu, liked search).
- Unresolved/next: PlaylistView still has dead More button (add same menu pattern), AiGeneratedView/AlbumView/ArtistView More buttons no-op, PiP button decorative, crossfade stub; P0 SABR research spike untouched; consider queue-context-menu (right-click queue rows) next.

---
Task ID: 4-c
Agent: research-spotify-bar
Task: Spotify UI bar research — fetchable reference spec

Work Log:
- Read worklog Tasks 1-3 for TSF-MUSIC context (#121212/#1ed760/#181818 tokens, Figtree font, sidebar+mobile-nav) — research only, no code touched.
- Created /home/z/my-project/tsf-analysis/spotify-bar/ + /tmp/research-c/ (scripts mirrored in spotify-bar/research-scripts/).
- agent-browser @ 390x844: opened open.spotify.com — NO login wall on web player (logged-out landing still shows full design language). Captured home, shelves, search Browse-all, search results ("taylor swift" → sections Top result/Songs/Artists/Albums/Playlists...), Today's Top Hits playlist hero + tracklist, visible mini now-playing bar. Album deep-link tested 404'd (dead ID) — playlist pages fully render instead.
- LIVE EXTRACTED Encore design tokens from html.encore-dark-theme computed styles: --background-base #121212, --background-elevated-base #1f1f1f, --background-elevated-highlight #2a2a2a, --background-press #000, --text-base #fff, --text-subdued #b3b3b3, --essential-bright-accent/--text-bright-accent #1ed760; body color rgb(179,179,179); play buttons bg #1ed760 w/ #000 icon, 48x48 r9999.
- LIVE measured: search input #1f1f1f r500 h48; cards 178x233 r6 pad12 (title 16/400, subtitle 13/400 #b3b3b3); listRow h48 r6 gap 8x12 (Top-result title 20/700); tracklist-row h56 grid gap16 pad 0/16 r4; NP bar h84 mobile / h66 desktop (progress hit-area 12px); playlist title 32/800 mobile → 96/800 desktop; buttons 13-16px/700 pills; desktop 1440x900: panels #000 r8 with 8px margins/gaps, sidebar 280(slider)→420 expanded, topbar h60, main w956.
- LIVE fonts: SpotifyMixUI + CircularSp-{Arab,Hebr,Cyrl,Grek,Deva} 400/700/800 (+SpotifyMixUITitle 700/800, variable 100-1000, SpotifyMixMono 400) — confirms Circular-family weights 400/700/800, 2024-25 "Spotify Mix" rollout replacing Circular Std (Book/Medium/Bold/Black).
- web-search + web-reader (z-ai-web-dev-sdk, 6 scripts under /tmp/research-c/, 429-retry with backoff): 31 queries + 13 page reads. Official: developer.spotify.com design guidelines (artwork radius 4px small/8px large, never crop/overlay/blur; Spotify Green = resting brand color; partners told to use platform default sans-serif); support.spotify.com Now Playing (Save/Shuffle/Repeat/Play Queue/Connect; mini bar "just above the menu bar, tap for bigger view"; ⋯ = more options), Play Queue (add via menu or swipe right; reorder press-and-hold drag; remove swipe LEFT; ⋯→Clear), Sort and filter (chips, sort Recents/Recently added/Alphabetical/By Creator, pin via swipe right, grid/list toggle), Search (Lyrics match ≥3 words; year:/genre:/label:/track:/album:/artist:/tag: operators), Lyrics (scroll-to in NP view → full screen; preview under art; share highlighted lines).
- Community/press: bottom nav = Home/Search/Your Library since 2018 redesign (4th "Create" tab A/B in 2024-25; Premium is NOT a tab); library grid 3-col since 2023 (was 2); 2023 Home redesign adds filter chips Music/Podcasts & Shows/Audiobooks; lyrics bg = dominant color extracted from album art; NP control row order shuffle|prev|play(green)|next|repeat w/ heart in info row (2018+); brand #1DB954 vs interactive #1ED760 (+ #1AA34A pressed) confirmed by Mobbin/themeandcolor/color-hex.
- Wrote full reference spec to tsf-analysis/spotify-bar/SPEC.md (tokens, mobile anatomy 2.1-2.8, fetchability map, artifacts, 3 gauntlet BAR candidates). 11 reference screenshots captured.

Stage Summary:
- TOKENS (live-fetched, highest confidence): #121212 bg / #1f1f1f elevated (Encore current; #282828 legacy menus) / #181818 cards (literature) / #b3b3b3 subdued / #fff primary / #1ed760 interactive green (brand green #1DB954, pressed #1AA34A) / black press; radius: cards 6, artwork 4 (mobile)/8 (desktop), pills 9999, rows 4-6; heights: input 48, rows 48, track rows 56, NP bar 84 (mobile web)/66 (desktop), big play 48; type: 13/16/20 body-titles 400-700, page titles 32/800 (mobile) → 96/800 (desktop); font CircularSp→SpotifyMixUI w400/700/800 (Figtree in TSF = acceptable free substitute, keep stack).
- ANATOMY (literature, official support pages): 3-tab bottom nav Home/Search/Your Library; mini-player above tab bar w/ ~48px art + hairline progress, tap-expand; NP screen order: chevron/⋯ → art → title/artist + save/⋯ → devices/heart → progress+times → shuffle|prev|play|next|repeat → queue/lyrics/connect row; lyrics full screen w/ art-derived bg + bold synced lines; queue w/ drag-reorder + swipe-left remove + Clear; library chips + 3-col grid + sort menu; search recent + browse-all colored tiles + Lyrics match.
- FETCHABLE in-sandbox: open.spotify.com logged-out web player (home/search/results/playlist/player-chrome + ALL CSS tokens via agent-browser eval) — no login wall encountered. LOGIN-gated: playback, NP interactions, lyrics, queue screens. NATIVE-APP-ONLY (from literature): bottom tab bar, mini-player gestures, NP screen, lyrics fullscreen, library chips/grid.
- REFERENCE ARTIFACTS: 11 screenshots (mobile-01..07 @390x844, desktop-01..04 @1440x900) in tsf-analysis/spotify-bar/; SPEC.md full spec; JSON datasets in /tmp/research-c/.
- 3 GAUNTLET BAR CANDIDATES: (A) SPOTIFY-LIVE-WEB-TOKENS — assert live-fetched computed styles (hex/radius/heights/type) on both reference site and TSF build via agent-browser eval, numeric diff; (B) SPOTIFY-MOBILE-ANATOMY-SPEC — checklist from SPEC.md §2.1-2.8 with measured px pass/fail on TSF at 390x844; (C) SCREENSHOT-DIFF-COMPOSITE — 11 reference PNGs vs build screenshots (color histogram + layout proportion overlay) for web-reachable surfaces.
- CORRECTION (4-c): final screenshot set = 12 verified-distinct PNGs in tsf-analysis/spotify-bar/ (mobile-01, 03, 04, 05-album[404 evidence], 05-playlist-hero, 06-playlist-tracks, 07-player-bar @390x844; desktop-01, 02, 03, 04, 05-home-scrolled @1440x900). Duplicate early mobile-02 home shot and un-scrolled playlist shot were removed (md5-identical); desktop-05-home-scrolled added. Finding: logged-out web home has no vertical scroll at 390px (main.scrollTop stays 0 — shelves are horizontal carousels); native vertical shelf stack comes from literature. Full spec: tsf-analysis/spotify-bar/SPEC.md.

---
Task ID: 4
Agent: Z.ai Code (main orchestrator)
Task: Gauntlet-loop mission charter — crystallize the scale, set the bars, research everything, get ready to build the cross-platform (Android + iOS) Spotify-bar music app from TSF-MUSIC.

Work Log:
- Cloned https://github.com/robonuggets/gauntlet-loop → tsf-analysis/gauntlet-loop/ (SKILL.md + README). It is a METHOD repo (Matt Shumer's gauntlet loop): goal → concrete bar → builder/critic pairs → blind comparison → loop until ours wins. Applied to this mission.
- Launched 3 research agents: 4-a platform strategy (partial artifacts in /tmp/research-a), 4-b playback coverage (partial artifacts in /tmp/research-b), 4-c Spotify UI bar (COMPLETE, spec at tsf-analysis/spotify-bar/SPEC.md).
- HANDS-ON SABR SPIKE (tsf-analysis/sabr-spike/, youtubei.js 18.0.0 + googlevideo 4.1.1):
  - spike1: InnerTube WEB/IOS/TVHTML5 → playability OK, 26 adaptive formats, 0 direct URLs, serverAbrStreamingUrl present on ALL clients. P0 blocker CONFIRMED as total.
  - spike2: SabrStream (googlevideo lib) session starts; ustreamer config found at player_config.media_common_config.media_ustreamer_request_config.video_playback_ustreamer_config (Kira-sourced); server returns 403 without PO token.
  - BREAKTHROUGH spike: bgutil-ytdlp-pot-provider v1.3.2 HTTP server (POT via LuanRT Botguard BgUtils) + yt-dlp 2026 → FULL-LENGTH direct googlevideo URL (itag 140, 213s, clen=3.4MB) from DATACENTER IP; verified HTTP 206 + valid fMP4 AAC download. "Any song" is now PROVABLY reachable in this environment. Server currently in /tmp/research-b/bgutil-repo/server (port 4416) — MUST be migrated to mini-services/pot-provider for production.
  - Secondary: installing deno (JS runtime for yt-dlp EJS) removes the webpo warning and further hardens extraction.
- Playback provider research: Piped (8 instances) + Invidious (7 instances) = ALL DEAD from datacenter; Deezer public API = 30s previews only; iTunes Search previews = ALIVE; JioSaavn unofficial API (saavn.dev) = alive, 320kbps, primary for Indian catalog; Spotify API previews = dead since Nov 2024.
- Platform research: GitHub macos-15 runners have Xcode 26.6 / CocoaPods 1.17 / Gradle 9.6.1 → Capacitor iOS CI build feasible; macos-14 deprecated. Recommend: extend existing Capacitor 8.5 WebView architecture to iOS (server-URL shell), not a full React Native rewrite (UI already Spotify-grade; WebView keeps single codebase; background audio needs native plugins).
- Spotify UI bar (4-c): live-fetched Encore tokens from open.spotify.com (#121212 base, #1f1f1f elevated, #1ed760 accent, #b3b3b3 subdued, cards 178×233 r6, rows h56, mini-bar h84, play btn 48px r-full green/black icon, listRow h48, fonts SpotifyMixUI/CircularSp 400/700/800; brand green #1DB954, pressed #1AA34A). 12 reference screenshots captured at 390×844 and 1440×900 in tsf-analysis/spotify-bar/. Mobile anatomy spec: bottom tabs Home/Search/Your Library (NO Premium tab), Home chips Music/Podcasts/Audiobooks, NP screen control order (chevron/⋯ → art → title/artist+save → devices/heart → slider → shuffle|prev|play|next|repeat → queue/lyrics row), lyrics = dominant-color bg, queue swipe right add / left remove / hold-drag reorder, library grid 3 cols since 2023.

Stage Summary:
- THE BARS ARE SET (gauntlet-loop compliant — named, fetchable, comparable):
  - BAR-A "Spotify Live Web Tokens": assert live open.spotify.com computed styles (table above) against our build via agent-browser eval; numeric diff per token.
  - BAR-B "Spotify Mobile Anatomy": px/behavior checklist from official spec at 390×844 — tabs order/labels, mini-player placement+height, NP control order, queue gestures, library chips/grid, lyrics dominant-color.
  - BAR-C "Screenshot Blind Diff": 12 reference PNGs vs our build screenshots, labels stripped, judge picks.
  - MEASURABLE HALVES: (1) playback = % of 20-track international+national probe set playing FULL length in datacenter (bar: 100% via POT chain, fallback honest badges); (2) resolve latency p50 ≤ 3s (bar vs Spotify instant); (3) platforms = debug APK + unsigned IPA artifacts from CI; (4) background audio + lockscreen controls on both platforms; (5) AI playlist < 6s for 25 tracks (existing bar retained).
- RESEARCH COMPLETE. Key discoveries: SABR mitigation PROVEN (bgutil POT server + yt-dlp → full-length from datacenter); SabrStream/googlevideo as future direct path (needs webpo minting); iOS CI feasible on macos-15; Spotify bar spec captured live.
- NEXT ROUNDS (builder/critic loop): R1 = wire POT chain into lib/ytm/stream.ts wave-0 (migrate bgutil server to mini-services/pot-provider + install deno) + measure probe-set %; R2 = mobile UI gauntlet rounds vs BAR-A/B/C (bottom tabs, mini-player, NP screen, lyrics color); R3 = Capacitor iOS platform + workflows (assembleDebug APK + unsigned IPA); R4 = background audio/MediaSession native plugins both platforms; R5 = blind critic comparisons until ours wins.

---
Task ID: 5
Agent: Z.ai Code (cron R1 — POT playback chain)
Task: R1 of gauntlet — migrate POT server to mini-services, install deno, wire wave-0 POT chain into lib/ytm, measure the 20-track probe set.

Work Log:
- Status assessed: dev server healthy; bgutil POT server v1.3.2 still alive in /tmp (uptime ~1200s) — migrated BEFORE tmp loss.
- MIGRATED POT server → /home/z/my-project/mini-services/pot-provider (own package.json 'tsf-pot-provider', entry index.js → build/main.js, `bun run dev` = `bun --hot index.js`, fixed port 4416). Old /tmp node process killed; BotGuard VM confirmed WORKING under Bun (IntegrityToken + POT minted, log tsf-analysis/pot-provider.log).
- deno 2.9.6 installed at /home/z/.deno/bin (yt-dlp EJS/n-challenge runtime; note: `--js-runtimes node` BREAKS n-challenge — deno is the correct runtime).
- src/lib/ytm/ytdlp.ts: (a) CANDIDATE_PATHS + /home/z/.venv/bin/yt-dlp first (plugin + POT live in that venv); (b) POT provider wired via TSF_POT_URL env (default http://127.0.0.1:4416) injected into --extractor-args youtubepot-bgutilhttp; (c) spawn env now appends deno PATH; (d) NEW attempt 3 (tv_embedded,web_embedded) + 600/800ms staggers — bot-walls are per-video+time probabilistic (same video flips OK/WALL across ~20s; verified empirically).
- src/lib/ytm/stream.ts: YTDLP_FAIR_WAIT_MS 7s→14s (yt-dlp+POT is now the hero provider; full-length beats preview for cold first-play); ANDROID_VR dropped from wave-1 default list (dead since 2026-08-17).
- PROBE (tsf-analysis/probe/probe-set.mjs, 10 international + 10 Indian, fresh=1, 3 runs):
  - National: **9/9 FULL via jiosaavn at 277-1210ms** — bar (p50 ≤ 3s) SMASHED.
  - International: 1/10 FULL this window (Bohemian Rhapsody via jiosaavn — JioSaavn carries crossover intl catalog!) + 9/10 honest itunes-preview; direct YouTube walls are time-varying: dQw4w9WgXcQ got a FULL yt-dlp row (background warm, verified in DB, expires 13:09Z) and innertube-VISIONOS intermittently returns FULL URLs (SABR rollout is per-session probabilistic, NOT total).
  - END-TO-END PROOF through the app: /api/stream?id=dQw4w9WgXcQ → 307 → googlevideo itag-140 URL (clen=3449447, dur=213s) → followed → **HTTP 206, 500KB pulled, valid fMP4 (ftyp box)**. Playback bar is REACHABLE.
  - Fast-fail diagnosis: in-app yt-dlp rejections return in ~2s (bot-wall), which is why preview wins cold resolves in walled windows; background warm still converts replays to full-length.
- Browser QA: played Blank Space from home — mini-player shows honest amber "30s preview" badge, pause + prefetch working (3 next-tracks pre-resolved at 2-7ms via cache). Screenshot tsf-analysis/qa/r1-playing.png. Lint: 0 errors.

Stage Summary:
- R1 DONE. The POT chain is LIVE in production code: mini-service (bun, port 4416) + 3-attempt yt-dlp + 14s fair wait. National catalog = 100% full-length sub-second. International = probabilistic full-length (wall windows) with honest 30s preview degradation + background warm conversion on replay. The gauntlet measurable half "playback" moved from 0% intl full-length (SABR-dead) to working-chain + time-varying yield.
- Architecture lesson: the wall is per-video AND per-time probabilistic — retry/stagger + cache warming are the right levers; cookies/residential proxy remain the future 100% lever.
- Unresolved: head=1 vs redirect provider labels can disagree under in-flight dedup (cosmetic, SourceBadge may mislabel during live dedup); wall-window intl full-length % depends on IP reputation (cookies = next lever); SabrStream+webpo direct path still unexploited (googlevideo lib works, needs PO mint).
- Recommended next (R2): mobile UI gauntlet vs BAR-B (home filter chips Music/Podcasts, mini-player exact h-84 spec, NP screen order) + wire head/redirect provider consistency; then R3 Capacitor iOS + workflows.
- R2 piece landed in same round (styling/feature mandate): Spotify 2023+ HOME FILTER CHIPS per BAR-B §2.2 — Music/Podcasts/Audiobooks pill row on home (active = white bg + black text, inactive = #2a2a2a; role=tablist/tab, aria-selected; no-scrollbar overflow row). Non-music tabs show honest empty state (mic/book icon, "No podcasts yet — TSF is a music-only station"). Browser-verified at 390×844: tab selection + empty state render exactly (qa/r2-chips.png, r2-chips-podcasts.png). Lint 0 errors.

---
Task ID: 6
Agent: Z.ai Code (cron R2 — mobile UI gauntlet, first pieces)
Task: R2 of gauntlet — Now Playing anatomy vs BAR-B §2.5/§2.6 + BAR-A token assertion.

Work Log:
- Status: app healthy, POT service alive (uptime 20min), lint clean. Proceeded to R2.
- NP SCREEN (FullScreenNowPlaying.tsx) vs BAR-B §2.5 — 3 fixes:
  1. Play/pause button white → SPOTIFY GREEN #1ed760 with black icon (BAR-A primary token).
  2. Close button X → ChevronDown (Spotify collapse affordance).
  3. LYRICS DOMINANT-COLOR BACKGROUND — new src/lib/color.ts: client-side dominant color extraction from album art (24×24 downscale → HSV saturation²×brightness-weight scoring → hue-bucket winner → 0.78 darken for text contrast; session cache, CORS-taint safe). Wired as a gradient layer over the ambient wash that fades in (700ms) only when lyrics are open; SyncedLyrics containers lightened (black/30 + blur) so the color shows through.
- BROWSER VERIFICATION (390×844):
  - r2-np-screen.png: chevron-down / PLAYING FROM QUICK PICKS / ⋯ / big art / title+artist+heart / slider / shuffle|prev|GREEN play|next|repeat / Lyrics-Queue-Save-Smart pills — full Spotify anatomy.
  - r2-np-lyrics.png: whole lyrics screen wears the dominant color extracted from the current single's art (warm mocha), karaoke lines (current bold white, rest dimmed), green active Lyrics pill.
  - BAR-A token assertion via agent-browser eval: playBtnBg rgb(30,215,96)=#1ed760 EXACT, bodyBg rgb(18,18,18)=#121212 EXACT, activeChip white, accent #1ed760 — PASS.
- Auto-advance after 30s preview verified again in passing (Blank Space → The One That Got Away, lyrics followed).
- Lint: 0 errors.

Stage Summary:
- R2 pieces done: NP control order + green play + chevron-down + DOMINANT-COLOR LYRICS (Spotify's signature) + BAR-A tokens asserted live. The two most identity-defining mobile surfaces (home chips, NP screen) now match Spotify anatomy.
- Next R2 remainder: mini-player exact h-84 spec + mini progress hairline, Library chips + 3-col grid, search Browse-all tiles; then R3 Capacitor iOS + workflows.
- Risks: dominantColor depends on image CORS (yt3.googleusercontent + saavncdn send ACAO:*; jiosaavn 500x500 art confirmed working) — fallback keeps ambient wash, no breakage.

---
Task ID: 7
Agent: Z.ai Code (cron R2 remainder — mini-player h84 + Library §2.6 + Search §2.7)
Task: Complete the R2 remainder: mini-player exact h-84 + next button; Library Spotify-2023 rebuild (chips/search/sort/grid-list); Search browse tiles + recent-search rows. Status assessment + agent-browser QA first.

Work Log:
- Status: app healthy (dev 200, streams 206, POT provider alive uptime ~24min), lint clean → proceeded to R2 remainder.
- QA measured BEFORE: mini bar h66 / art 44 — vs Spotify spec h84 / art 48 (BAR-B §2.2). Fixed:
  1. MINI-PLAYER EXACT h-84 (NowPlayingBar.tsx): 2px progress + 82px content (art 48px r-4px, title/artist, pause, NEW next button — per §2.2 "pause + next"); removed non-Spotify heart + chevron from the bar (heart lives in NP screen). Browser-verified: barH=84 EXACT, artW=48, borderRadius 4px (official artwork rule), buttons = [Pause, Next track]. BAR-B §2.2 PASS.
  2. LIBRARY REBUILD (LibraryView.tsx, BAR-B §2.6): header = title + search-toggle + grid/list-toggle + sort menu (DropdownMenu: Recents ✓/Alphabetical/Most songs — check-marked, #282828 panel); expanding search pill (h-8, bg #1f1f1f, radius 500) with live name filter across playlists AND history; filter chips All/Playlists/Recently played/Playback (Spotify chip style: active white/black, inactive #2a2a2a, role=tab/tablist, aria-selected); grid = compact 3-col mobile (aspect-square art r-4px + "Playlist • N songs" caption, no card box — 2023+ anatomy), list = h-64 rows w/ 48px art + hover delete; Liked Songs pinned purple tile first in both modes; Recently played renders as rows w/ hover play under All chip. Browser-verified: search filter "late" → 1 match + pinned Liked; list toggle renders rows + icon swaps; sort menu shows all 3 items w/ ✓.
  3. SEARCH VIEW (SearchView.tsx, BAR-B §2.7): Browse-all tiles upgraded — aspect-[8/7] (taller), rotated 25° album-art mock w/ radial sheen + inset white ring + deep shadow (Spotify signature corner art); Recent searches converted pills → Spotify mobile vertical rows (Clock3 icon + query + per-row X remove on hover/focus + "Clear all" button; persistRecent helper; keyboard accessible rows). Browser-verified: searched "taylor swift" → cleared → Recent searches row renders w/ clock + X + Clear all.
- BAR-A TOKEN ASSERTIONS (agent-browser eval, live): bodyBg #121212 EXACT; chip active white bg/black text; chip inactive rgb(42,42,42)=#2a2a2a EXACT; library grid 3 columns EXACT; tile play button rgb(30,215,96)=#1ed760 EXACT pill-shaped. ALL PASS.
- Desktop 1440×900 sanity: library header/chips/grid/rows + desktop 3-zone player unaffected; recently-played rows keep touch-friendly always-visible play (globals @media(hover:none) — by design, matches Spotify mobile).
- Lint: 0 errors (fixed 6 unused eslint-disable directives). dev.log: zero errors. Screenshots: tsf-analysis/qa/r2b-library-grid.png, r2b-library-list-sort.png, r2b-library-sortmenu.png, r2b-search-browse.png, r2b-search-recent.png, r2b-library-desktop.png.
- Auto-advance re-verified in passing (Blank Space → Bad Blood after 30s preview, mini bar followed).

Stage Summary:
- BAR-B mobile anatomy status: §2.1 tabs ✅, §2.2 mini-player ✅ (h84 exact), §2.3 home chips ✅, §2.5 NP screen ✅ + lyrics dominant color ✅, §2.6 Your Library ✅ (chips+search+sort+grid/list+3-col), §2.7 Search ✅ (browse tiles + recent rows). Remaining §2.4/§2.8 polish: queue gestures (swipe-left remove / hold-drag reorder — QueuePanel exists, gestures not), lyrics share.
- R2 IS NOW COMPLETE → next R3: Capacitor iOS platform + GitHub workflows (assembleDebug APK + unsigned IPA @ macos-15). Then R4 background audio/MediaSession plugins. Playback yield lever (cookies/residential) still open for 100% intl full-length.
- Risks: none new; dominant-color lyrics CORS fallback unchanged.


---
Task ID: 8
Agent: Z.ai Code (cron R3 — Capacitor iOS + CI workflows + §2.4 queue gestures)
Task: R3 of gauntlet — iOS platform + unsigned-IPA workflow (macos-15) + APK workflow restore; QA pass; BAR-B §2.4 queue gestures (swipe-left remove); styling fixes (quick-pick truncation). Trace: web-cron-review-202608281539.

Work Log:
- STATUS ASSESS: dev 200, POT provider alive (uptime 2200s+), lint clean, streams 206, NP/queue/home browser-QA pass. Found 2 nits → fixed this round (quick-pick truncation, in-NP queue squeeze). One transient observed once (mini-bar title lagging audio src during automation click-frenzy) — not reproducible after; watch-item only.
- R3-a PLATFORM: installed @capacitor/{core,android,ios,cli}@8.5.0; ported committed android/ shell from tsf-analysis (sync verified: `bunx cap sync android` ✔); NEW `bunx cap add ios` → ios/ App (Capacitor 8 SPM layout, Package.swift → capacitor-swift-pm 8.5.0, NO CocoaPods). iOS Info.plist += UIBackgroundModes=[audio] (R4 groundwork) + NSAppTransportSecurity/NSAllowsArbitraryLoads (http LAN server). AndroidManifest += WAKE_LOCK. plutil-validated. `cap sync ios` ✔. package.json += cap:sync{,:android,:ios} scripts. .gitignore += native build outputs.
- R3-b CI: .github/workflows/android.yml (restored from original + fixed mangled `branches: [main]`) — bun install → bake TSF_SERVER_URL into capacitor.config.json → cap sync → gradle assembleDebug+assembleRelease (keystore optional via secrets) → artifacts + tag releases. NEW .github/workflows/ios.yml (macos-15): same bake+sync → xcodebuild `-project App/App.xcodeproj -target App -configuration Release -sdk iphoneos -derivedDataPath build/DerivedData CODE_SIGNING_ALLOWED=NO` (target-based because SPM template has no checked-in shared scheme; version stamps via MARKETING_VERSION/CURRENT_PROJECT_VERSION overrides = run number) → Payload zip → tsf-music-ios-unsigned.ipa artifact + tag release. Both YAML validated. Gauntlet bar "APK + unsigned IPA CI artifacts" is now WIRED (needs a GitHub remote to actually run; local sandbox can't build either).
- R3-c GESTURES (BAR-B §2.4): QueuePanel rewritten — (1) swipe-LEFT to remove: framer-motion drag="x" + dragDirectionLock + dragSnapToOrigin, red #e91429 reveal w/ Trash2+REMOVE label, threshold -72px, armed-reveal opacity; (2) tap vs swipe conflict solved w/ didDrag ref re-armed on pointerdown (timer-based reset raced React click — first implementation double-fired); (3) rows use touch-pan-y (vertical list scroll preserved — old touch-none would have blocked it); (4) grip = dnd-kit reorder (pointer devices), rows keyboard-accessible (Enter/Space), eq-bars now-playing indicator (new .tsf-eq-bar CSS, reduced-motion safe); (5) empty state w/ Music4 icon; header hint "Swipe left to remove" on mobile.
- R3-c STYLING: quick-pick tiles — art 48→44px, play 36→32px, gap 8→4px, mr 8→4px → title budget 73→79px → "Blank Space"/"Bad Blood"/"Opalite" now fit fully at 390 (before: ALL truncated); 21-char titles still ellipsize (bar-authentic). In-NP queue layout: when queueOpen, art shrinks to 160px strip + column flex-[2.2] — queue panel went from clipped ~90px sliver to a proper ~350px sheet.
- BUGS FOUND & FIXED via agent-browser QA: (1) `@media(hover:none) .group .opacity-0{opacity:1}` pinned the red swipe-reveal permanently visible on touch → inline style opacity instead of opacity-0 class (comment left in code); (2) QueueDrawer rendered a FULL duplicate queue panel behind the NP overlay (double rows in DOM, hit-test chaos, wasted renders) → drawer returns null while nowPlayingOpen (reappears after close since queueOpen persists).
- VERIFICATION: swipe test end-to-end via synthetic PointerEvents on real row (before=1, after=0, removedExactlyOne=true, trackChanged=false); tap-to-play still works; drag-reorder intact; drawer reappears post-NP-close (screenshot r3-home-final.png); playing works after reload (Opalite t=2.9, honest badge); BAR-A bodyBg #121212 exact; lint 0 problems; dev.log clean. Screenshots: tsf-analysis/qa/r3-queue-open.png (new sheet), r3-swipe-result.png, r3-home-final2.png.
- AUTOMATION LESSONS (for future QA rounds): JS el.click() is synthetic → audio needs REAL CDP clicks after reload (NotAllowedError otherwise); 30s-preview auto-advance re-renders the queue mid-test → PAUSE audio first for stable measurements; the Queue pill y differs between queue closed (481) and open (674) states.

Stage Summary:
- R3 DONE: iOS platform exists (SPM, background-audio + ATS configured), both platform workflows committed (android.yml = debug+release APK; ios.yml = unsigned IPA on macos-15), §2.4 queue gestures complete (swipe-remove + reorder + tap-safety), quick-pick truncation fixed, 2 real bugs fixed (touch reveal, duplicate panel). BAR-B mobile anatomy: §2.1 tabs ✅ §2.2 mini ✅ §2.3 home chips ✅ §2.4 queue gestures ✅ §2.5 NP ✅ §2.6 library ✅ §2.7 search ✅.
- Unresolved: workflows need a git remote + TSF_SERVER_URL secret to produce artifacts (sandbox has none — bar is "wired", execution pending); intl full-length yield still IP-reputation-bound (cookies/residential = next lever); SabrStream direct path unexploited; mini-bar stale-title transient seen once under automation stress — monitor.
- Recommended next (R4): background audio + MediaSession as REAL native plugins (Android ForegroundService + iOS MPNowPlayingInfoCenter/RemoteCommandCenter — Capacitor community plugin @mediagrid/capacitor-native-audio or hand-rolled), then R5 blind critic comparisons (BAR-C) with the 12 reference screenshots.

---
Task ID: 9
Agent: Z.ai Code (cron R4 — background audio + MediaSession native plugins)
Task: R4 of gauntlet — native MediaSession on both platforms (lockscreen/notification controls, background-audio foreground service), Wake Lock for lyrics, keyboard shortcuts feature, Share feature, toast system. Trace: web-cron-review-202608281611.

Work Log:
- STATUS ASSESS: dev 200, POT alive (uptime 5500s+), lint/tsc clean, mobile + desktop QA smoke pass (playback, badges, quick-picks, desktop liked view). No regressions found → proceeded to R4.
- DISCOVERY: web navigator.mediaSession wiring already existed in AudioEngine (metadata + play/pause/prev/next/seekto/seekbackward/seekforward + positionState). R4's real gap = native shells, where navigator.mediaSession never reaches the OS.
- ANDROID NATIVE (Java — template is Java-only, no Kotlin plugin):
  - MediaSessionPlugin.java (@CapacitorPlugin "TsfMediaSession"): updateMetadata (title/artist/album/artworkUrl/duration; async Bitmap fetch off-thread via single-thread executor, re-publishes metadata when art lands), updatePlaybackState (isPlaying/position/duration → PlaybackStateCompat with elapsedRealtime clock for an accurate scrubber), stop. Owns MediaSessionCompat w/ transport callbacks → notifyListeners("command"). Static active-instance pattern so the service can reach the plugin. handleOnDestroy tears down.
  - MediaPlaybackService.java: foreground service holding the MediaStyle notification (lockscreen + notification controls: prev/play-pause/next + stop via deleteIntent); translates notification actions → plugin events. Audio NEVER touches the service — WebView keeps decoding; the service only pins the process alive.
  - Wiring: manifest += FOREGROUND_SERVICE, FOREGROUND_SERVICE_MEDIA_PLAYBACK, POST_NOTIFICATIONS perms + <service .MediaPlaybackService foregroundServiceType="mediaPlayback">; MainActivity.registerPlugin(MediaSessionPlugin.class); app/build.gradle += androidx.media:media:1.7.0 (MediaSessionCompat + MediaStyle).
- IOS NATIVE (Swift): TsfMediaSessionPlugin.swift (CAPBridgedPlugin: identifier/jsName "TsfMediaSession", pluginMethods updateMetadata/updatePlaybackState/stop) — pins AVAudioSession to .playback (REQUIRED: WKWebView defaults to .ambient which dies in background + obeys the ring switch), MPNowPlayingInfoCenter metadata + MPMediaItemArtwork fetched async via URLSession, MPRemoteCommandCenter wiring (play/pause/next/previous/toggle/stop/changePlaybackPosition → "command" events). Registration VERIFIED against actual Capacitor 8.5.0 source (fetched CAPBridgeViewController.swift from GitHub raw): `open func capacitorDidLoad()` lives on CAPBridgeViewController (line 164) and CAPBridgeProtocol declares registerPluginInstance — so: MainBridgeViewController (subclass w/ capacitorDidLoad override → registerPluginInstance(TsfMediaSessionPlugin())) + SceneDelegate rootViewController swapped to it. CRITICAL LESSON: an AppDelegate-level capacitorDidLoad override would NOT compile — the hook is a view-controller method.
- JS BRIDGE (src/lib/nativeMedia.ts): registerPlugin<TsfMediaSessionPlugin>('TsfMediaSession') from @capacitor/core; isNativeShell() guard (Capacitor.isNativePlatform) — plain-web = zero-op (AudioEngine's navigator.mediaSession stays the web path); absoluteArtwork() rewrites app-relative thumbs for native loaders; onNativeCommand returns unsubscribe.
- AUDIOENGINE WIRING: track change → nativeUpdateMetadata(track); play/pause events → nativeUpdatePlaybackState; timeupdate → throttled 1/s playback-state push (lockscreen scrubber accuracy); unmount → nativeStop + offNative; "command" listener → store actions (play/pause/toggle/next/previous/stop/seekto).
- WAKE LOCK (src/hooks/useWakeLock.ts): Web Wake Lock API while lyrics open + playing (Spotify parity); re-acquires on visibilitychange; fully typed Sentinel; NP screen calls useWakeLock(lyricsOpen && isPlaying).
- FEATURE: KeyboardShortcuts.tsx — the ShortcutsOverlay documented shortcuts but NOTHING implemented them! Now global handlers: Space/K toggle, Shift+←/→ prev/next, ←/→ J/L seek ±5s, ↑/↓ volume ±5%, M mute, N/P next/prev; skips typing targets; no modifier theft. Mounted in AppShell. Overlay docs += M row.
- FEATURE: Share (TrackContextMenu) — new Share row via Web Share API (native sheet on mobile) → clipboard fallback + sonner toasts ("Link copied to clipboard" / error); Copy song link now also toasts. Mounted ui/sonner Toaster in layout (was missing — sonner toast() rendered nothing before! position bottom-right, offset above the player).
- QA (agent-browser): desktop 1440×900 — playback works; K/K toggle pause-resume verified via keypress; N advanced queue; M mute/unmute verified; ArrowLeft seeked 10.9→5.9s; ArrowUp clamps at 1.0; Liked-view context menu shows [Play now, Play next, Add to queue, Save, Add to playlist, Start radio, Download, Share, Copy song link]; Share click → toast visible (clipboard denied in headless = error-toast path, correct fallback chain); mobile 390×844 home renders (quick-picks fit; #121212 exact). tsc -p tsconfig.ci.json CLEAN; eslint 0 problems; dev.log clean.
- Screenshots: tsf-analysis/qa/r4-ctxmenu.png, r4-share-toast.png, r4-mobile-final.png.

Stage Summary:
- R4 DONE (code-complete): both native shells now project playback to OS surfaces with transport commands back into the store; wake lock + keyboard shortcuts + share/toast features landed. The gauntlet half "background audio + lockscreen controls" is IMPLEMENTED on both platforms; runtime verification requires real devices (next lever after CI artifacts exist).
- Unresolved: native code is compile-verified only by inspection (no Android SDK / Xcode in sandbox) — first GitHub Actions run may surface toolchain nits (e.g. MediaButtonNotificationComponent deprecation warnings, CAPPluginCall nullability); foreground-service start while app in background is blocked on Android 12+ (startForegroundService while-visible is our path — plugin starts it on metadata update which always happens in-foreground on user tap); POST_NOTIFICATIONS needs a runtime request on API 33+ (notification silently dropped if denied — playback still works).
- Recommended next (R5): BAR-C blind screenshot comparison (12 refs vs our build, labels stripped, critic picks) — the UI is now anatomy-complete; loop builder/critic until ours wins. Then CI artifact round (needs git remote + secrets) and the 100%-full-length playback levers (cookies/residential, SabrStream+webpo).
