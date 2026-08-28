# TSF Music — Mobile Gauntlet Progress

**Goal:** Fully functional Spotify-like app on Android + iOS, playing full-length music.
**Status:** Mobile-web phase COMPLETE — awaiting user test pass → then native shells.
**Critic final scores:** home 8.5/10 · search 9/10 · now-playing 9.5/10 (blind, vs Spotify mobile).
**Bar:** The real Spotify mobile app, compared blind at the same viewport.
**Rule:** A piece is done only when a fresh-context critic picks ours blind.

| # | Piece | Status | Critic verdict |
|---|-------|--------|----------------|
| 0 | Gauntlet bar set (Spotify mobile) | ✅ done | — |
| 1 | Codebase mobile audit | 🔄 running | — |
| 2 | WebView/Capacitor audio research | 🔄 running | — |
| 3 | Server: proxy stream mode (`?proxy=1`) | ✅ done | critic 9/10 |
| 4 | Mobile shell: bottom nav + mini-player | ✅ done | critic 9/10 |
| 5 | Home / Search / Library mobile | ✅ done | 8.5/10 |
| 6 | Full-screen Now Playing + swipe | ✅ done | 9.5/10 |
| 7 | MediaSession lock-screen + manifest | ✅ done | verified in sandbox |
| 8 | Capacitor Android shell | ⏸ after user pass | — |
| 9 | Capacitor iOS shell source | ⏸ after user pass | — |
| 10 | Android APK build | ⏸ deferred (user: no build yet) | — |
| 11 | Reachability (Tailscale/mkcert) | 📋 documented in MOBILE-SOLUTION.md | — |
| 12 | Final verify + ZIP | ✅ done | see download/tsf-music.zip |

## Architecture decision (the "complete fix", layered)

- **L0 — Server stays on the Mac** (residential IP = full-length audio, field-verified).
  Phone reaches it over Wi-Fi LAN, or from anywhere via Tailscale (free).
- **L1 — One codebase, mobile-first UI** (Spotify-mobile layout: bottom tabs,
  mini-player, swipe-up Now Playing) — no React-Native rewrite: preserves 100%
  of existing features (AI radio, playlists, onboarding) instantly.
- **L2 — PWA layer**: installable, MediaSession lock-screen + background audio
  in Chrome Android & Safari iOS.
- **L3 — Native shells (Capacitor)**: real APK (Android) + Xcode project (iOS)
  with true background audio + notification/lock-screen integration.

## Known hard limits (stated honestly)

- iOS `.ipa` cannot be compiled outside macOS+Xcode → we ship a 2-command
  Xcode-ready project; the user's Mac finishes it.
- Full-length audio requires the server on a clean IP (their Mac = verified ✓).
