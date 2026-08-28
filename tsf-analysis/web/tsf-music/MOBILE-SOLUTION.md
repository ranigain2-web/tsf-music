# TSF Music — Mobile Solution (Android + iOS)

**Status: READY FOR USER TESTING** · No native code needed for this phase.

This document is the complete output of the mobile research + fix sprint:
what was investigated, what was fixed, how to test on both platforms, what
the hard limits of the web are, and the native plan that unlocks them later.

---

## 1. Research conclusions (verified against primary sources)

| Question | Answer |
|---|---|
| Does `<audio>` keep playing with screen off / backgrounded? | **Android Chrome: yes** (media notification). **iOS Safari page: yes** for the current track, but page JS is suspended → auto-advance to the next track stalls until the screen wakes. **iOS home-screen web app: yes** since iOS 15.4 (incl. lock-screen pause/resume). |
| Lock-screen / notification controls? | **Both platforms, yes** — via the MediaSession API. iOS shows them for any page playing `<audio>`; Android Chrome shows the media notification after ~5s of playback. |
| Does MediaSession need HTTPS? | **No** — it is not a secure-context API. Works on `http://192.168.x.x:3000`. |
| Can Android install the PWA from LAN http? | **No** — install/service-worker requires HTTPS (or localhost). "Add to Home screen" gives a shortcut only. **iOS "Add to Home Screen" works over http** and behaves like an app (standalone, keeps audio in background). |
| iOS + cross-origin 307 redirect audio (googlevideo) | Fragile: WebKit has a cluster of redirect + Range + CORS media bugs. **Fix: stream bytes same-origin through the Mac server (implemented — `?proxy=1`).** |
| m4a/AAC + Range support | Fully supported on both platforms. Correct MIME `audio/mp4`, Range passthrough implemented. |
| Autoplay | Tap-to-play works on both (the tap is the gesture). `preload="metadata"` + `playsInline` set. |

## 2. What was implemented (this sprint)

**Playback correctness (phones)**
- `GET /api/stream?...&proxy=1` — same-origin byte streaming with Range
  passthrough. The **Mac** resolves AND fetches the googlevideo URL from its
  verified residential IP; the phone only ever talks to the Mac over Wi-Fi.
  Kills CORS / redirect / IP-bound-expiry issues in one move.
- Phones auto-detect touch UI and add `&proxy=1` (`AudioEngine.tsx`). The
  stale-URL auto-recovery also uses it.
- MediaSession: `setPositionState` (lock-screen scrubber + elapsed time),
  `playbackState` on play/pause, metadata with 96/256/512 artwork.
- `preload="metadata"`, `playsInline`.

**Spotify-mobile UI (phone widths, verified at 390×844 by an independent
vision critic: 3/10 → 4/10 → 8.5–9.5/10 over three gauntlet rounds)**
- Compact mini-player: thin progress line on the top edge, art, title/artist,
  heart, play/pause, chevron affordance; tap row → full-screen player.
- Full-screen Now Playing: swipe-down-to-dismiss (armed from the top bar so
  sliders still work), notch/Dynamic-Island safe areas, home-indicator
  padding, quiet ghost pills on mobile, volume controls desktop-only,
  balanced control sizes.
- Track rows: single tap plays (Spotify mobile behavior), ONE subtle heart
  per row on phones (the desktop hover-action wall is gone below lg).
- Home: 2-column compact Quick-Picks tiles (Spotify mobile grid).
- Search: compact Top-Result card; the duplicate top search bar is gone.
- Bottom tabs: stronger active/inactive contrast.
- TopBar: mobile back chevron (iOS web-apps have no hardware back).
- Queue drawer: bottom sheet on phones, above the player chrome.
- Touch hygiene: `@media (hover:none)` makes hover-only affordances visible,
  `touch-action: manipulation`, no tap highlight, no long-press callouts,
  `-webkit-text-size-adjust: 100%`.
- Manifest: `id` + shortcuts. Onboarding footer safe-area.

## 2½. QA Round 1 (2026-08-27, local Mac report) — bugs found → fixed

Your local model ran the full server-side matrix (8 tracks: international,
Hindi, classic, South-Indian, Punjabi, regional). Result: **all 8 play
full-length with Range (206)** — but 3 code bugs surfaced. All fixed:

| # | Bug (from QA report) | Severity | Fix |
|---|---|---|---|
| 1 | `/api/stream?proxy=1` **without** a client `Range` header → 502 (`googlevideo` 403s range-less full-file GETs) | blocker | `pipeUpstream` now always asks upstream for the full byte space (`Range: bytes=0-`) when the client sends none, and retries once with `bytes=0-` on 403/416. Verified end-to-end against a real CDN: no-Range proxy request → `206` + bytes + provider header |
| 3 | `/api/download` always 502 (same range-less fetch) + double-fetch fallback | major | Download fetches with `Range: bytes=0-`, 15-min timeout (CDN throttles to realtime), plus a cheap `HEAD` probe (`Range: bytes=0-0`) so `curl -I` no longer buffers a whole song. Verified: `200` + `Content-Disposition` + real bytes |
| 2 | Search `Track.duration` always `0` | minor | Root cause: an InnerTube A/B variant omits song-row durations (no `fixedColumns`, no run). Fix: unfiltered searches now ALSO fetch the songs-filtered search **in parallel** (zero added latency) and merge durations by videoId; top-result card row + two-row duration parsing fixed too. Verified: Kesariya 269s, Shape of You 234s, Blinding Lights 199s, etc. Residual: some YouTube-video rows (live clips/reactions) carry no duration anywhere in the response — cosmetic, self-corrects on play |
| 4 | `.env` shipped a sandbox-absolute Linux path | env | Now portable: `DATABASE_URL=file:../db/custom.db` (resolved against `prisma/schema.prisma`, works on any machine) + `.env.example` shipped |

Also confirmed healthy in QA: cache 26× warm speedup, `expire`-honoring TTL,
circuit breaker, synth fallback isolation, `db:clear-cache`, desktop 307s.
**Phone tests (Phase C) still pending — owner action.**

## 3. How to test (do this on both an Android phone and an iPhone)

On the Mac (same Wi-Fi as the phones):

```bash
bun install         # preferred (npm install can time out on slow links)
npm run dev         # or: bun run dev — note the "Network" URL it prints, e.g. http://192.168.1.5:3000
```

Find the Mac's LAN IP: `ipconfig getifaddr en0`

- **Android**: Chrome → `http://<mac-ip>:3000`
  - Play a song → notification appears after ~5s; turn the screen off → music
    continues; lock-screen controls work (play/pause/next/prev/seek).
  - Menu → "Add to Home screen" → launches full-screen (shortcut, not a
    installable PWA — that needs HTTPS, see §5).
- **iPhone**: Safari → `http://<mac-ip>:3000`
  - Play → lock the screen → current track continues; lock-screen controls
    + scrubber work; Control Center shows artwork.
  - Share → "Add to Home Screen" → launches standalone like an app; audio
    continues in background (iOS ≥ 15.4).
- **Known iOS web limit (honest)**: with the screen OFF, when one track
  ENDS, advancing to the next track can stall until you wake the screen
  (WebKit suspends page JS). Screen-on and manual lock-screen skipping work
  fine. This is the #1 thing the native wrap fixes (§5).
- If playback ever shows 0:00 after switching networks: `npm run db:clear-cache`.

## 4. What is impossible on the mobile web (and why the native wrap exists)

1. **iOS guaranteed multi-track background playback** — JS suspension at
   track boundaries (above).
2. **Android real PWA install over LAN http** — HTTPS requirement. (mkcert or
   Tailscale HTTPS later, or the native app.)
3. **Android WebView MediaSession** — the system WebView does not implement
   the API at all; only Chrome does.

## 5. Native plan (AFTER you test and give the pass)

Capacitor 7 wrapping this same app (no rewrite):
- Android APK (buildable on any machine): `server.url` → the Mac's address
  (or Tailscale for away-from-home), `cleartext: true` for LAN http, plus a
  native audio bridge (foreground service + ExoPlayer-style media session)
  because WebView JS suspends in background.
- iOS Xcode project (needs your Mac): same config + `NSAllowsLocalNetworking`
  ATS exception, `UIBackgroundModes: audio`, AVAudioSession `playback`.
- Everything ships as a ready-to-open project with 2 commands to run.

## 6. Files touched this sprint

`src/app/api/stream/route.ts` (proxy mode), `src/components/player/AudioEngine.tsx`
(proxy detect, preload, MediaSession position state, playbackState),
`src/components/player/NowPlayingBar.tsx` (compact mobile bar),
`src/components/player/FullScreenNowPlaying.tsx` (safe areas, swipe, layout),
`src/components/player/QueueDrawer.tsx` (mobile sheet), `src/components/shell/TopBar.tsx`
(mobile back, search dupe), `src/components/shell/MobileNav.tsx` (contrast),
`src/components/shared.tsx` (tap-to-play, mobile row actions),
`src/components/views/HomeView.tsx` (2-col quick picks, header links),
`src/components/views/SearchView.tsx` (compact top result),
`src/app/globals.css` (touch rules), `public/manifest.json` (id/shortcuts),
`src/components/onboarding/StepFooter.tsx` (safe area).

## 7. Musify integration sprint (2026-08-27) — "works effortlessly" upgrades

Studied github.com/gokadzev/Musify (Flutter, 100+ dart files, GPL v3) — the
reference app the user pointed at — and ported its core playback-hardening
techniques into TSF Music:

### What Musify does (their architecture, verified in source)
- Streams via a **vendored youtube_explode_dart fork** whose client configs
  are synced to yt-dlp master (2026-08-18). Their default client list is
  `[YoutubeApiClient.visionOs]` — the **visionOS** InnerTube client, yt-dlp's
  ONLY remaining default tokenless client.
- `android_vr` is dead since 2026-08-17 (YouTube 403s all its formats,
  yt-dlp#17456) — matches our QA findings exactly.
- **Byte fetches are UA-matched**: googlevideo URLs from app-style clients
  are signed against the resolving client's User-Agent; a generic UA causes
  403s (their fork literally has a fix comment about this).
- **SponsorBlock** integration (sponsor.ajay.app) with categories
  sponsor/selfpromo/interaction/intro/outro/music_offtopic — that's their
  "No ads" pitch: skip the non-music parts.
- Optional free-proxy rotation (spys/geonode/open-proxy-list) when the local
  IP is blocked — not needed for our Mac-serves-phones topology.
- 3h stream-URL cache, offline downloads, equalizer, lyrics.

### What we ported
| Fix | Where | Effect |
|-----|-------|--------|
| **VISIONOS client** (chain head) | `src/lib/ytm/clients.ts`, `stream.ts` | Future-proof tokenless resolution; races in parallel on every play |
| **IOS client → 21.26.4** | `src/lib/ytm/clients.ts` | Current yt-dlp-synced build |
| **TVHTML5 fallback** | same | `contentCheckOk`/`racyCheckOk` path for restricted videos |
| **Opus/webm audio fallback** | `stream.ts` resolveInnertube | Plays even when only webm formats survive |
| **UA-matched byte proxying** | `stream/route.ts` pipeUpstream, `download/route.ts` | StreamResult carries `userAgent`; proxy + download fetch with the resolving client's exact UA → no more 403s on app-style URLs |
| **`&range=a-b` query-param retry** | `stream/route.ts` | googlevideo's alternate range path as last-resort self-heal |
| **SponsorBlock auto-skip** | `src/lib/ytm/sponsorblock.ts`, `api/sponsorblock/route.ts`, `AudioEngine.tsx` | Playhead hops over intros/outros/sponsor plugs (ad-free feel); 24h/7d cache; toggle in Library → Playback |
| **Playback settings tab** | `LibraryView.tsx` | Spotify-style pill switch for segment skipping + stream-engine explainer |
| **Search: songs-first merge** | `ytm/index.ts`, `parse.ts` | Triple-response merge (unfiltered + songs + videos); every song row has a duration; podcast/episode/profile junk removed from songs list |

### Verified in sandbox (gauntlet: 31/31 PASS)
- 7-market search: top-12 rows 100% duration-clean, zero junk rows
- SponsorBlock: real segments for Shape of You (music_offtopic 0–6s,
  238–263s), clean 404 → empty, skip plan never eats track tails
- Proxy mode: no-Range → 206 + full bytes; Range head/mid-seek → 206
- Download: full 1MB m4a attachment
- Browser E2E (Playwright): track double-click → audio playing (readyState 4,
  duration 269s), sponsorblock fetch fired on load, settings toggle works,
  zero console errors

### What we deliberately did NOT port
- **Free-proxy rotation** — our topology routes phone traffic through the
  Mac's clean residential IP already; public proxies would ADD latency and
  flakiness, not remove it. (The proxy_manager exists in Musify because a
  phone app can't guarantee a clean egress IP.)
- **Offline downloads to device storage** — web apps can't write arbitrary
  files; that's native-phase work ( Capacitor + filesystem plugin).
- **Equalizer** — Web Audio API BiquadFilters can do it, but it's a UI
  sprint of its own; queued as a post-native-pass enhancement.
