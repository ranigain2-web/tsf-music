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

## Step-by-step install (free path, no Apple account)

This is the whole procedure for the ad-hoc-signed release. Ten minutes, once.

### Step 0 — What you need

- Any Mac (Intel or Apple Silicon), macOS 10.15 or newer.
- Terminal — press `⌘ Space`, type `Terminal`, press Return.
- No Apple Developer account. No $99/year. Nothing to buy.

### Step 1 — Install the app

Copy this whole line into Terminal and press Return:

```bash
curl -fsSL https://raw.githubusercontent.com/ranigain2-web/tsf-music/main/desktop/install-macos.sh | bash
```

It prints what it is doing at each stage: picking your architecture, finding
the newest release, downloading (~290 MB Intel / ~273 MB Apple Silicon),
verifying the checksum, verifying the bundle is really built for your CPU,
installing to `/Applications`, then launching the app. It takes a few minutes
on a normal connection.

### Step 2 — Confirm there is nothing to approve

Check the app's signature and quarantine state at any time:

```bash
xattr -p com.apple.quarantine "/Applications/TSF Music.app"; echo "exit=$?"
```

`exit=1` with no value is the **good** outcome: no quarantine flag, so macOS
has nothing to warn you about. Because the file was created by `curl` and not
by your browser, macOS never attaches the flag in the first place.

### Step 3 — Use the app

Launch **TSF Music** from `/Applications` (or Spotlight). It boots its own
local engine and opens when the engine answers its health check — a few
seconds on first run, faster afterwards. The first thing you tap is already
warm: the engine probes `yt-dlp`, the AI gateway config and your three most
recent tracks while it boots.

### Step 4 — Upgrading later (this is where the prompts used to come back)

Re-run the **exact same Step 1 command**. It is idempotent: it finds the newer
release, quits the running copy, replaces it and relaunches. You will not be
asked to approve anything, because again nothing was browser-downloaded.

> The one thing that must not change: always install with the `curl` command,
> never by downloading the DMG in Safari/Chrome and double-clicking it. A
> browser download is what adds the quarantine flag, and installing a **new**
> build means a new signature, so macOS asks again from scratch. Same binary,
> downloaded two ways, behaves two different ways — the difference is the flag,
> not the signature.

### Step 5 — If anything looks wrong

```bash
curl -fsSL https://raw.githubusercontent.com/ranigain2-web/tsf-music/main/desktop/tsf-doctor.sh | bash
```

It prints the app version, signature authority, quarantine state, engine
health, every streaming provider's live/cooling state, resolve latency
percentiles, and then resolves a real track so you can see plainly whether you
got **full-length audio**, a **30 s preview**, or the **offline synth**.

### Step 6 — If you ever *did* install from a browser DMG

You do not need to reinstall. One time only:

```bash
xattr -dr com.apple.quarantine "/Applications/TSF Music.app"
```

Or double-click `First-Run-MacOS.command` (shipped inside the DMG), which does
the same thing with a friendly explanation. After that, the app launches
normally — until you install a *new build*, at which point the same one-time
step applies. That is exactly the repetition the `curl` path removes.

### Step 7 — What the $99/year option would add

| | free path (above) | Apple Developer Program ($99/yr) |
| --- | --- | --- |
| Your own installs | zero prompts | zero prompts |
| Installing from a browser DMG | one one-time approval | zero prompts |
| Sending the app to someone else | they repeat Step 1 (or Step 6) | zero prompts for them too |
| Ongoing upkeep | none | certificate + app-specific password, renewed yearly |
| Notarization pipeline | dormant in CI | runs on every tag |

If you are the only user and you install with Step 1, the paid option buys you
nothing you will notice. It becomes worth paying when you want other people to
double-click a downloaded DMG and have it just open.

---

### ✅ Recommended: one command, no prompts, no Apple account

Paste this into **Terminal** and press Return:

```bash
curl -fsSL https://raw.githubusercontent.com/ranigain2-web/tsf-music/main/desktop/install-macos.sh | bash
```

That is the whole install. The script:

1. detects Intel vs Apple Silicon and picks the matching DMG;
2. resolves the **newest** release (no version to edit);
3. downloads it and verifies `SHA256SUMS.txt` when the release publishes one;
4. verifies the bundle's CPU architecture actually matches your Mac;
5. quits any running copy and installs to `/Applications` with `ditto`
   (preserves the code signature — `cp -R` does not);
6. clears the Gatekeeper quarantine flag and reports the signature honestly;
7. launches the app.

It is idempotent — re-running it is a safe upgrade. Options:

| Env var | Effect |
| --- | --- |
| `TSF_TAG=v0.4.2` | install a specific release instead of the newest |
| `TSF_DEST=~/Applications` | install somewhere other than `/Applications` |
| `TSF_NO_LAUNCH=1` | install without opening the app |
| `TSF_FORCE=1` | reinstall even when that version is already present |

**Why this sidesteps Gatekeeper:** the quarantine flag that triggers the block
is applied by **the browser**, not by GitHub. A `curl` download never gets it,
so the app is never quarantined and macOS has nothing to complain about. This
is not a security bypass — the signature is still verified, it is simply a
locally-created file rather than a browser-downloaded one.

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
