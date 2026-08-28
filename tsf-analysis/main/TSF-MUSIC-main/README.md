# TSF Music 🎵

**Spotify-grade personal music streaming — your server, your library, full-length tracks, AI playlists, native Android app.**

Single-user, dark-only music app. No login, no ads, no accounts. A Next.js
server (runs on your laptop / Mac / VPS) resolves and streams real full-length
audio; phones (Android app + any browser) connect to it over Wi-Fi or VPN.
A GitHub Actions pipeline compiles the installable Android APK for you.

```
┌────────────────────────── your machine ──────────────────────────┐
│  TSF Server (Next.js + Prisma/SQLite)                            │
│   ├─ JioSaavn provider ──── 320 kbps AAC, full length (regional) │
│   ├─ yt-dlp subprocess ─── full-length international tracks      │
│   ├─ iTunes preview ────── 30s preview fallback                  │
│   └─ offline synth ─────── audible fallback when offline         │
│   + AI playlist engine (token-streaming SSE, first track ≈1s)    │
└───────────────┬──────────────────────────┬───────────────────────┘
        http://lan-ip:3000         Capacitor native shell
        ▲                                   ▲
   any browser                        TSF Music Android app
  (Chrome/Safari)                     (built by GitHub Actions)
```

## Quick start (server)

```bash
bun install          # npm is NOT recommended; bun.lock is canonical
bun run dev          # prisma db push + next dev on :3000
```

Open `http://localhost:3000`. For phones on the same Wi-Fi, use your LAN IP
(`ipconfig getifaddr en0` on macOS) and see *Android app* below.

Optional, for full-length international tracks: `brew install yt-dlp`
(the server discovers the binary automatically).

## The Android app

The repo ships a **Capacitor** native shell (`android/`). The app is the same
web experience served by your TSF server — the WebView's origin IS your
server, so every feature (search, full-length streaming, AI playlists,
likes, library) works exactly as in Chrome, with a real app icon, splash
screen and no browser UI.

**Build it without installing anything locally** — GitHub Actions does it:

1. Go to **Actions → Build Android APK → Run workflow** (or push a `v*` tag).
2. Download the `tsf-music-android` artifact (debug + signed release APK).
3. Sideload `app-release.apk` onto your phone ("install unknown apps").

The server address baked into the APK comes from the `TSF_SERVER_URL`
repository secret (default `http://10.125.110.1:3000`). Change the secret →
rebuild → new APK points at the new address. Signing is fully automated via
repository secrets (`ANDROID_KEYSTORE_*`), so every release APK upgrades
cleanly over the previous one — no uninstall/reinstall.

> LAN HTTP note: Android 9+ blocks cleartext traffic by default; the shell's
> manifest already sets `usesCleartextTraffic="true"` for this reason.

## Features

### Streaming core
- **Full-length audio** via a ranked, fail-fast provider race:
  JioSaavn (320 kbps AAC, artist-gated, language-blocklisted) →
  yt-dlp (multi-client retry) → iTunes 30s preview → offline synth.
- **Honest quality badges** in the player: emerald = full-length,
  amber = 30s preview, slate = offline synth. No silent degradation.
- **Byte-proxy streaming** (`?proxy=1` on phones): same-origin 206 Range
  passthrough — sidesteps WebKit/WebView CORS + redirect fragility.
- **SponsorBlock auto-skip**, self-healing stale-URL cache, background
  cache warming, ranked cache precedence (full-length rows always win).
- **MediaSession** lock-screen/notification controls + scrubber.

### AI layer
- **AI Playlist Generator** — natural-language prompt → 10/25/40-track
  playlist, token-streamed over SSE: first track ≈1s, full ≈6s, repeat
  ≈50ms (24h prompt cache). Live-growing animated track list.
- **Discover Weekly / Release Radar / Daylist / On Repeat** —
  deterministic, metadata-driven, no-LLM-required personalization.

### App shell
- Spotify-class dark UI: ambient drifting artwork, glass topbar, spring
  motion, shimmer skeletons, staggered shelf entrances.
- Mobile-first: bottom nav, mini-player, swipe-up fullscreen player,
  bottom-sheet queue, safe-area aware.
- Onboarding (name / artists / genres) → personalized home.

## Repo layout

```
src/                 app code (Next.js App Router)
  app/api/           stream, download, health, ai/*, ytm/*, library/*, …
  components/        views, player, shell, ai, onboarding
  lib/               ai engine, jiosaavn, ytdlp, stream resolver, synth
  store/             zustand player/nav/library/preferences
android/             Capacitor native shell (committed, CI-buildable)
mobile-shell/        bundled WebView origin (fallback page)
assets/              1024px icon/splash sources (@capacitor/assets)
scripts/             gauntlets, benchmarks, evidence tooling
docs/                research notes
capacitor.config.json  native shell config (server.url lives here)
```

## CI / CD

| Workflow | What it does |
|---|---|
| `ci.yml` | install → typecheck → production build on every push/PR |
| `android.yml` | capacitor sync → gradle → **signed release APK** + debug APK artifacts; tagged `v*` builds also publish a GitHub Release |

## Honest limits

- The Android WebView does not implement the MediaSession API —
  background playback of the *current* track works, lock-screen controls
  need the Chrome/PWA path or a future native audio bridge.
- International full-length tracks need `yt-dlp` on the server machine.
- The server must be reachable from the phone (same Wi-Fi, or Tailscale).

## Documentation

- `MOBILE-SOLUTION.md` — the full mobile research + implementation story
- `MOBILE-PROGRESS.md` — phase tracker with critic scores
- `QA-REPORT-2026-08-27.md` — field QA trail
- `docs/full-length-audio-research.md` — the YouTube SABR blocker analysis
