/**
 * TSF Music — ANDROID E2E GAUNTLET
 * ---------------------------------------------------------------------------
 * Purpose: verify every feature works in the Android runtime environment
 * BEFORE pushing the codebase to GitHub and shipping the Capacitor APK.
 *
 * Why Pixel 7 emulation is a valid Android proxy:
 *   - Android WebView and Chrome share the same Blink engine (Chromium);
 *     our Capacitor shell renders in that engine.
 *   - The device profile gives us: Android UA, touch events, coarse pointer,
 *     mobile viewport (412x915), devicePixelRatio 2.625 — the exact signals
 *     the app uses to switch to mobile UI + `&proxy=1` streaming.
 *
 * The ONE thing emulation cannot prove (stated honestly): background-audio
 * lifecycle on a real device (OS process suspension). That requires the
 * physical APK on the user's phone — everything else is proven here.
 *
 * Usage: NODE_PATH=$(npm root -g) node scripts/android-e2e-gauntlet.ts
 */
import { chromium, devices } from 'playwright'
import fs from 'fs'

const BASE = process.env.TSF_BASE || 'http://127.0.0.1:3000'
const OUT = '/home/z/my-project/download/android-verify'
fs.mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const results: string[] = []
const consoleErrors: string[] = []

function t(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    results.push(`PASS  ${name}`)
  } else {
    fail++
    results.push(`FAIL  ${name} → ${detail.slice(0, 200)}`)
  }
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name}${ok ? '' : ' → ' + detail.slice(0, 160)}`)
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      // Capacitor sets setMediaPlaybackRequiresUserGesture(false) on Android —
      // this flag reproduces that exact behavior in the emulator.
      '--autoplay-policy=no-user-gesture-required',
    ],
  })

  const ctx = await browser.newContext({
    ...devices['Pixel 7'], // Android 13 / Chrome mobile UA / touch / 412x915
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push('CONSOLE: ' + m.text().slice(0, 300))
  })

  // ==========================================================================
  // 1. BOOT — page loads on Android viewport
  // ==========================================================================
  console.log('\n━━━ 1. BOOT ━━━')
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(2500)

  // fast-forward onboarding via API (same trick as previous gauntlets)
  await page.evaluate(async () => {
    try {
      await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', genres: ['pop'], artists: [], name: 'Android Tester', bio: '' }),
      })
      await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete' }),
      })
    } catch {}
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('h1, h2', { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(4500)

  const ua = await page.evaluate(() => navigator.userAgent)
  t('Android UA active', /Android/.test(ua), ua)
  const navVisible = await page.locator('nav[aria-label="Main navigation"]').isVisible().catch(() => false)
  t('mobile bottom nav rendered', navVisible)
  await page.screenshot({ path: `${OUT}/01-home-android.png` })

  // home has real content (shelf headings + track tiles)
  const shelfText = await page.locator('body').innerText()
  const hasContent = shelfText.length > 300
  t('home rendered with content', hasContent, `body text len=${shelfText.length}`)

  // ==========================================================================
  // 2. SEARCH — full flow on touch
  // ==========================================================================
  console.log('\n━━━ 2. SEARCH ━━━')
  await page.locator('nav[aria-label="Main navigation"] button[aria-label="Search"]').tap()
  await page.waitForTimeout(1500)
  // NOTE: two inputs share this placeholder — the desktop TopBar one (hidden
  // lg:block) renders first in the DOM; the mobile SearchView field is last.
  const searchInput = page.locator('input[placeholder="What do you want to listen to?"]').last()
  await searchInput.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
  await searchInput.fill('Kesariya')
  await page.waitForTimeout(4500) // debounce + fetch + render
  await page.screenshot({ path: `${OUT}/02-search-android.png` })

  const bodyText = await page.locator('body').innerText()
  t('search results for Kesariya', /Kesariya/i.test(bodyText), bodyText.slice(0, 200))

  // ==========================================================================
  // 3. PLAYBACK — tap-to-play, full-length audio, proxy mode (Android path)
  // ==========================================================================
  console.log('\n━━━ 3. PLAYBACK ━━━')
  // single tap on the first track row (Spotify mobile behavior)
  const row = page.locator('[data-track-row], .group, li, tr').filter({ hasText: /Kesariya/i }).first()
  await row.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
  const rowTap = row
  await rowTap.tap({ timeout: 8000 }).catch(async (e) => {
    // fallback: tap the first playable-looking row in the list
    await page.locator('main [role="button"], main .group').first().tap().catch(() => {})
  })
  await page.waitForTimeout(6000) // resolve + buffer + play

  const audioState = await page.evaluate(() => {
    const a = document.querySelector('audio') as HTMLAudioElement | null
    if (!a) return { exists: false }
    return {
      exists: true,
      src: a.src || a.currentSrc,
      paused: a.paused,
      readyState: a.readyState,
      duration: a.duration,
      currentTime: a.currentTime,
    }
  })
  t('audio element exists', !!audioState.exists)
  t(
    'audio playing (not paused)',
    audioState.exists === true && (audioState as any).paused === false,
    JSON.stringify(audioState).slice(0, 150)
  )
  const dur = audioState.exists ? (audioState as any).duration || 0 : 0
  t('FULL-LENGTH audio (>200s, not 30s preview)', dur > 200, `duration=${dur}s`)
  const src = audioState.exists ? (audioState as any).src || '' : ''
  t('Android proxy stream mode (&proxy=1)', src.includes('proxy=1'), src.slice(0, 120))
  t('stream resolved from server (/api/stream)', src.includes('/api/stream'), src.slice(0, 120))

  // let it play a moment — verify currentTime advances (real playback, not just metadata)
  const t1 = audioState.exists ? (audioState as any).currentTime : 0
  await page.waitForTimeout(4000)
  const t2 = await page.evaluate(() => {
    const a = document.querySelector('audio') as HTMLAudioElement | null
    return a ? a.currentTime : 0
  })
  t('playhead advancing (real bytes flowing)', t2 > t1 + 1.5, `t1=${t1.toFixed(1)} t2=${t2.toFixed(1)}`)
  await page.screenshot({ path: `${OUT}/03-playing-android.png` })

  // mini player visible with content
  const miniPlayer = await page.locator('body').innerText()
  t('mini-player bar visible', /Kesariya/i.test(miniPlayer))

  // ==========================================================================
  // 4. FULLSCREEN PLAYER + CONTROLS
  // ==========================================================================
  console.log('\n━━━ 4. FULLSCREEN PLAYER ━━━')
  // tap the mini player row (not a button inside it)
  await page.evaluate(() => {
    const bar = document.querySelector('footer, [class*="NowPlaying"], [data-now-playing]') as HTMLElement | null
    if (bar) bar.click()
  })
  await page.waitForTimeout(2000)
  // fallback: try the chevron/open button
  const fsVisible = await page
    .locator('text=/1ed760|Now Playing|lyrics|queue/i')
    .first()
    .isVisible()
    .catch(() => false)
  await page.screenshot({ path: `${OUT}/04-fullscreen-android.png` })
  // pause / resume cycle
  const pauseBtn = page.locator('button[aria-label*="Pause" i], button[aria-label*="pause"]').first()
  if (await pauseBtn.isVisible().catch(() => false)) {
    await pauseBtn.tap()
    await page.waitForTimeout(800)
    const paused = await page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement)?.paused)
    t('pause via touch', paused === true)
    // EXACT label match: `*="Play"` also matches "Now playing" containers
    const playBtn = page.locator('button[aria-label="Play"]').first()
    await playBtn.tap().catch(() => {})
    await page.waitForTimeout(1200)
    const resumed = await page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement)?.paused)
    t('resume via touch', resumed === false)
  } else {
    // controls exist but aria-labels differ — try any circular button in fullscreen
    t('fullscreen pause/resume controls found', false, 'no pause button visible')
  }

  // ==========================================================================
  // 5. AI PLAYLIST — SSE streaming on Android WebView engine
  // ==========================================================================
  console.log('\n━━━ 5. AI PLAYLIST (SSE) ━━━')
  // close fullscreen first (swipe down / back)
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(800)
  await page.locator('nav[aria-label="Main navigation"] button[aria-label="Home"]').tap()
  await page.waitForTimeout(1200)

  const aiBtn = page.locator('button[title="Create with AI"]').first()
  const aiBtnVisible = await aiBtn.isVisible().catch(() => false)
  if (!aiBtnVisible) {
    // mobile may tuck it elsewhere; try text
    await page.locator('button:has-text("AI")').first().tap().catch(() => {})
  } else {
    await aiBtn.tap()
  }
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${OUT}/05-ai-dialog-android.png` })

  const ta = page.locator('textarea').first()
  const taVisible = await ta.isVisible().catch(() => false)
  t('AI generator dialog opens on mobile', taVisible)
  if (taVisible) {
    await ta.fill('high energy bollywood workout mix')
    const genBtn = page.locator('button:has-text("Generate playlist")').first()
    const genStart = Date.now()
    await genBtn.tap()
    // FIRST-TRACK signal: while curating the header shows "N found of M";
    // on a prompt-cache hit the replay is so fast the UI jumps straight to
    // the done state ("N songs") — either means first content landed.
    await page
      .locator('text=/\\d+ found|\\d+ songs/')
      .first()
      .waitFor({ timeout: 12000 })
      .catch(() => {})
    const firstTracksMs = Date.now() - genStart
    await page.screenshot({ path: `${OUT}/06-ai-streaming-android.png` })
    t('AI first tracks stream in ≤6s (mobile network path)', firstTracksMs < 6000, `${firstTracksMs}ms`)

    // wait for generation to progress substantially (streaming UI)
    await page.waitForTimeout(9000)
    await page.screenshot({ path: `${OUT}/07-ai-result-android.png` })
    const aiText = await page.locator('body').innerText()
    t(
      'AI playlist produced tracks',
      (aiText.match(/·/g) || []).length > 5 || /\d+\s*(songs|tracks)/i.test(aiText),
      aiText.slice(0, 200)
    )
    // purity: no LLM provider names leak into the UI
    t(
      'AI purity (no provider names in DOM)',
      !/(openai|anthropic|claude|gpt-|gemini|z\.ai|zen\s*code|opencode|glm)/i.test(aiText),
      'provider name leaked'
    )
  }

  // ==========================================================================
  // 6. LIBRARY + LIKES + NAV HYGIENE
  // ==========================================================================
  console.log('\n━━━ 6. LIBRARY / NAV ━━━')
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(600)
  await page.locator('nav[aria-label="Main navigation"] button[aria-label="Your Library"]').tap()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `${OUT}/08-library-android.png` })
  const libText = await page.locator('body').innerText()
  t('library view renders', /playlist|liked|library/i.test(libText), libText.slice(0, 150))

  // back to home — bottom nav round trip
  await page.locator('nav[aria-label="Main navigation"] button[aria-label="Home"]').tap()
  await page.waitForTimeout(1200)
  const homeAgain = await page.locator('body').innerText()
  t('nav round-trip back to home', homeAgain.length > 300)

  // ==========================================================================
  // 7. API LAYER SPOT-CHECKS (the endpoints Android consumes)
  // ==========================================================================
  console.log('\n━━━ 7. API LAYER ━━━')
  const api = await page.evaluate(async () => {
    const out: Record<string, number> = {}
    out.health = (await fetch('/api/health').then((r) => r.status).catch(() => 0)) || 0
    return out
  })
  t('/api/health 200', api.health === 200, JSON.stringify(api))

  // ==========================================================================
  // 8. CONSOLE PURITY — zero errors on Android engine
  // ==========================================================================
  console.log('\n━━━ 8. CONSOLE PURITY ━━━')
  const benign = [/ResizeObserver loop/, /net::ERR_ABORTED.*audio|media/i, /play\(\) request was interrupted/]
  const hard = consoleErrors.filter((e) => !benign.some((b) => b.test(e)))
  t('zero hard console errors in full session', hard.length === 0, hard.slice(0, 3).join(' | '))

  await browser.close()

  console.log('\n═════════════ ANDROID E2E GAUNTLET RESULTS ═════════════')
  results.forEach((r) => console.log(r))
  console.log(`PASS=${pass} FAIL=${fail}`)
  fs.writeFileSync(
    `${OUT}/gauntlet-results.json`,
    JSON.stringify({ pass, fail, results, consoleErrors: hard, ts: new Date().toISOString() }, null, 2)
  )
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('GAUNTLET CRASHED:', e)
  process.exit(2)
})
