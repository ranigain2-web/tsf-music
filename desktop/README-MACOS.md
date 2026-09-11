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

## Install

**If the release is notarized** (repo has the signing secrets): download the
DMG, drag **TSF Music** → **Applications**, launch. Nothing else. No prompts.

**If the release is ad-hoc signed** (no secrets — the current default):

1. Download `TSF-Music-*-x64.dmg` (Intel) from the release/artifacts.
2. Open the DMG, drag **TSF Music** → **Applications**.
3. Double-click **First-Run-MacOS.command** (in the same DMG) once.
   It removes the Gatekeeper quarantine flag (macOS Sequoia/Tahoe removed
   right-click→Open for unsigned apps; this script is the sanctioned path).
4. Launch from **Launchpad / Applications** — never from inside the DMG.
   First launch boots the engine (~5 s).

### Zero-prompt install (no Apple account needed)

The quarantine flag that triggers Gatekeeper is applied by **the browser**, not
by GitHub. Downloading the same asset with `curl` in Terminal skips it — the
DMG arrives clean, so `xattr`/First-Run are unnecessary and macOS does not
prompt at all:

```bash
# grab the newest Intel DMG straight from the release
curl -L -o ~/Downloads/TSF-Music-x64.dmg \
  https://github.com/ranigain2-web/tsf-music/releases/latest/download/TSF-Music-0.4.1-x64.dmg
hdiutil attach ~/Downloads/TSF-Music-x64.dmg
cp -R "/Volumes/TSF Music/TSF Music.app" /Applications/
hdiutil detach "/Volumes/TSF Music"
open "/Applications/TSF Music.app"
```

This works because the hardened-runtime gate only fires on quarantined files;
a signature that is merely *ad-hoc* is accepted for a locally-copied bundle.

### Why it gets blocked EVERY launch (and how to stop it)

Almost always this means the app is being launched **from inside the mounted
DMG**, or re-downloaded each time:

* A file on a read-only DMG can never have its quarantine flag removed, so
  macOS re-assesses and re-blocks it on every open.
* Every fresh download is a *new* build with a *new* ad-hoc signature, so
  macOS treats it as a brand-new app and asks again.

Fix: **install to /Applications** (drag it out), run First-Run once, then
launch from /Applications. From v0.4.1 the app detects a `TSF-Music-*.dmg` in
`~/Downloads` and shows this exact instruction on its boot screen.

### Permanent fix — Developer ID signing + notarization

The macOS workflow auto-activates it when these repo secrets exist:
`APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE` (base64-encoded `.p12`),
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific
password), `APPLE_TEAM_ID`. Requires a paid Apple Developer Program membership
($99/yr) — this is an Apple requirement, not a TSF one. Notarized downloads
open with **no** prompt and no First-Run script, on any Mac, from any browser.
The pipeline signs every nested helper (`bun`, `yt-dlp`, `deno`, the POT
provider) and applies `src-tauri/entitlements.plist` so the embedded JS
runtimes survive the hardened runtime.

> **Status: implemented but not yet validated on a macOS runner** — it is
dormant until the secrets are added. Validate one dispatch run before trusting
it; the ad-hoc path remains the fallback and still ships a working app.

## Logs / data

| What | Where |
| --- | --- |
| Engine log | `~/Library/Logs/com.tsfmusic.desktop/server.log` |
| POT provider log | `~/Library/Logs/com.tsfmusic.desktop/pot-provider.log` |
| Database | `~/Library/Application Support/com.tsfmusic.desktop/tsf.db` |

## Troubleshooting

**"The engine failed to start" / "did not become healthy within 120s"**

Since v0.1.1 the error screen itself shows the engine's last log lines and the
app strips the Gatekeeper quarantine flag from its own bundled binaries at
every boot — so the most common cause (macOS silently killing the bundled
`bun` / `yt-dlp` helpers that were never un-quarantined) is auto-healed. If it
still fails:

1. Press **Retry** on the error screen (it re-runs the self-heal + boot).
2. Check the two log files above — the last lines name the real cause.
3. Re-run `First-Run-MacOS.command` from the DMG (strips quarantine on the
   whole app, including everything else), then Retry.
4. Confirm the app is in **/Applications**, not still on the DMG.
5. Still stuck? Open an issue with both log files attached.

**"The Mac app feels slower than the phone"**

The Mac app boots its own private engine on every launch, while the phone
streams from an always-running server whose caches are already warm — so the
first minute after launch is inherently the cold one. v0.4.1 cuts that:

* The recursive `xattr -r` quarantine walk over the whole bundle no longer
  runs on a clean install (it used to stat every file before the engine even
  started).
* On boot the engine now warms the yt-dlp binary, the AI gateway config, the
  home feed, and the stream resolver for your most recent tracks — so your
  first tap after launch is served from a warm cache.
* Set `TSF_NO_WARMUP=1` (or `TSF_NO_STREAM_WARM=1`) to disable, and
  `TSF_WARMUP_DEBUG=1` to log warm-up steps to `server.log`.

Historical note (fixed in v0.1.1): the first release built its database URL
from the unencoded `~/Library/Application Support/...` path — the space broke
Prisma's `file:` URL parsing on every Mac. It is now percent-encoded
(`Application%20Support`), and CI's smoke step regression-tests exactly that.

## Feature verification matrix (CI)

| Feature | Verified by |
| --- | --- |
| Engine boots healthy | `probe` job: `/api/health` 200 within 90 s |
| **The .app boots its OWN bundled engine** | `Smoke` step (macOS runner): executes the packaged Mach-O `resources/runtime/bun` + `server.js` + space-path `DATABASE_URL`, `/api/health` 200 + root page 200 |
| Search → stream (music core) | `probe` job: 20-track resolve, ≥ N% full-length |
| yt-dlp + POT chain | `probe` job (same env as the bundled app) + smoke `yt-dlp --version` |
| AI playlists / discover | web QA evidence (agent-browser) + engine identity |
| Native Now Playing / media keys | souvlaki in Rust shell (code + cargo check) |
| Background audio | `NSAppSleepDisabled` in Info.plist (Tahoe-safe) |
| Both CPU archs | matrix build (x64 + arm64) |
| Nested helper signatures | `Codesign` step audits each nested Mach-O; notarization fails on any unsigned binary |
| Quarantine self-heal is cheap | walks only when the bundle is actually quarantined |
| Boot warm-up runs | `TSF_WARMUP_DEBUG=1` logs each stage; verified live in the dev sandbox |

## Local development (Mac, without CI)

```bash
bun install
bun run build                      # engine → .next/standalone
bash scripts/desktop/prepare-mac-resources.sh x86_64-apple-darwin
bunx tauri dev                     # or: bunx tauri build
```
