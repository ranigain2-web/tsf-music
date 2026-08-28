import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
// click sidebar Search
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'))
  const b = btns.find((x) => (x.textContent || '').trim() === 'Search')
  if (b) (b as HTMLElement).click()
})
await page.waitForTimeout(1000)
console.log('inputs after nav:', await page.evaluate(() => Array.from(document.querySelectorAll('input')).map(i => i.placeholder)))
const input = page.locator('input[placeholder="What do you want to listen to?"]').first()
await input.fill('shape of you')
await page.keyboard.press('Enter')
await page.waitForTimeout(6000)
await page.screenshot({ path: '/home/z/my-project/upload/debug-nav-2-search.png' })
// find track rows
const rows = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('div,button,li'))
  return els.filter(e => /Shape of You/.test(e.textContent || '') && (e.textContent || '').length < 120).slice(0, 8)
    .map(e => ({ tag: e.tagName, text: (e.textContent || '').replace(/\s+/g, ' ').slice(0, 90), cls: (e.className || '').toString().slice(0, 50) }))
})
console.log('candidate rows:', JSON.stringify(rows, null, 1).slice(0, 1200))
await browser.close()
