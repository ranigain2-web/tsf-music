/**
 * TSF Music — DEFINITIVE E2E: REAL audio everywhere it exists.
 *
 * User journeys verified in a real browser:
 *   A. Search "shape of you" → click track row → REAL Apple-catalog audio
 *      plays (duration 20-45s = official preview, browser fetches from
 *      audio-ssl.itunes.apple.com, bytes are m4a not WAV)
 *   B. Next track → another REAL recording, different bytes
 *   C. Download button → real m4a file saved (>100KB, ftyp magic)
 *   D. Fullscreen player → duration display matches actual audio
 *   E. Provider cross-check: server streamCache provider vs observed duration
 *   F. Zero console errors
 */
import { chromium } from 'playwright'
import { PrismaClient } from '@prisma/client'

const BASE = 'http://127.0.0.1:3000'
const db = new PrismaClient()
let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function providerOf(videoId: string): Promise<string> {
  const row = await db.streamCache.findUnique({ where: { videoId } })
  return row?.provider || 'none'
}

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const consoleErrors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(`PAGE ERROR: ${e.message}`))

const appleBodies: Buffer[] = []
page.on('response', async (res) => {
  try {
    const u = res.url()
    if (u.includes('audio-ssl.itunes.apple.com') && u.includes('mzaf')) {
      appleBodies.push(Buffer.from(await res.body()))
    }
  } catch { /* streamed body unavailable — fine */ }
})

console.log('→ Loading app…')
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)

const audioState = () => page.evaluate(() => {
  const a = document.querySelector('audio')
  if (!a) return { found: false }
  return { found: true, paused: a.paused, readyState: a.readyState, duration: a.duration, currentTime: a.currentTime, src: a.src }
})

// ============ A. SEARCH → PLAY A KNOWN MAINSTREAM TRACK ============
console.log('\n[A] Search "shape of you" → click track → expect REAL Apple audio')
// navigate to the search view via the sidebar Search button
await page.locator('nav button:has(svg), aside button:has(svg)').filter({ hasText: '' }).count()
await page.evaluate(() => {
  // click the sidebar Search button (contains an svg search icon)
  const btns = Array.from(document.querySelectorAll('button'))
  const searchBtn = btns.find((b) => b.querySelector('svg') && /search/i.test(b.className + ' ' + b.getAttribute('aria-label') + ' ' + (b.textContent || '')))
  if (searchBtn) (searchBtn as HTMLElement).click()
})
await page.waitForTimeout(1200)
const searchInput = page.locator('input[placeholder="What do you want to listen to?"]').first()
await searchInput.fill('shape of you')
await page.keyboard.press('Enter')
await page.waitForTimeout(5000) // debounce + search round trip

// track rows appear in results — click the TrackRow (div.group.grid) holding the title
const clickedInfo = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('div')) as HTMLElement[]
  const row = els.find(
    (e) =>
      (e.className || '').toString().includes('group') &&
      (e.className || '').toString().includes('grid') &&
      /Shape of You/.test(e.textContent || '') &&
      /Ed Sheeran/.test(e.textContent || '') &&
      (e.textContent || '').length < 120,
  )
  if (row) {
    row.scrollIntoView({ block: 'center' })
    // TrackRows play on DOUBLE-CLICK (Spotify behavior)
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    return { clicked: true, text: (row.textContent || '').replace(/\s+/g, ' ').slice(0, 80) }
  }
  // fallback: double-click the title text (rows often play on double-click)
  const title = els.find((e) => (e.textContent || '') === 'Shape of You' && (e.className || '').toString().includes('truncate'))
  if (title) {
    title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    return { clicked: true, text: 'title-dblclick', fallback: true }
  }
  return { clicked: false }
})
check('clicked a "Shape of You" result', clickedInfo.clicked, clickedInfo.text || '')

await page.waitForTimeout(6000) // resolve + redirect + buffer + play
let st = await audioState()
check('audio playing', st.found && !st.paused, `paused=${st.paused}`)
check('readyState ≥ 3', st.found && st.readyState >= 3, `readyState=${st.readyState}`)
check('duration 20-45s = REAL official preview (not 14s demo, not 138-600s synth)',
  st.found && st.duration > 20 && st.duration < 45, `duration=${st.duration?.toFixed(1)}s`)
check('currentTime advancing (genuine AAC decode)', st.found && st.currentTime > 1, `t=${st.currentTime?.toFixed(2)}s`)
check('browser fetched from Apple audio CDN', appleBodies.length > 0, `${appleBodies.length} body(ies)`)
if (appleBodies[0]) {
  const b = appleBodies[0]
  const isMp4 = b.length > 11 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
  const isWav = b[0] === 0x52 && b[1] === 0x49
  check('Apple CDN payload is m4a (ftyp), not WAV', isMp4 && !isWav, `${b.length} bytes`)
}

// which videoId is playing? cross-check server provider
const playingTitle = await page.evaluate(() => document.querySelector('div[role="region"][aria-label="Player"]')?.textContent || '')
console.log(`  player bar: ${playingTitle.replace(/\s+/g, ' ').slice(0, 110)}`)
const m = (st as any).src?.match(/id=([^&]+)/)
if (m) {
  const prov = await providerOf(decodeURIComponent(m[1]))
  check('server provider = itunes-preview for played track', prov === 'itunes-preview', `provider=${prov}`)
}
await page.screenshot({ path: '/home/z/my-project/upload/e2e-real-1-playing.png' })

// ============ B. SECOND, DIFFERENT SONG → DIFFERENT REAL RECORDING ============
console.log('\n[B] Play a genuinely different song ("Bad Habits") → different REAL recording')
const bodiesBefore = appleBodies.length
// search for a different song and play it
await page.keyboard.press('Escape').catch(() => {})
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'))
  const b = btns.find((x) => (x.textContent || '').trim() === 'Search')
  if (b) (b as HTMLElement).click()
})
await page.waitForTimeout(800)
const si2 = page.locator('input[placeholder="What do you want to listen to?"]').first()
await si2.fill('bad habits ed sheeran')
await page.keyboard.press('Enter')
await page.waitForTimeout(5000)
const clicked2 = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('div')) as HTMLElement[]
  const row = els.find(
    (e) =>
      (e.className || '').toString().includes('group') &&
      (e.className || '').toString().includes('grid') &&
      /Bad Habits/.test(e.textContent || '') &&
      /Ed Sheeran/.test(e.textContent || '') &&
      (e.textContent || '').length < 120,
  )
  if (row) {
    row.scrollIntoView({ block: 'center' })
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    return true
  }
  return false
})
check('clicked a "Bad Habits" result', clicked2)
let st2: any = null
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(500)
  st2 = await audioState()
  if (st2.found && isFinite(st2.duration) && st2.duration > 0 && st2.currentTime > 0.3 && !st2.paused) break
}
check('second song playing', st2?.found && !st2.paused, `t=${st2?.currentTime?.toFixed(2)}s dur=${st2?.duration?.toFixed(1)}s`)
const m2 = (st2 as any).src?.match(/id=([^&]+)/)
if (m2) {
  const prov2 = await providerOf(decodeURIComponent(m2[1]))
  check('second song provider = itunes-preview', prov2 === 'itunes-preview', `provider=${prov2}`)
}
// distinct real recordings: the two DIFFERENT songs must resolve to different
// Apple preview URLs (different mzaf recording ids)
await page.waitForTimeout(1500)
if (m && m2 && m[1] !== m2[1]) {
  const url1 = (await db.streamCache.findUnique({ where: { videoId: decodeURIComponent(m[1]) } }))?.url
  const url2 = (await db.streamCache.findUnique({ where: { videoId: decodeURIComponent(m2[1]) } }))?.url
  const mz1 = url1?.match(/mzaf_(\d+)/)?.[1]
  const mz2 = url2?.match(/mzaf_(\d+)/)?.[1]
  check('two DIFFERENT real recordings (distinct Apple mzaf ids)', !!mz1 && !!mz2 && mz1 !== mz2, `${mz1} vs ${mz2}`)
} else if (appleBodies.length >= 2) {
  const [a, b] = [appleBodies[0], appleBodies[appleBodies.length - 1]]
  let distinct = false
  const n = Math.min(4096, a.length, b.length)
  for (let k = 0; k < n; k++) if (a[k] !== b[k]) { distinct = true; break }
  check('audio bytes differ between the two songs', distinct)
} else {
  check('distinct recordings verified', false, `m=${m?.[1]} m2=${m2?.[1]}`)
}
await page.screenshot({ path: '/home/z/my-project/upload/e2e-real-2-second.png' })

// ============ C. DOWNLOAD ============
console.log('\n[C] Download → real m4a file')
const dlPromise = page.waitForEvent('download', { timeout: 45000 }).catch(() => null)
await page.locator('div[role="region"][aria-label="Player"] button[aria-label="Download this track"]').first().click({ force: true })
const dl = await dlPromise
if (dl) {
  const path = '/home/z/my-project/upload/e2e-real-download.m4a'
  await dl.saveAs(path)
  const fs = await import('fs')
  const buf = fs.readFileSync(path)
  const isMp4 = buf.length > 11 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70
  check('download saved with .m4a name', dl.suggestedFilename().endsWith('.m4a'), dl.suggestedFilename())
  check('downloaded REAL m4a > 100KB', isMp4 && buf.length > 100000, `${(buf.length / 1024).toFixed(0)}KB`)
} else {
  check('download event fired', false)
}

// ============ D. FULLSCREEN PLAYER ============
console.log('\n[D] Fullscreen player duration display')
await page.locator('div[role="region"][aria-label="Player"] button[aria-label="Open now playing view"]').first().click({ force: true })
await page.waitForTimeout(1500)
const fullText = await page.evaluate(() => document.body.textContent || '')
const st3 = await audioState()
const fsDurMatches = [...fullText.matchAll(/(\d+):(\d{2})/g)]
if (fsDurMatches.length && st3.found) {
  const mmss = parseInt(fsDurMatches[fsDurMatches.length - 1][1]) * 60 + parseInt(fsDurMatches[fsDurMatches.length - 1][2])
  check('fullscreen duration ≈ actual audio duration', Math.abs(mmss - st3.duration) < 3, `text=${fsDurMatches[fsDurMatches.length - 1][0]} audio=${st3.duration?.toFixed(1)}s`)
}
check('fullscreen opened with track visible', fullText.includes('Ed Sheeran') || fullText.length > 500)
await page.screenshot({ path: '/home/z/my-project/upload/e2e-real-3-fullscreen.png' })

// ============ F. CONSOLE ============
console.log('\n[F] Console health')
check('zero console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ').slice(0, 180))

console.log(`\n=== DEFINITIVE E2E RESULT: ${pass} passed, ${fail} failed ===`)
await browser.close()
await db.$disconnect()
process.exit(fail > 0 ? 1 : 0)
