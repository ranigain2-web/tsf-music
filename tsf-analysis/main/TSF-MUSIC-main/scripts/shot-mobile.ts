/**
 * Mobile capture — standalone (separate process from desktop flow).
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)))

await page.goto('http://127.0.0.1:3000', { waitUntil: 'domcontentloaded' })
// poll for real content (splash has no h1/h2)
await page.waitForSelector('h1, h2', { timeout: 45000 }).catch(() => {})
await page.waitForTimeout(6000)
const state = await page.evaluate(() => ({
  h1: document.querySelector('h1')?.textContent?.slice(0, 50) ?? null,
  textLen: document.body.innerText.length,
}))
console.log('state:', JSON.stringify(state))
await page.screenshot({ path: '/home/z/my-project/download/phase2-shots/07-home-mobile.png' })
await browser.close()
console.log('mobile shot saved')
