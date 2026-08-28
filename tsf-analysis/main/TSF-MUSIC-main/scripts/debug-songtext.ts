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
await page.screenshot({ path: '/home/z/my-project/upload/debug-songlist.png' })
const info = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('div')).filter((e) =>
    (e.className || '').toString().includes('group') && (e.className || '').toString().includes('grid') && /Ed Sheeran/.test(e.textContent || '') && (e.textContent || '').length < 120)
  return rows.slice(0, 3).map((r) => {
    const title = r.querySelector('.truncate.font-medium') as HTMLElement | null
    const artist = r.querySelectorAll('.truncate')[1] as HTMLElement | null
    const thumb = r.querySelector('img')
    const cs = (el: HTMLElement | null) => {
      if (!el) return null
      const s = getComputedStyle(el)
      return { color: s.color, fontSize: s.fontSize, display: s.display, visibility: s.visibility, opacity: s.opacity, text: (el.textContent || '').slice(0, 30) }
    }
    return {
      rowText: (r.textContent || '').replace(/\s+/g, ' ').slice(0, 60),
      title: cs(title),
      artist: cs(artist),
      thumb: thumb ? { src: thumb.src.slice(0, 60), w: thumb.naturalWidth, visible: thumb.complete } : null,
    }
  })
})
console.log(JSON.stringify(info, null, 1))
await browser.close()
