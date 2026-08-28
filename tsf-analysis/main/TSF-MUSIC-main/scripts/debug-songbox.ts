import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === 'Search')
  if (b) (b as HTMLElement).click()
})
await page.waitForTimeout(1000)
await page.locator('input[placeholder="What do you want to listen to?"]').first().fill('bad habits')
await page.keyboard.press('Enter')
await page.waitForTimeout(5000)
const info = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('div')).filter((e) =>
    (e.className || '').toString().includes('group') && (e.className || '').toString().includes('grid') && /Ed Sheeran/.test(e.textContent || '') && (e.textContent || '').length < 120)
  return rows.slice(0, 2).map((r) => {
    const rect = (el: Element) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
    const title = r.querySelector('.truncate.font-medium')
    const cols = r.querySelector('.grid')
    return {
      row: rect(r),
      rowClass: (r.className || '').toString().slice(0, 100),
      titleBox: title ? rect(title) : null,
      rowChildren: Array.from(r.children).map((c) => ({ cls: (c.className || '').toString().slice(0, 60), ...rect(c) })),
    }
  })
})
console.log(JSON.stringify(info, null, 1))
await browser.close()
