/**
 * Stability + auto-advance: play a real preview track to its END and verify
 * the player auto-advances to the next track (queue continues seamlessly).
 */
import { chromium } from 'playwright'
const BASE = 'http://127.0.0.1:3000'
let pass = 0, fail = 0
const check = (n: string, ok: boolean, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗ FAIL'} ${n}${d ? ' — ' + d : ''}`) }

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const errors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(`PAGE: ${e.message}`))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
// search & play "shape of you"
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === 'Search')
  if (b) (b as HTMLElement).click()
})
await page.waitForTimeout(900)
await page.locator('input[placeholder="What do you want to listen to?"]').first().fill('shape of you')
await page.keyboard.press('Enter')
await page.waitForTimeout(5000)
await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('div')) as HTMLElement[]
  const row = els.find((e) => (e.className || '').toString().includes('group') && (e.className || '').toString().includes('grid') && /Shape of You/.test(e.textContent || '') && /Ed Sheeran/.test(e.textContent || '') && (e.textContent || '').length < 120)
  if (row) row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
})
await page.waitForTimeout(4000)

const st0 = await page.evaluate(() => {
  const a = document.querySelector('audio') as HTMLAudioElement | null
  return a ? { src: a.src, dur: a.duration, t: a.currentTime, paused: a.paused } : null
})
check('track 1 playing', !!st0 && !st0.paused && st0.t > 0.5, `dur=${st0?.dur?.toFixed(1)}s t=${st0?.t?.toFixed(1)}s`)
const src1 = st0?.src || ''

// seek near the end and let it finish
await page.evaluate(() => {
  const a = document.querySelector('audio') as HTMLAudioElement | null
  if (a && isFinite(a.duration)) a.currentTime = Math.max(0, a.duration - 3.5)
})
console.log('  … waiting for track end + auto-advance …')
let advanced = false
let stEnd: any = null
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000)
  stEnd = await page.evaluate(() => {
    const a = document.querySelector('audio') as HTMLAudioElement | null
    return a ? { src: a.src, dur: a.duration, t: a.currentTime, paused: a.paused } : null
  })
  if (stEnd && stEnd.src !== src1 && stEnd.t > 0.3 && !stEnd.paused) { advanced = true; break }
}
check('auto-advanced to next track when preview ended', advanced, `src changed=${advanced}, now dur=${stEnd?.dur?.toFixed(1)}s t=${stEnd?.t?.toFixed(1)}s`)
check('next track is real audio too', advanced && stEnd?.dur > 20 && stEnd?.dur < 45, `dur=${stEnd?.dur?.toFixed(1)}s`)
check('zero console errors', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 150))
await page.screenshot({ path: '/home/z/my-project/upload/e2e-autoadvance.png' })
console.log(`\n=== AUTO-ADVANCE RESULT: ${pass} passed, ${fail} failed ===`)
await browser.close()
process.exit(fail ? 1 : 0)
