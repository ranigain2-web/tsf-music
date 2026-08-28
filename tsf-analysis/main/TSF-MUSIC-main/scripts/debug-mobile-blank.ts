/**
 * Debug the mobile blank-screen: console errors, network failures, DOM state.
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 200)) })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
page.on('requestfailed', (r) => console.log('[reqfail]', r.url().slice(0, 120), r.failure()?.errorText))
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url().slice(0, 120)) })

await page.goto('http://127.0.0.1:3000', { waitUntil: 'domcontentloaded' })
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(2500)
  const state = await page.evaluate(() => ({
    bodyChildren: document.body.children.length,
    hasH1: !!document.querySelector('h1'),
    hasH2: !!document.querySelector('h2'),
    textLen: document.body.innerText.length,
    textHead: document.body.innerText.slice(0, 120).replace(/\n/g, ' | '),
  }))
  console.log(`t=${(i + 1) * 2.5}s`, JSON.stringify(state))
  if (state.hasH1 || state.hasH2) break
}
await page.screenshot({ path: '/tmp/mobile-debug.png' })
await browser.close()
