# TSF Music

A Spotify-class music app with **full-length streaming**, AI playlists, lyrics,
queue and library — built as ONE codebase shipping to **macOS, Android and iOS**
via GitHub Actions.

> Everything runs locally: the bundled engine (Next.js standalone server +
> Bun runtime + yt-dlp + POT token provider) powers 100% of the features on
> every platform. No external backend needed.

## Download (Releases)

Grab the latest build from **[Releases](https://github.com/ranigain2-web/tsf-music/releases)**:

| File | Platform | Notes |
|---|---|---|
| `TSF-Music-*-x64.dmg` | **macOS Intel** (MacBook Pro 16" 2019 i9 ✓, macOS 26 Tahoe) | target build |
| `TSF-Music-*-arm64.dmg` | macOS Apple Silicon | Rosetta-free |
| `app-release.apk` | Android 6.0+ | debug + release variants |
| `tsf-music-ios-unsigned.ipa` | iOS (sideload) | unsigned; needs AltStore/Sideloadly/TrollStore |

### macOS install (unsigned build)

1. Open the DMG and drag **TSF Music** → **Applications**.
2. Double-click **First-Run-MacOS.command** (in the same DMG) — it strips the
   Gatekeeper quarantine flag in one step (macOS Sequoia/Tahoe removed
   right-click → Open for unsigned apps).
3. Launch from Launchpad. First launch boots the local engine (~5 s).

Native integration included: Now Playing (lockscreen/Control Center), media
keys (MPRemoteCommandCenter), menu bar with a Playback section, tray with
transport controls, background audio (App Nap disabled), single-instance.

## Architecture

- **Web core** (`src/`) — Next.js 16 + TypeScript + Tailwind 4 + shadcn/ui.
  Playback engine: `lib/ytm/` (YouTube full-length via POT tokens + yt-dlp,
  iTunes/JioSaavn fallbacks), `lib/ai/` (AI playlists, radio, chat),
  `lib/synth/` (procedural fallback). Prisma + SQLite for library data.
- **macOS shell** (`src-tauri/`) — Tauri 2 / Rust + WKWebView. Boots the
  bundled engine as child processes, waits for `/api/health`, then points a
  native window at it. Now Playing + media keys via souvlaki.
- **Android shell** (`android/`) — Capacitor 8 + custom `MediaSessionPlugin`
  (lockscreen controls, foreground service).
- **iOS shell** (`ios/`) — Capacitor 8 + `TsfMediaSessionPlugin` (Swift).

## CI/CD

Three workflows build every push and publish on `v*` tags:

- **macOS App** (`.github/workflows/macos.yml`) — playback gauntlet probe
  (20-track set, ≥50% full-length gate) → Tauri builds for x64 + arm64 →
  ad-hoc codesign → DMG + zip artifacts → tagged release.
- **Build Android APK** — Gradle debug + (optionally signed) release.
- **Build iOS IPA (unsigned)** — xcodebuild → Payload → IPA.

## Development

```bash
bun install
bun run dev          # http://localhost:3000
bun run build        # production standalone build
```

The macOS shell: `bun run desktop:prepare` then `bunx tauri build`.
