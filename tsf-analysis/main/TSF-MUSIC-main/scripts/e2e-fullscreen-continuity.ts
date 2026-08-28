/**
 * Focused test: does opening/closing the fullscreen player reset playback?
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3000'
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const consoleErrors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(`PAGE: ${e.message}`))

const audioState = () => page.evaluate(() => {
  const a = document.querySelector('audio') as HTMLAudioElement | null
  return a ? { src: a.src.slice(-40), t: a.currentTime, dur: a.duration, paused: a.paused } : null
})

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.locator('.card-play-btn').first().click({ force: true }).catch(() => {})
await page.waitForTimeout(4000)

console.log('1. baseline:        ', JSON.stringify(await audioState()))

// open fullscreen via the proper button
await page.locator('button[aria-label="Open now playing view"]').first().click({ force: true })
await page.waitForTimeout(1200)
console.log('2. fullscreen open: ', JSON.stringify(await audioState()))
await page.screenshot({ path: '/home/z/my-project/upload/e2e-synth-4-fullscreen.png' })

// close via the proper button
await page.locator('button[aria-label="Close now playing"]').first().click({ force: true })
await page.waitForTimeout(1200)
console.log('3. fullscreen close:', JSON.stringify(await audioState()))

// re-open, wait longer, verify continuity
await page.locator('button[aria-label="Open now playing view"]').first().click({ force: true })
await page.waitForTimeout(1500)
const s4 = await audioState()
console.log('4. re-opened:       ', JSON.stringify(s4))
const ok = s4 && s4.t > 4 && !s4.paused
console.log(ok ? '✓ playback continuous through open/close' : '✗ playback RESET through open/close')
await page.screenshot({ path: '/home/z/my-project/upload/e2e-synth-4-fullscreen-reopen.png' })
console.log('console errors:', consoleErrors.length, consoleErrors.slice(0, 2))
await browser.close()
