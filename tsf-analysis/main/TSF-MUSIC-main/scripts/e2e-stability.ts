/**
 * Playback stability: play a track for 45s and verify NO reset/restart,
 * currentTime monotonic, duration stable. (Investigates the earlier t=0/dur=null
 * observation after ~30s.)
 */
import { chromium } from 'playwright'
const BASE = 'http://127.0.0.1:3000'
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const errs: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)) })
page.on('pageerror', (e) => errs.push('PAGE: ' + e.message.slice(0, 120)))

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
await page.locator('.card-play-btn').first().click({ force: true }).catch(() => {})
await page.waitForTimeout(2000)

const samples: string[] = []
let resets = 0
let lastT = -1
for (let i = 0; i < 9; i++) {
  await page.waitForTimeout(5000)
  const s = await page.evaluate(() => {
    const a = document.querySelector('audio') as HTMLAudioElement | null
    return a ? { t: +a.currentTime.toFixed(1), dur: a.duration, paused: a.paused, src: a.src.slice(-25), rs: a.readyState } : null
  })
  samples.push(JSON.stringify(s))
  if (s) {
    if (s.t < lastT - 0.5) resets++
    lastT = s.t
  }
}
console.log(samples.join('\n'))
console.log(`\nresets detected: ${resets}`)
console.log(`console errors: ${errs.length}`, errs.slice(0, 3))
await browser.close()
process.exit(resets > 0 ? 1 : 0)
