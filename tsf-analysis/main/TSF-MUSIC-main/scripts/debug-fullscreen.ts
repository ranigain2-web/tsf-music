import { chromium } from 'playwright'
const BASE = 'http://127.0.0.1:3000'
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERR:', m.text().slice(0, 150)) })
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message.slice(0, 150)))

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.locator('.card-play-btn').first().click({ force: true }).catch(() => {})
await page.waitForTimeout(3500)

const before = await page.evaluate(() => ({
  openBtns: document.querySelectorAll('button[aria-label="Open now playing view"]').length,
  dialogs: document.querySelectorAll('[role="dialog"]').length,
}))
console.log('before click:', JSON.stringify(before))

await page.locator('button[aria-label="Open now playing view"]').first().click({ force: true })
await page.waitForTimeout(800)
const after = await page.evaluate(() => ({
  dialogs: document.querySelectorAll('[role="dialog"]').length,
  closeBtns: document.querySelectorAll('button[aria-label="Close now playing"]').length,
  dialogLabel: document.querySelector('[role="dialog"]')?.getAttribute('aria-label'),
  bodyHasNowPlayingEnter: !!document.querySelector('.now-playing-enter'),
}))
console.log('after click:', JSON.stringify(after))
await page.screenshot({ path: '/home/z/my-project/upload/debug-fullscreen.png' })
await browser.close()
