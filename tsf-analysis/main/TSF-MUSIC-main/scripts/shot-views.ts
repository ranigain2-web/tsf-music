import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle' })
await page.waitForTimeout(3000)
await page.screenshot({ path: '/home/z/my-project/upload/views-1-home.png' })
// open first AI playlist from sidebar
await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('button, a')) as HTMLElement[]
  const pl = els.find((e) => /Sunset Shoreline Grooves/i.test(e.textContent || ''))
  if (pl) pl.click()
})
await page.waitForTimeout(2500)
await page.screenshot({ path: '/home/z/my-project/upload/views-2-playlist.png' })
// liked songs
await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('button, a')) as HTMLElement[]
  const lk = els.find((e) => /^Liked Songs/i.test((e.textContent || '').trim()))
  if (lk) lk.click()
})
await page.waitForTimeout(2000)
await page.screenshot({ path: '/home/z/my-project/upload/views-3-liked.png' })
await browser.close()
