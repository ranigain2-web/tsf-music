/**
 * Capture the fullscreen Now Playing view for visual verification.
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3000'
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const consoleErrors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(`PAGE ERROR: ${e.message}`))

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)

// play a track
await page.locator('.card-play-btn').first().click({ force: true }).catch(() => {})
await page.waitForTimeout(4000)

// open fullscreen now playing: click the track info area in the player bar
const trackInfo = page.locator('div[role="region"][aria-label="Player"] button, div[role="region"][aria-label="Player"] [class*="cursor-pointer"]').first()
await trackInfo.click({ force: true }).catch(() => {})
await page.waitForTimeout(2500)
await page.screenshot({ path: '/home/z/my-project/upload/e2e-synth-4-fullscreen.png' })

// grab the fullscreen text content for duration verification
const fsText = await page.evaluate(() => document.body.textContent || '')
const times = [...fsText.matchAll(/(\d+):(\d{2})/g)].map((m) => m[0])
console.log('fullscreen time labels:', times.slice(0, 8).join(', '))
console.log('console errors:', consoleErrors.length, consoleErrors.slice(0, 2))

// close fullscreen (chevron down)
const closeBtn = page.locator('button[aria-label*="Close" i], button[aria-label*="down" i], button[aria-label*="Minimize" i]').first()
if (await closeBtn.count()) await closeBtn.click({ force: true }).catch(() => {})
await page.waitForTimeout(800)
await page.screenshot({ path: '/home/z/my-project/upload/e2e-synth-5-after-close.png' })

// verify audio kept playing through fullscreen open/close
const st = await page.evaluate(() => {
  const a = document.querySelector('audio') as HTMLAudioElement | null
  return a ? { paused: a.paused, t: a.currentTime, dur: a.duration } : null
})
console.log('audio after fullscreen:', JSON.stringify(st))
await browser.close()
