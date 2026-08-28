# TSF Music — macOS App (native shell)

Native desktop app for **macOS 10.15+**, built by GitHub Actions into signed
(ad-hoc) `.dmg` installers for **Intel x64** (MacBook Pro 16" 2019 i9 ✓,
macOS 26 Tahoe supported) and **Apple Silicon**.

## Architecture (why it's "native at least")

```
┌────────────────────────────────────────────────────────────┐
│  TSF Music.app                                             │
│                                                            │
│  Rust shell (Tauri 2, ~10 MB)                              │
│   • native window (WKWebView — Safari engine, not Chromium)│
│   • Now Playing + media keys (MPNowPlayingInfoCenter /     │
│     MPRemoteCommandCenter via souvlaki)                    │
│   • App Nap disabled → audio keeps playing hidden/minimized│
│   • single-instance, native logs, child-process supervision│
│                                                            │
│  Bundled engine (spawned on 127.0.0.1:8137+)               │
│   • Bun runtime + Next standalone server (ALL features:    │
│     music, AI playlists, library, lyrics, queue, search)   │
│   • bgutil POT provider (BotGuard PO tokens, :4416)        │
│   • yt-dlp + deno → full-length streaming                  │
│   • SQLite in ~/Library/Application Support/com.tsfmusic.desktop │
└────────────────────────────────────────────────────────────┘
```

Everything the web app does, the Mac app does — 100% local, no server needed.
AI features additionally read `~/.z-ai-config` (same file the web version
uses) when present.

## Install (unsigned build)

1. Download `TSF-Music-*-x64.dmg` (Intel) from the release/artifacts.
2. Open the DMG, drag **TSF Music** → **Applications**.
3. Double-click **First-Run-MacOS.command** (in the same DMG) once.
   It removes the Gatekeeper quarantine flag (macOS Sequoia/Tahoe removed
   right-click→Open for unsigned apps; this script is the sanctioned path).
4. Launch from Launchpad. First launch boots the engine (~5 s).

> Signing/notarization: the workflow auto-activates real Developer ID signing
> + notarization if these secrets exist: `APPLE_SIGNING_IDENTITY`,
> `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`,
> `APPLE_PASSWORD`, `APPLE_TEAM_ID`. Without them it ships ad-hoc-signed
> (which is why step 3 exists).

## Logs / data

| What | Where |
| --- | --- |
| Engine log | `~/Library/Logs/com.tsfmusic.desktop/server.log` |
| POT provider log | `~/Library/Logs/com.tsfmusic.desktop/pot-provider.log` |
| Database | `~/Library/Application Support/com.tsfmusic.desktop/tsf.db` |

## Feature verification matrix (CI)

| Feature | Verified by |
| --- | --- |
| Engine boots healthy | `probe` job: `/api/health` 200 within 90 s |
| Search → stream (music core) | `probe` job: 20-track resolve, ≥ N% full-length |
| yt-dlp + POT chain | `probe` job (same env as the bundled app) |
| AI playlists / discover | web QA evidence (agent-browser) + engine identity |
| Native Now Playing / media keys | souvlaki in Rust shell (code + cargo check) |
| Background audio | `NSAppSleepDisabled` in Info.plist (Tahoe-safe) |
| Both CPU archs | matrix build (x64 + arm64), ad-hoc signed |

## Local development (Mac, without CI)

```bash
bun install
bun run build                      # engine → .next/standalone
bash scripts/desktop/prepare-mac-resources.sh x86_64-apple-darwin
bunx tauri dev                     # or: bunx tauri build
```
