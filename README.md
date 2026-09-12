# TSF Music

A Spotify-class music app with **full-length streaming**, AI playlists, lyrics,
queue and library — built as ONE codebase shipping to **macOS, Android and iOS**
via GitHub Actions.

> Everything runs locally: the bundled engine (Next.js standalone server +
> Bun runtime + yt-dlp + POT token provider) powers 100% of the features on
> every platform. No external backend needed.

**Current release: [`v0.4.2`](https://github.com/ranigain2-web/tsf-music/releases/latest)**

| File | Platform | Size |
|---|---|---|
| `TSF-Music-0.4.2-x64.dmg` | **macOS Intel** (MacBook Pro 16" 2019 i9 ✓, macOS 26 Tahoe) | ~287 MB |
| `TSF-Music-0.4.2-arm64.dmg` | macOS Apple Silicon | ~271 MB |
| `TSF-Music-0.4.2-x64.zip` / `-arm64.zip` | macOS, zipped bundle | — |
| `SHA256SUMS.txt` | checksums the installer verifies against | — |
| `app-release-unsigned.apk` | Android 6.0+ | — |
| `tsf-music-ios-unsigned.ipa` | iOS (sideload) | — |

---

# 1 · Install on your Mac — full step-by-step

This is the whole procedure. Nothing here needs an Apple account, Xcode, or the
`TSF-Music-*.dmg` file. Ten minutes, once.

## Step 0 — What you need

- Any Mac, Intel or Apple Silicon, macOS 10.15 or newer.
- Terminal: press `⌘ Space`, type `Terminal`, press Return.
- No Apple Developer account. No $99/year. Nothing to buy.

## Step 1 — Install the app

Copy this **whole line** into Terminal and press Return:

```bash
curl -fsSL https://raw.githubusercontent.com/ranigain2-web/tsf-music/main/desktop/install-macos.sh | bash
```

**What it does, in order** (it prints each stage as it goes):

1. detects Intel vs Apple Silicon and picks the matching DMG;
2. resolves the **newest** release automatically — there is no version to edit;
3. downloads it (~287 MB Intel / ~271 MB Apple Silicon);
4. verifies the SHA-256 against `SHA256SUMS.txt` from the same release;
5. verifies the bundle's CPU architecture actually matches your Mac;
6. quits any running copy and installs to `/Applications` using `ditto`
   (this preserves the code signature — `cp -R` does **not**);
7. clears the Gatekeeper quarantine flag and reports the signature authority
   honestly (it says "ad-hoc" — that is expected, see Step 7);
8. launches the app.

It is **idempotent**: re-running it is a safe upgrade. Options:

| Env var | Effect |
| --- | --- |
| `TSF_TAG=v0.4.2` | install a specific release instead of the newest |
| `TSF_DEST=~/Applications` | install somewhere other than `/Applications` |
| `TSF_NO_LAUNCH=1` | install without opening the app |
| `TSF_FORCE=1` | reinstall even when that version is already present |

**Why this sidesteps Gatekeeper.** The quarantine flag that triggers the block
is applied by **the browser**, not by GitHub. A `curl` download never gets it,
so the app is never quarantined and macOS has nothing to complain about. This
is not a security bypass — the signature is still checked, the file simply
isn't browser-downloaded.

## Step 2 — Confirm there is nothing to approve

```bash
xattr -p com.apple.quarantine "/Applications/TSF Music.app"; echo "exit=$?"
```

| You see | Meaning |
| --- | --- |
| `exit=1`, no value printed | ✅ **correct** — no quarantine flag, nothing to approve |
| a long value like `0083;...;Safari;...` | the app *was* browser-downloaded. Do Step 6. |

Confirm which version is installed, at any time:

```bash
defaults read "/Applications/TSF Music.app/Contents/Info.plist" CFBundleShortVersionString
# → 0.4.2
```

## Step 3 — Launch and use it

Open **TSF Music** from `/Applications` (or Spotlight). The app boots its own
local engine and shows the window once `/api/health` answers — a few seconds on
first run, faster afterwards.

The engine warms itself while it boots (it probes `yt-dlp`, preloads the AI
gateway config, renders the home feed and resolves your three most recent
tracks), so the first thing you tap is served from a warm cache. The sidebar
badge should read **v0.4.2**.

First-run notes:

- Onboarding asks for a name, a bio, artists and genres. Every step saves as
  you go, so an accidental restart does not lose progress.
- On the very first launch a **"What's new"** dialog appears — it is
  once-per-version, not an error. Dismiss it and it will not return.

## Step 4 — Upgrading later (where the prompts used to come back)

Re-run the **exact Step 1 command**. Nothing else changes.

> **The one rule:** always install with the `curl` command in Step 1, never by
> downloading the DMG in Safari/Chrome and double-clicking it.
> The quarantine flag is added by the browser, and installing a **new build**
> means a **new signature**, so macOS asks again from scratch. The same binary
> downloaded two ways behaves two different ways — the difference is the flag,
> not the signature.

## Step 5 — If anything looks wrong: run the doctor

```bash
curl -fsSL https://raw.githubusercontent.com/ranigain2-web/tsf-music/main/desktop/tsf-doctor.sh | bash
```

It reports, in plain text:

- app version and signature authority;
- quarantine state;
- engine health, and every streaming provider's **live / cooling-down** state;
- resolve latency percentiles (`p50` / `p95`);
- then it resolves a real track and tells you plainly whether you got
  **full-length audio**, a **30 s preview**, or the **offline synth**.

## Step 6 — If you ever *did* install from a browser DMG

You do **not** need to reinstall. One time only:

```bash
xattr -dr com.apple.quarantine "/Applications/TSF Music.app"
```

Or double-click **`First-Run-MacOS.command`** (shipped inside the DMG), which
does the same thing with a friendly explanation. After that the app launches
normally — until you install a *new build*, at which point the same one-time
step applies again. That repetition is exactly what the `curl` path removes.

## Step 7 — Should you pay for the $99/year Apple Developer Program?

| | free path (Steps 1–6) | Apple Developer Program ($99/yr) |
| --- | --- | --- |
| Your own installs | zero prompts | zero prompts |
| Installing from a browser DMG | one one-time approval | zero prompts |
| Sending the app to someone else | they repeat Step 1, or Step 6 | zero prompts for them too |
| Ongoing upkeep | none | certificate + app-specific password, renewed yearly |
| Notarization pipeline | dormant in CI | runs on every tag |

**If you are the only user and you install with Step 1, the paid option buys
you nothing you will notice.** It starts being worth paying the moment you want
other people to download a DMG in their browser and have it just open. The
notarization pipeline is already written and is validated to the extent it can
be without secrets, but it has **never executed** — budget one or two iterations
if you ever turn it on.

## Step 8 — Every command in one place

```bash
# install / upgrade
curl -fsSL https://raw.githubusercontent.com/ranigain2-web/tsf-music/main/desktop/install-macos.sh | bash

# diagnostics (what to send back if something is wrong)
curl -fsSL https://raw.githubusercontent.com/ranigain2-web/tsf-music/main/desktop/tsf-doctor.sh | bash

# is it quarantined?  (exit=1 and no value == healthy)
xattr -p com.apple.quarantine "/Applications/TSF Music.app"; echo "exit=$?"

# installed version
defaults read "/Applications/TSF Music.app/Contents/Info.plist" CFBundleShortVersionString

# one-time fix, only if you installed from a browser DMG
xattr -dr com.apple.quarantine "/Applications/TSF Music.app"

# engine log (the last lines name the real cause of any start failure)
tail -40 ~/Library/Logs/com.tsfmusic.desktop/server.log

# POT token provider log
tail -40 ~/Library/Logs/com.tsfmusic.desktop/pot-provider.log
```

## What to check after installing — and what to send back

Run this checklist once after your first install. It takes two minutes and it
tells us everything without needing another round of questions.

| # | Check | Where | Expected |
|---|---|---|---|
| 1 | Version | sidebar bottom badge | `v0.4.2` |
| 2 | Engine is up | the app window opened at all | it health-gates on `/api/health`, so a visible window means the engine answered. The doctor (Step 5) prints the health block explicitly |
| 3 | Diagnostics exist | sidebar → **Engine health** | provider table with names, latencies, a "live" count |
| 4 | What you'd actually get | Engine health → **Test playback** with any id | a verdict naming the provider: *full-length* / *30 s preview* / *offline synth* |
| 5 | Real playback | play **Daily Mix 1** | audio starts; the badge under the title is **emerald** for full-length, **amber** for a 30 s preview, **slate** for synth |
| 6 | Something to compare against | Search → any song you know | if the catalog has it, expect *full-length* |
| 7 | Whole-health snapshot | Step 5 doctor | the block below |

**If anything looks wrong, send me exactly this:**

```bash
# 1) the doctor's full output
curl -fsSL https://raw.githubusercontent.com/ranigain2-web/tsf-music/main/desktop/tsf-doctor.sh | bash

# 2) the engine log tail
tail -60 ~/Library/Logs/com.tsfmusic.desktop/server.log

# 3) your versions
defaults read "/Applications/TSF Music.app/Contents/Info.plist" CFBundleShortVersionString
sw_vers; uname -m
```

Then add three words of context: **which track** you played, **what colour badge**
appeared, and **which provider** the doctor named. That combination pinpoints
the cause immediately.

## macOS troubleshooting

**"The engine failed to start" / "did not become healthy within 120s"**

The error screen itself shows the engine's last log lines, and the app strips
the quarantine flag from its own bundled binaries at every boot — so the most
common cause (macOS silently killing the bundled `bun` / `yt-dlp` helpers that
were never un-quarantined) is auto-healed. If it still fails:

1. Press **Retry** on the error screen (it re-runs the self-heal and boot).
2. Read the two log files above — the last lines name the cause.
3. Re-run `First-Run-MacOS.command` (from the DMG), then Retry.
4. Confirm the app is in `/Applications`, not still on the DMG.
5. Still stuck? Send the doctor output plus those log tails.

**"The Mac app feels slower than the phone"**

This is by design, and it is the difference the Mac shell will always have: the
**phone talks to an always-running server** whose caches, provider probes and
process caches are already warm, while **the Mac app boots its own private
engine on every launch** — its own Bun + Next + POT provider + yt-dlp — and
starts cold. Measured on the exact engine the app bundles: a warmed track
resolves in **6–9 ms** versus **~22 s** cold.

What v0.4.1/v0.4.2 do about it:

- The recursive `xattr -r` quarantine walk over the whole bundle no longer runs
  on a clean install (it used to stat every file before the engine started).
- On boot the engine warms the `yt-dlp` binary, the AI gateway config, the home
  feed and the stream resolver for your most recent tracks — so your first tap
  after launch is served from a warm cache.

Tuning flags for the desktop shell:

| Env var | Effect |
| --- | --- |
| `TSF_WARMUP_DEBUG=1` | log each warm-up step into `server.log` (four lines: `yt-dlp`, `ai-config`, `home-feed`, `recent-streams`) |
| `TSF_NO_WARMUP=1` | disable the whole boot warm-up |
| `TSF_NO_STREAM_WARM=1` | disable only the recent-track stream warm |

**Where data lives**

| What | Where |
| --- | --- |
| Engine log | `~/Library/Logs/com.tsfmusic.desktop/server.log` |
| POT provider log | `~/Library/Logs/com.tsfmusic.desktop/pot-provider.log` |
| Database (library, playlists, history) | `~/Library/Application Support/com.tsfmusic.desktop/tsf.db` |
| Engine port | `127.0.0.1:8137–8148` (first free) |
| POT provider port | `127.0.0.1:4416` |

**In-app diagnostics.** The sidebar has **Engine health** — provider table with
latencies and cooldown state, resolve percentiles, the full fallback order, and
a **Test playback** box: paste any video id (or a `saavn-…` id) and it tells you
exactly what you would get, without downloading audio. **Taste DNA** shows and
lets you correct what the engine has learned about you.

---

# 2 · Install on Android

The APK is a native shell (Capacitor + a MediaSession plugin for lockscreen
controls) that **loads the app from a server URL baked in at build time**. It is
not a standalone build — the phone must be able to reach that server.

1. On the phone, allow installing from unknown sources, then open
   `app-release-unsigned.apk`.
2. The build points at the URL from the `TSF_SERVER_URL` repository secret
   (default `http://10.125.110.1:3000`). To pick your own server, run the
   **Build Android APK** workflow via *Actions → Run workflow* and fill in the
   `server_url` input with e.g. `http://<your-mac-lan-ip>:3000`.
3. The phone and the server must be on the same network, and the server must be
   running. This is exactly why the phone *feels* faster: it is talking to an
   already-warm server rather than booting its own engine.

# 3 · Install on iOS

`tsf-music-ios-unsigned.ipa` is unsigned, so it needs a sideloading tool
(AltStore, Sideloadly, TrollStore on supported versions). Same server-URL rule
as Android — the `TSF_SERVER_URL` secret (or the workflow's `server_url` input)
decides which server the shell loads.

---

# 4 · Architecture

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

Full-length streaming is a ranked provider race: JioSaavn (320 kbps, catalog
ids) → yt-dlp (+ BotGuard PO tokens from the bundled POT provider) → InnerTube
clients → Piped/Invidious relays → iTunes 30 s preview → offline synth. It
always reports honestly which one served you (`X-Stream-Provider`,
`X-Stream-Bitrate`), and the UI badges it: emerald = full-length, amber = 30 s
preview, slate = synth. Nothing ever silently pretends to be full-length.

# 5 · CI/CD

Three workflows build every push and publish on `v*` tags:

- **macOS App** (`.github/workflows/macos.yml`) — static gates → playback
  gauntlet probe (20-track set, ≥50 % full-length gate) → Tauri builds for
  x64 + arm64 → ad-hoc codesign (Developer ID + notarization when the secrets
  exist) → DMG + zip artifacts → `SHA256SUMS.txt` → tagged release.
- **Build Android APK** — Gradle debug + (optionally signed) release.
- **Build iOS IPA (unsigned)** — xcodebuild → Payload → IPA.

### The two oracles

Everything the app promises is checked by two runnable suites. Both take
`TSF_BASE` and default to `http://127.0.0.1:3000`.

```bash
# whole API surface — 134 checks
bun scripts/e2e-check.ts

# the real UI in a real browser — 61 checks (needs a browser once)
npx playwright install chromium
node scripts/e2e-browser/index.mjs
```

The browser suite covers cold boot, real audio playback, the sidebar
playlist-playing indicator, the Engine Health view and its live probe, search
with deep pagination, the AI playlist generator, queue keyboard reorder, lyrics,
the `?` shortcuts overlay, and mobile at 390×844 including the byte-proxy
streaming path. Screenshots go to `./qa-shots` (`TSF_SHOTS` to override).
Both suites are green against `bun run dev` **and** against the production
`.next/standalone` engine — the exact artifact the Mac app bundles.

# 6 · Development

```bash
bun install
bun run db:push      # create/refresh the local SQLite schema
bun run dev          # http://localhost:3000
bun run build        # production standalone build
bun run lint         # eslint
bunx tsc -p tsconfig.ci.json --noEmit
```

The macOS shell: `bun run desktop:prepare` then `bunx tauri build`.
Deep-dive notes on the native shells, signing internals and the engine bundle
live in [`desktop/README-MACOS.md`](desktop/README-MACOS.md).

## Release procedure

1. Bump the version in all five places: `package.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`
   (`tsf-music-desktop`), and `android/app/build.gradle`
   (`versionName` + `versionCode`). The in-app version badge reads
   `package.json` directly, so it cannot drift.
2. Add a `WHATS_NEW` entry in `src/components/whats-new/whats-new.ts`.
3. Commit, push, then `git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z`.
4. All three workflows build and publish the release; the macOS job runs the
   playback probe first, so a broken resolver fails the build instead of
   shipping.
