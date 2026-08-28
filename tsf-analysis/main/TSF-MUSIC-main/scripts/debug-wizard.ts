/** Debug the onboarding wizard step transitions with screenshots. */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3000'
const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()

const stepInfo = () => page.evaluate(() => {
  const t = document.body.textContent || ''
  const m = t.match(/Step (\d+) of (\d+)/)
  const pressed = [...document.querySelectorAll('button[aria-pressed="true"]')].length
  const allPressed = [...document.querySelectorAll('button[aria-pressed]')].length
  const btns = [...document.querySelectorAll('button')].filter(b => !b.disabled && b.offsetParent).map(b => b.textContent?.trim()).filter(Boolean).slice(0, 12)
  return { step: m ? `${m[1]}/${m[2]}` : '?', pressed, allPressed, btns, head: t.slice(0, 100) }
})

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2000)
console.log('welcome:', JSON.stringify(await stepInfo()))
await page.getByRole('button', { name: /Get started/i }).click()
await page.waitForTimeout(800)
console.log('after getstarted:', JSON.stringify(await stepInfo()))

await page.fill('input[type="text"]', 'TSF Tester')
await page.keyboard.press('Enter')
await page.waitForTimeout(800)
console.log('after name:', JSON.stringify(await stepInfo()))
await page.screenshot({ path: '/tmp/wiz-1.png' })

// bio: Skip button (this step has "Skip", not "Continue")
await page.getByRole('button', { name: /^Skip$/i }).click()
await page.waitForTimeout(2500)
console.log('after bio:', JSON.stringify(await stepInfo()))
await page.screenshot({ path: '/tmp/wiz-2.png' })

// artists: wait for tiles to load
await page.waitForSelector('button[aria-pressed]', { timeout: 15000 }).catch(() => console.log('NO artist tiles'))
await page.waitForTimeout(1000)
let info = await stepInfo()
console.log('artists step:', JSON.stringify(info))
// click first 4 artist tiles
const tiles = await page.locator('button[aria-pressed]').all()
let n = 0
for (const b of tiles) {
  if (n >= 4) break
  await b.click({ force: true, timeout: 3000 }).catch(e => console.log('tile click fail', (e as Error).message.slice(0, 60)))
  n++
  await page.waitForTimeout(300)
}
info = await stepInfo()
console.log('after tile clicks:', JSON.stringify(info))

// click the footer Continue (enabled?)
const cont = page.getByRole('button', { name: /^Continue$/i })
console.log('continue count:', await cont.count(), 'enabled:', await cont.first().isEnabled().catch(() => false))
await cont.first().click({ timeout: 5000 }).catch(e => console.log('continue fail:', (e as Error).message.slice(0, 80)))
await page.waitForTimeout(1500)
console.log('after artists continue:', JSON.stringify(await stepInfo()))
await page.screenshot({ path: '/tmp/wiz-3.png' })

// genres
await page.waitForTimeout(1000)
info = await stepInfo()
console.log('genres step:', JSON.stringify(info))
const gTiles = await page.locator('button[aria-pressed]').all()
let g = 0
for (const b of gTiles) {
  if (g >= 3) break
  await b.click({ force: true, timeout: 3000 }).catch(() => {})
  g++
  await page.waitForTimeout(200)
}
await page.getByRole('button', { name: /^Continue$/i }).first().click({ timeout: 5000 }).catch(e => console.log('g-continue fail:', (e as Error).message.slice(0, 80)))
await page.waitForTimeout(1500)
console.log('after genres continue:', JSON.stringify(await stepInfo()))
await page.screenshot({ path: '/tmp/wiz-4.png' })

// summary finish
const fin = page.getByRole('button', { name: /Start|Finish|Done|Enter TSF|Let's/i })
console.log('finish buttons:', await fin.count())
await fin.first().click({ timeout: 5000 }).catch(e => console.log('finish fail:', (e as Error).message.slice(0, 80)))
await page.waitForTimeout(5000)
console.log('after finish:', JSON.stringify(await stepInfo()))
await page.screenshot({ path: '/tmp/wiz-5.png' })

await browser.close()
