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

**If the release is ad-hoc signed** (no secrets — the current default): use
the one-command installer below. **Do not** install by downloading the DMG in
a browser — that is what causes the repeated Gatekeeper blocks.

---

## Install detail

The **complete user walkthrough** — Steps 0 to 8, every command, every expected
output, upgrading, the doctor, the one-time quarantine fix, free-vs-paid and a
copy-paste command reference — lives in the root
[`README.md`](../README.md#1--install-on-your-mac--full-step-by-step). It is
kept in exactly one place on purpose so the two copies cannot drift apart.
Short version: `curl -fsSL .../desktop/install-macos.sh | bash`.

Everything below is the native-shell internals behind that one line — how the
installer works, why Gatekeeper blocks browser copies, and how the signing and
notarization path is wired.

### Verify a problem install

```bash
curl -fsSL https://raw.githubusercontent.com/ranigain2-web/tsf-music/main/desktop/tsf-doctor.sh | bash
```

Reports the app version, signature authority, quarantine state, the bundled
engine's health, every provider's live/cooling state, resolve latency percentiles
— and then resolves a real track and tells you plainly whether you got
**full-length audio, a 30 s preview, or the offline synth**.

### Manual fallback (if you prefer to see every step)

```bash
# EITHER use the installer without piping it:
curl -fsSL -o /tmp/tsf-install.sh \
  https://raw.githubusercontent.com/ranigain2-web/tsf-music/main/desktop/install-macos.sh
less /tmp/tsf-install.sh        # read it first
bash /tmp/tsf-install.sh

# OR do it by hand (Intel; use -arm64 on Apple Silicon):
curl -fL -o ~/Downloads/TSF-Music.dmg \
  https://github.com/ranigain2-web/tsf-music/releases/latest/download/TSF-Music-0.4.1-x64.dmg
hdiutil attach ~/Downloads/TSF-Music.dmg -nobrowse
cp -R "/Volumes/TSF Music/TSF Music.app" /Applications/
hdiutil detach "/Volumes/TSF Music"
xattr -cr "/Applications/TSF Music.app"
open "/Applications/TSF Music.app"
```

### Why it gets blocked EVERY launch (and how to stop it)

Almost always this means the app is being launched **from inside the mounted
DMG**, or re-downloaded (in a browser) each time:

* A file on a read-only DMG can never have its quarantine flag removed, so
  macOS re-assesses and re-blocks it on every open.
* Every browser download is a *new* file with a *new* quarantine flag, and
  each build carries a *new* ad-hoc signature, so macOS treats it as a
  brand-new app and asks again.

Fix: install once with the one-command installer above, then launch from
**Launchpad / Applications** — never from inside the DMG. From v0.4.1 the app
detects a `TSF-Music-*.dmg` in `~/Downloads` and shows this exact instruction
on its boot screen. If you already have a broken copy, delete it and reinstall
with the one-liner:

```bash
rm -rf "/Applications/TSF Music.app"
curl -fsSL https://raw.githubusercontent.com/ranigain2-web/tsf-music/main/desktop/install-macos.sh | bash
```

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

Two signing details that are easy to get wrong, both handled in `macos.yml`:

* **`--deep` does not reach our helpers.** It only descends into
  `Contents/Frameworks`, `Contents/PlugIns` and `Contents/MacOS`; everything
  TSF bundles lives under `Contents/Resources` (`bin/yt-dlp`, `runtime/bun`,
  `bin/deno`, `pot-provider/…/canvas.node`, the Prisma query engines). A
  `--deep`-only bundle leaves those unsigned and Apple's notary rejects the
  upload. CI therefore signs each helper **inside-out first**, then seals the
  bundle. `bun` and `deno` already ship a valid Developer ID signature from
  their publishers and are deliberately left untouched.
* **CI reports what it signed.** The codesign step audits every Mach-O under
  `Contents/Resources` and prints `ok` / `MISS` per file, so an unsigned
  helper is visible in the build log instead of surfacing later as an opaque
  notary rejection.

> **Status: implemented but not yet validated on a macOS runner** — it is
dormant until the secrets are added. Validate one dispatch run before trusting
it; the ad-hoc path remains the fallback and still ships a working app.

## Verifying a build by hand

Two oracles, both runnable against any origin:

```bash
# API surface (134 checks)
TSF_BASE=http://127.0.0.1:3000 bun scripts/e2e-check.ts

# Real browser, real UI (61 checks) — needs `npx playwright install chromium` once
TSF_BASE=http://127.0.0.1:3000 node scripts/e2e-browser/index.mjs
```

Both default to `http://127.0.0.1:3000` and write browser screenshots to
`./qa-shots` (override with `TSF_SHOTS`). Neither is part of the app runtime.

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
| One-command installer | resolves the live release, both DMG URLs return 200 with the expected sizes; platform/arch guards exercised |
| `SHA256SUMS.txt` published | `release` job computes it from the shipped artifacts on every tag |
| Doctor reports honestly | run against a live engine: 3/16 providers, per-provider ok counts, and a real full-length resolve |
| Whole API surface | `scripts/e2e-check.ts` — 134 checks, green against **both** `bun run dev` and the production `standalone` build |
| Whole UI, in a real browser | `scripts/e2e-browser/` — 61 checks in headless Chromium (shell, playback, playlist indicator, engine health, search pagination, AI generator, queue reorder, lyrics, shortcuts, mobile at 390×844 with the byte proxy), green against dev **and** the production `standalone` build. Run: `npx playwright install chromium && node scripts/e2e-browser/index.mjs` |

## In-app diagnostics

Everything the doctor prints is also reachable inside the app: **Sidebar →
Engine health** (`src/components/views/EngineHealthView.tsx`). It renders
`/api/health` as a first-class surface — provider table with cold-down state and
last error, resolve-latency percentiles, a per-provider "who is actually
serving your music" breakdown, the last 20 raw resolves, and the AI gateway
probe.

Two things make it useful rather than decorative:

* **Test a track** calls `/api/stream?id=…&head=1`, which resolves and returns
the `X-Stream-Provider` / `X-Stream-Bitrate` headers *without downloading any
audio* — so you get the same honest verdict as playback, in milliseconds, for
any id (including `saavn-…` catalogue ids).
* **Re-probe** and **purge stream cache** expose the two resolver escape
hatches (`/api/health?fresh=1`, `?purge=1`) that were previously curl-only.

Degradation is labelled, never hidden: full-length = emerald, 30 s preview =
amber, offline synth = slate — the same semantics as the player's source badge.

## Local development (Mac, without CI)

```bash
bun install
bun run build                      # engine → .next/standalone
bash scripts/desktop/prepare-mac-resources.sh x86_64-apple-darwin
bunx tauri dev                     # or: bunx tauri build
```
