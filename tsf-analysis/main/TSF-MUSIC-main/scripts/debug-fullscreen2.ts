import { chromium } from 'playwright'
const BASE = 'http://127.0.0.1:3000'
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.locator('.card-play-btn').first().click({ force: true }).catch(() => {})
await page.waitForTimeout(3000)

const info = await page.evaluate(() => {
  const btn = document.querySelector('button[aria-label="Open now playing view"]') as HTMLElement | null
  if (!btn) return { found: false }
  const r = btn.getBoundingClientRect()
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2
  const top = document.elementFromPoint(cx, cy)
  return {
    found: true,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    topElement: top ? `${top.tagName}.${(top.className + '').slice(0, 60)} label=${top.getAttribute('aria-label') || ''}` : 'none',
    topIsInsideBtn: btn.contains(top),
  }
})
console.log('button info:', JSON.stringify(info, null, 1))

// try a real user click via elementFromPoint target directly
const after = await page.evaluate(() => {
  const btn = document.querySelector('button[aria-label="Open now playing view"]') as HTMLElement | null
  btn?.click() // direct DOM click → React handler fires
  return new Promise((resolve) => setTimeout(() => resolve({
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    closeBtns: document.querySelectorAll('button[aria-label="Close now playing"]').length,
  }), 600))
})
console.log('after direct DOM click:', JSON.stringify(after))
await page.screenshot({ path: '/home/z/my-project/upload/debug-fullscreen2.png' })
await browser.close()
