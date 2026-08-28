# TSF MUSIC — FULL LOCAL MOBILE QA PASS (Android + iOS)
# Hand this file to the local coding model running on the Mac.

You are the local test engineer for **TSF Music**, a single-user Spotify-style
music streaming app. Your job in this session: **run a complete, evidence-based
QA pass of the mobile-web build on this Mac, one Android phone, and one
iPhone**, then produce a structured report. The owner will paste that report
back to the lead agent, who will fix any bugs BEFORE any native (APK/Xcode)
work begins.

**HARD RULES — read first**
1. **DO NOT build any native app / APK / Xcode project.** That phase is locked
   until the owner gives an explicit PASS. This session is web-only testing.
2. **DO NOT refactor, "improve", or rewrite application code.** You may fix
   trivial environment issues (missing deps, wrong Node version) only.
   If you find a bug: document it precisely (symptom, repro steps, suspected
   file) — do not perform surgery.
3. Everything runs on the LOCAL NETWORK. No cloud deploys, no public tunnels
   (ngrok etc.). Tailscale is allowed only in optional Phase D.
4. Two things need the owner's hands: physically testing on the two phones.
   For those, print a clean checklist, let the owner execute and dictate
   results, and record them. Automate everything on the Mac side yourself.
5. Be skeptical. Verify with evidence (command output, HTTP status codes,
   screenshots). Never mark PASS on assumption.

---

## 0. Project location & known-good facts (do not re-litigate these)

**Location.** The latest build is `tsf-music.zip` (contains the mobile sprint:
proxy streaming, MediaSession, mobile UI — packaged 2026-08-27). Ask the owner
which case applies:
- (a) Owner already unzipped it → use that folder (prefer a path WITHOUT
  spaces, e.g. `~/Downloads/tsf-music-mobile`).
- (b) Only the older folder `/Users/tohidshaikh/Downloads/tsf-music 3`
  exists → it may lack the mobile sprint. Unzip the new `tsf-music.zip` to
  `~/Downloads/tsf-music-mobile` and use that. (The old folder's space-in-path
  is exactly why dev scripts use `--webpack`; still avoid spaces if you can.)

In instructions below, `$PROJECT` = the chosen project root. All commands:
`cd "$PROJECT"` first and quote the path always.

**Facts already verified on this exact Mac + Jio home IP (2026-08-27):**
- `innertube-IOS` is the ONLY full-length audio provider that works from this
  network. ANDROID_VR / IOS_MUSIC / ANDROID_MUSIC all return LOGIN_REQUIRED,
  and all public Piped/Invidious instances are dead. Do NOT retry them.
- Full-length playback verified server-side for 4/4 tracks — international
  (Ed Sheeran) AND Indian (Bollywood) — correct durations, `audio/mp4`, HTTP 206.
- Fallback chain when YouTube fails: iTunes 30-second preview → built-in synth
  audio. These are DEGRADED modes, not bugs.
- `GET /api/stream?...&proxy=1` = same-origin proxy mode: the **Mac** resolves
  AND fetches the googlevideo bytes; the phone only talks to the Mac over
  Wi-Fi. Touch devices add `&proxy=1` automatically. This kills CORS /
  redirect / IP-bound-signature problems for phones.
- Stream cache honors googlevideo's `expire` signature parameter.
  Circuit breaker: a failing provider is skipped for 10 minutes.
- `?fresh=1` on /api/stream bypasses cache (stale-URL self-heal).
- Known past bug: mini-player showing 0:00 = stale IP-bound cache rows →
  fix is `npm run db:clear-cache` (never edit code for this).
- Dev script: `npm run dev` = `prisma db push --accept-data-loss && next dev
  --webpack -p 3000`. Use exactly this (NOT dev:turbo — the path/Turbopack
  issue). A stray `~/package.json` in the HOME dir previously confused the
  toolchain — if weird resolution errors appear, check for it and report.
- Stack: Next.js 16 (webpack), TypeScript, Tailwind v4, Prisma + SQLite
  (`db/custom.db`), no login, dark theme, English UI.

---

## Phase A — Bring-up on the Mac (automate yourself)

A1. `cd "$PROJECT" && node -v` (need ≥ 18.18; recommend 20+). `npm install`.
A2. `npm run dev` in a persistent background process (nohup or a dedicated
    terminal). Wait for "Ready". Note BOTH URLs it prints:
    `http://localhost:3000` and `http://<LAN-IP>:3000`.
A3. LAN IP: `ipconfig getifaddr en0` (fallback en1, or
    `ipconfig getifaddr en0 || ipconfig getifaddr en1`). Record it.
A4. `curl -s http://localhost:3000/api/health` → expect JSON ok.
A5. Mac browser sanity: open `http://localhost:3000`. Confirm onboarding or
    home renders, search returns results, a track plays full-length on the
    Mac itself. If the Mac can't play, STOP — phones won't either; report.
A6. Confirm mobile sprint is present: `ls src/components/shell/MobileNav.tsx
    public/manifest.json` and `rg -n "proxy=1" src/components/player/AudioEngine.tsx`.
    If missing → wrong (old) folder; go back to Location step.

## Phase B — Server-side playback verification (automate yourself, curl)

Use `curl -sS -o /dev/null -w '%{http_code} %{content_type} %{size_download}
%{time_total}\n'`. Test tracks (search first to get videoId:
`curl -s "http://localhost:3000/api/ytm/search?q=<query>" | head -c 2000`):

| # | Category | Query | Expected full duration |
|---|----------|-------|------------------------|
| B1 | International | Ed Sheeran Shape of You | ≈ 4:24 |
| B2 | International | The Weeknd Blinding Lights | ≈ 3:20 |
| B3 | International | Queen Bohemian Rhapsody | ≈ 5:54 |
| B4 | Hindi new | Kesariya Arijit Singh | ≈ 4:28 |
| B5 | Hindi classic | Kishore Kumar Mere Sapno Ki Rani | ≈ 4:25 |
| B6 | South Indian | Naatu Naatu RRR | ≈ 4:05 |
| B7 | Punjabi | AP Dhillon Brown Munde | ≈ 4:07 |
| B8 | Regional other | Ilaiyaraaja or A.R. Rahman instrumental | any full length |

For EACH track do B9–B12 (record a table row per track):
- B9 Search resolves: has videoId + title + duration.
- B10 `GET /api/stream?id=<id>&proxy=1` → HTTP 206, `audio/mp4`, bytes flow.
- B11 Range works: same URL with `-H "Range: bytes=0-999"` → 206 with
  `Content-Range: bytes 0-999/...` (phones REQUIRE this).
- B12 `GET /api/stream?id=<id>&fresh=1&proxy=1` (bypass) → still 206.
- B13 Cross-origin sanity (desktop path): `GET /api/stream?id=<id>` without
  proxy → expect a 307 redirect to a googlevideo host (this is correct).
- B14 Fallback chain: search a nonsense string (e.g. `zzqxv noop festival`)
  → app must NOT crash; expect either empty results or preview/synth fallback
  on play. Record which layer fired.
- B15 Cache behavior: replay B4 twice; second response should be
  noticeably faster (cache hit). Then `npm run db:clear-cache` → confirm
  command exits 0.
- B16 Download route: `curl -sI "http://localhost:3000/api/download?id=<B1 id>"`
  → 200 with audio content-type (optional feature check).
- B17 **SponsorBlock**: `curl -s "http://localhost:3000/api/sponsorblock?id=JGwWNGJdvx8&dur=263"`
  → 200 JSON with a `segments` array; for this video expect at least one
  `music_offtopic` segment. Also `curl -s ".../api/sponsorblock?id=zzzznotreal1"`
  → `{"segments":[]}`. Any failure here must NOT 5xx.
- B18 **Provider chain**: `curl -s localhost:3000/api/health | grep -o 'innertube-visionos[^}]*'`
  after playing one track — record whether `innertube-visionos` appears
  (new 2026-08 client; it may resolve on residential IPs where IOS does).
- B19 **Search quality**: `curl -s "localhost:3000/api/ytm/search?q=Kesariya&limit=20"`
  → ALL song rows in the top 12 have `duration > 0`, and NO podcast/
  episode rows (no "Controversy", "Modi", "textile" titles).

## Phase C — Real-device tests (owner executes; you record)

Print this section for the owner. BOTH phones must be on the **same Wi-Fi as
the Mac**. Android = Chrome. iPhone = Safari (iOS 15.4+; record exact iOS
version). They open `http://<LAN-IP>:3000`.

If no iPhone is available, secondary option: Xcode Simulator
(`xcrun simctl openurl booted http://<LAN-IP>:3000`) covers Safari WebKit
playback quirks — but there is NO lock screen in the simulator, so mark those
rows N/A and say so in the report.

### C1 — Core playback (both phones, each item: PASS/FAIL + note)
| # | Test |
|---|------|
| C1.1 | App loads over LAN IP; onboarding or home shows (first run = onboarding flow works) |
| C1.2 | Search "Kesariya" → results appear ≤ 5s |
| C1.3 | Tap a row → music starts ≤ 3s; duration shows a REAL number (not 0:00) |
| C1.4 | Play an international track (Shape of You) — full song plays |
| C1.5 | Play a Hindi track (Kesariya) — full song plays |
| C1.5b | **Skip segments**: play "Shape of You" (the video version) → if the
  track has a talking intro, the playhead jumps past it automatically;
  Library → Playback tab shows the "Skip non-music segments" switch ON |
| C1.6 | Play a regional track (Naatu Naatu / Brown Munde) — plays |
| C1.7 | Scrub/seek forward mid-song → audio jumps, keeps playing |
| C1.8 | Next / Previous buttons work |
| C1.9 | When a track ENDS (screen ON), next track auto-advances |
| C1.10 | Mini-player visible; tap it → full-screen Now Playing opens |
| C1.11 | Swipe DOWN on full-screen player closes it (music keeps playing) |
| C1.12 | Queue drawer opens from full-screen; tapping a queue track plays it |
| C1.13 | Like a song → heart persists after app reload |
| C1.14 | Create a playlist, add 3 songs (mix Indian + international), play it |
| C1.15 | AI feature: generate one playlist (e.g. mood) → it creates + plays |
| C1.16 | Lyrics view opens for a popular track |
| C1.17 | Bottom nav tabs switch correctly (Home/Search/Library) |
| C1.18 | No layout breakage: notch/Dynamic Island, home-indicator bar, rotation |

### C2 — Background & lock screen (the critical mobile matrix)
| # | Test | Android expected | iOS expected |
|---|------|------------------|--------------|
| C2.1 | Play → lock screen → music continues | yes | yes |
| C2.2 | Lock-screen shows title/artist/artwork | notification (~5s) | lock card |
| C2.3 | Lock-screen play/pause works | yes | yes |
| C2.4 | Lock-screen NEXT works | yes | yes |
| C2.5 | Lock-screen scrubber/seek works | yes | yes |
| C2.6 | Screen OFF, let track END → next track starts by itself | yes | **KNOWN LIMIT: may stall until screen wake — record exact behavior + iOS version; this is EXPECTED, not a bug** |
| C2.7 | Background the browser (switch apps) → music continues | yes | yes |
| C2.8 | Incoming phone call → audio pauses → resumes after call | pause/resume | pause/resume |

### C3 — Home-screen / PWA
| # | Test | Expected |
|---|------|----------|
| C3.1 | Android: menu → "Add to Home screen" → launches | shortcut, full-screen-ish; NOTE: real PWA install needs HTTPS (Phase D) — not a bug |
| C3.2 | iOS: Share → "Add to Home Screen" → launches standalone (no Safari bars) | yes (works over http) |
| C3.3 | iOS home-screen app backgrounded → audio keeps playing | yes (iOS ≥ 15.4) |

### C4 — Network & resilience
| # | Test | Expected |
|---|------|----------|
| C4.1 | Mid-song, turn phone Wi-Fi OFF (cellular) → what happens? | Playback stalls/buffers — phone can no longer reach the Mac. NOT a bug; record how UI behaves (graceful?) |
| C4.2 | Wi-Fi back ON → tap play → recovers | yes |
| C4.3 | Kill `npm run dev` on Mac mid-play → UI shows error, no white-screen crash | graceful error |
| C4.4 | Restart dev server → reload app → likes/playlists/history still there (SQLite persisted) | yes |

### C5 — Soak test (both phones)
Play a mixed queue (≥ 6 songs, Indian + international) for **30 minutes**,
screen mostly off, occasionally skip. Record: any stall, any 0:00, any
notification/lock-screen glitch, which track + timestamp.

## Phase D — OPTIONAL (only after C passes): HTTPS + real Android PWA install
- Path 1 (also works away from home): install Tailscale on Mac + phones,
  `tailscale up`, enable HTTPS certs in admin console, browse the tailscale
  hostname. Then Chrome → "Install app" appears (real PWA).
- Path 2 (LAN only): `brew install mkcert nss && mkcert -install && mkcert
  <LAN-IP>` then serve via Caddy with those certs in front of port 3000.
  Android will trust it; install PWA from the https URL.
- Record whether install + offline-shell + notification survive.

## Phase E — Performance notes (record numbers)
- Cold app load time on each phone (stopwatch).
- Tap-to-sound latency for a cached vs fresh track.
- 10 rapid track switches in a row → any 403/404/throttle? (circuit breaker
  and cache should absorb; note anything weird).
- Mac resource use during soak: `top -l 1 | head -12` (node CPU/RSS).

## Phase F — REPORT FORMAT (produce exactly this)

```
# TSF Music — Mobile QA Report (<date>)
Environment: Mac IP ___, Android <model/OS/Chrome ver>, iPhone <model/iOS ver>, project path ___
## A/B results (server-side): table — track, search OK, proxy 206, Range 206, fresh 206, notes
## C1 (per phone): C1.1–C1.18 PASS/FAIL + note
## C2 (per phone): C2.1–C2.8 + exact iOS screen-off auto-advance behavior
## C3/C4/C5 results
## Bugs found: numbered list — each with: repro steps, expected vs actual, evidence (screenshot paths), suspected file/function, severity (blocker/major/minor)
## Degradations observed: any track that fell back to 30s preview/synth (list queries)
## Final verdict: READY FOR NATIVE PHASE / NOT READY (with one-line reason)
```
Save the report to `$PROJECT/QA-REPORT.md`, plus phone screenshots into
`$PROJECT/qa-evidence/`. Tell the owner to send the whole report back to the
lead agent. Do not summarize away failures — the lead agent needs raw truth.

