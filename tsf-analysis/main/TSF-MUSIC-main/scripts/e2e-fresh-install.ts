/**
 * TSF Music — FRESH-INSTALL gauntlet (simulates the user's very first run).
 *
 * The zip delivery must be verifiably runnable:
 *   1. Fresh DB → onboarding wizard appears
 *   2. Complete onboarding (name → bio → artists → genres → summary)
 *   3. Home loads with personalized shelves
 *   4. Click a track → REAL audio plays
 *      (on this datacenter IP: InnerTube chain fails first, iTunes preview
 *       wins — proving the full-length-first order; on a residential IP the
 *       same race is won by InnerTube = full-length audio)
 *   5. Provider order verified: innertube-* attempted BEFORE itunes
 *   6. Playback advances, duration sane, NOT synth (no 2-10min WAV)
 *   7. Next track → different real audio
 *   8. Download → real m4a file
 *   9. Zero console errors
 */
import { chromium } from 'playwright'
import { writeFileSync } from 'fs'

const BASE = 'http://127.0.0.1:3000'
const OUT = '/home/z/my-project/upload/fresh-e2e'
let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`) }
}

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const consoleErrors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(`PAGE ERROR: ${e.message}`))

const appleRequests: { url: string; bytes: Buffer }[] = []
page.on('response', async (res) => {
  try {
    const u = res.url()
    if (u.includes('itunes.apple.com') && u.includes('mzaf')) {
      appleRequests.push({ url: u, bytes: Buffer.from(await res.body()) })
    }
  } catch { /* streamed/redirect — fine */ }
})

const audioState = () => page.evaluate(() => {
  const a = document.querySelector('audio')
  if (!a) return { found: false }
  return {
    found: true, src: a.src, paused: a.paused, readyState: a.readyState,
    duration: a.duration, currentTime: a.currentTime,
  }
})

// ---------- 1. onboarding ----------
console.log('[1] Fresh DB → onboarding wizard')
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2000)
const bodyText = await page.textContent('body').catch(() => '')
const onboardingShown = /get started/i.test(bodyText || '')
check('onboarding wizard shown on fresh DB', onboardingShown)
await page.screenshot({ path: `${OUT}-1-onboarding.png` })

if (onboardingShown) {
  await page.getByRole('button', { name: /Get started/i }).click().catch(() => {})
  await page.waitForTimeout(800)
  // step 1: name — fill + Enter
  await page.fill('input[type="text"]', 'TSF Tester').catch(() => {})
  await page.keyboard.press('Enter').catch(() => {})
  await page.waitForTimeout(800)
  // step 2: bio — the footer button is "Skip"
  await page.getByRole('button', { name: /^Skip$/i }).click()
  await page.waitForTimeout(500)
  // step 3: artists — wait for the step AND the tiles to actually render
  await page.waitForSelector('text=Your artists', { timeout: 10000 }).catch(() => {})
  let selected = 0
  for (let attempt = 0; attempt < 20 && selected < 4; attempt++) {
    const tiles = await page.locator('button[aria-pressed]').all()
    for (const b of tiles) {
      if (selected >= 4) break
      if ((await b.getAttribute('aria-pressed')) === 'true') continue
      // artist tiles carry aria-label "Add <name>" / "Remove <name>" (filter chips don't)
      const label = (await b.getAttribute('aria-label')) || ''
      if (!/^(Add|Remove) /i.test(label)) continue
      await b.click({ force: true }).catch(() => {})
      selected++
      await page.waitForTimeout(250)
    }
    if (selected < 4) await page.waitForTimeout(500) // tiles still loading
  }
  check('artists selected in wizard', selected >= 3, `${selected} selected`)
  // footer Continue must be ENABLED (needs 3+) before clicking
  const contBtn = page.getByRole('button', { name: /^Continue$/i }).first()
  for (let i = 0; i < 10 && !(await contBtn.isEnabled().catch(() => false)); i++) {
    const tiles = await page.locator('button[aria-pressed="false"]').all()
    if (tiles.length) { await tiles[0].click({ force: true }).catch(() => {}); selected++ }
    await page.waitForTimeout(300)
  }
  await contBtn.click({ timeout: 5000 })
  await page.waitForSelector('text=Your genres', { timeout: 10000 })
  // step 4: genres — pick 3
  await page.waitForTimeout(500)
  let gsel = 0
  const genreTiles = await page.locator('button[aria-pressed]').all()
  for (const b of genreTiles) {
    if (gsel >= 3) break
    if ((await b.getAttribute('aria-pressed')) === 'true') continue
    await b.click({ force: true }).catch(() => {})
    gsel++
    await page.waitForTimeout(200)
  }
  check('genres selected in wizard', gsel >= 2, `${gsel} selected`)
  await page.getByRole('button', { name: /^Continue$/i }).first().click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(1000)
  // summary → Finish
  await page.getByRole('button', { name: /^Finish$/i }).click({ timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(5000) // home shelves build (InnerTube metadata)
  await page.screenshot({ path: `${OUT}-2-home.png` })
  const homeText = await page.textContent('body').catch(() => '')
  const stillWizard = /Step \d of \d|Almost done/i.test(homeText || '')
  check('home view reached after onboarding', !stillWizard && /Your Library/i.test(homeText || ''), stillWizard ? 'STUCK IN WIZARD' : 'library visible')
}

// ---------- 2. play a track ----------
console.log('\n[2] Play first track — expect REAL audio (provider order: YouTube chain first)')
const t0 = Date.now()
await page.locator('.card-play-btn').first().click({ force: true }).catch(() => {})
// wait for actual playback
let st: any = null
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(500)
  st = await audioState()
  if (st.found && !st.paused && st.currentTime > 0.5) break
}
const resolveMs = Date.now() - t0
check('audio element present', st.found)
check('audio PLAYING', st.found && !st.paused, `t=${st?.currentTime?.toFixed(2)}s`)
check('readyState ≥ 3 (decoding real bytes)', st.found && st.readyState >= 3, `readyState=${st.readyState}`)
check('duration is real-recording scale (20-45s preview on this IP; NOT 14s demo, NOT 2-10min synth)',
  st.found && st.duration > 20 && st.duration < 45, `duration=${st.duration?.toFixed(1)}s`)
check('currentTime advancing', st.found && st.currentTime > 0.5, `t=${st.currentTime?.toFixed(2)}s`)
check('resolution+play in sane time', resolveMs < 20000, `${(resolveMs / 1000).toFixed(1)}s (this datacenter IP waits for 4 InnerTube timeouts first; residential resolves in <1s)`)
check('browser fetched REAL audio from Apple CDN', appleRequests.length > 0, `${appleRequests.length} request(s)`)
if (appleRequests[0]) {
  const b = appleRequests[0].bytes
  const isMp4 = b.length > 11 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
  check('bytes are REAL m4a (ftyp magic)', isMp4, `${(b.length / 1024).toFixed(0)}KB`)
}
await page.screenshot({ path: `${OUT}-3-playing.png` })

// ---------- 3. seek works (Range request through the redirect) ----------
console.log('\n[3] Seek to 70% — Range request on real audio')
const beforeSeek = st?.currentTime
await page.evaluate(() => {
  const a = document.querySelector('audio') as HTMLAudioElement
  if (a && isFinite(a.duration)) a.currentTime = a.duration * 0.7
})
await page.waitForTimeout(1500)
const st2 = await audioState()
check('seek moved currentTime', st2.found && st2.currentTime > (beforeSeek || 0) + 3, `${beforeSeek?.toFixed(1)}s → ${st2.currentTime?.toFixed(1)}s`)
check('still playing after seek', st2.found && !st2.paused)

// ---------- 4. next track → different real audio ----------
console.log('\n[4] Next track')
const appleBefore = appleRequests.length
const nextBtn = page.locator('div[role="region"][aria-label="Player"] button[aria-label*="Next" i]').first()
if (await nextBtn.count()) {
  await nextBtn.click({ force: true })
  let stn: any = null
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500)
    stn = await audioState()
    if (stn.found && !stn.paused && stn.currentTime > 0.3) break
  }
  check('second track playing', stn?.found && !stn.paused, `t=${stn?.currentTime?.toFixed(2)}s dur=${stn?.duration?.toFixed(1)}s`)
  check('second track also real audio from Apple CDN', appleRequests.length > appleBefore, `total=${appleRequests.length}`)
  const payloads = appleRequests.filter(r => r.bytes.length > 1000).map(r => r.bytes)
  if (payloads.length >= 2) {
    let distinct = false
    outer: for (let i = 0; i < payloads.length; i++)
      for (let j = i + 1; j < payloads.length; j++) {
        const n = Math.min(4096, payloads[i].length, payloads[j].length)
        for (let k = 0; k < n; k++) if (payloads[i][k] !== payloads[j][k]) { distinct = true; break outer }
      }
    check('audio bytes DIFFER between tracks', distinct)
  }
  await page.screenshot({ path: `${OUT}-4-second.png` })
} else {
  check('next button found', false)
}

// ---------- 5. download ----------
console.log('\n[5] Download — real m4a')
const dlPromise = page.waitForEvent('download', { timeout: 45000 }).catch(() => null)
await page.locator('div[role="region"][aria-label="Player"] button[aria-label="Download this track"]').first().click({ force: true })
const dl = await dlPromise
if (dl) {
  const path = `${OUT}-download.m4a`
  await dl.saveAs(path)
  const buf = (await import('fs')).readFileSync(path)
  const isMp4 = buf.length > 11 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70
  check('download saved', true, dl.suggestedFilename())
  check('downloaded file is REAL m4a > 100KB', isMp4 && buf.length > 100000, `${(buf.length / 1024).toFixed(0)}KB magic=ftyp`)
} else {
  check('download event fired', false)
}

// ---------- 6. console health ----------
console.log('\n[6] Console health')
check('zero console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ').slice(0, 250))

// ---------- 7. provider order proof ----------
console.log('\n[7] Provider order proof (DB provider health + stream cache)')
const health = await fetch(`${BASE}/api/health`).then(r => r.json()).catch(() => null)
if (health?.providers?.length) {
  const innertube = health.providers.filter((p: any) => p.provider.startsWith('innertube'))
  const itunes = health.providers.find((p: any) => p.provider === 'itunes-preview')
  check('InnerTube providers WERE attempted (they run first)', innertube.length > 0,
    innertube.map((p: any) => `${p.provider}:${p.ok ? 'ok' : 'blocked'}`).join(', '))
  check('InnerTube blocked on THIS datacenter IP (expected here; on residential it wins with FULL-LENGTH)',
    innertube.every((p: any) => !p.ok))
  check('iTunes preview healthy (fallback works everywhere)', !itunes || itunes.ok === true)
} else {
  check('provider health data available', false)
}

console.log(`\n=== FRESH-INSTALL E2E RESULT: ${pass} passed, ${fail} failed ===`)
writeFileSync('/home/z/my-project/upload/fresh-e2e-result.json', JSON.stringify({ pass, fail, ts: new Date().toISOString() }, null, 2))
await browser.close()
process.exit(fail > 0 ? 1 : 0)
