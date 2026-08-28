/**
 * Phase-2 visual verification: home (desktop+mobile), AI generator streaming,
 * fullscreen player ambient. Saves to download/phase2-shots/.
 */
import { chromium } from 'playwright'
import fs from 'fs'

fs.mkdirSync('/home/z/my-project/download/phase2-shots', { recursive: true })
const OUT = '/home/z/my-project/download/phase2-shots'
const BASE = 'http://127.0.0.1:3000'

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })

// ---------- desktop ----------
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const consoleErrors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(String(e)))

await page.goto(BASE, { waitUntil: 'networkidle' })
// wait for real content (shelves render), not just network idle
await page.waitForSelector('h1, h2', { timeout: 30000 }).catch(() => {})
await page.waitForTimeout(4500)
await page.screenshot({ path: `${OUT}/01-home-desktop.png` })

// AI generator: open and start a generation to catch the streaming UI
const aiBtn = page.locator('button[title="Create with AI"]').first()
if (await aiBtn.count()) {
  await aiBtn.click()
  await page.waitForTimeout(600)
  await page.fill('textarea', 'dreamy synthwave for a neon night drive')
  await page.waitForTimeout(300)
  await page.locator('button:has-text("Generate playlist")').click()
  // capture early streaming state (~1.4s: starters + maybe first LLM tracks)
  await page.waitForTimeout(1400)
  await page.screenshot({ path: `${OUT}/02-ai-streaming-early.png` })
  // capture mid state
  await page.waitForTimeout(2600)
  await page.screenshot({ path: `${OUT}/03-ai-streaming-mid.png` })
  // wait for done
  await page.waitForSelector('button:has-text("Open playlist")', { timeout: 30000 })
  await page.screenshot({ path: `${OUT}/04-ai-done.png` })
  await page.locator('button:has-text("Open playlist")').click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${OUT}/05-ai-playlist-open.png` })
  // play first track then open fullscreen
  const row = page.locator('.group.grid').first()
  await row.dblclick()
  await page.waitForTimeout(3500)
  await page.locator('button[aria-label="Now playing view"], button[title="Now playing view"]').first().click()
  await page.waitForTimeout(1800)
  await page.screenshot({ path: `${OUT}/06-fullscreen-ambient.png` })
}

// purity check: no provider names anywhere in DOM
const domText = await page.evaluate(() => document.body.innerText)
const leaks = (domText.match(/opencode|zen|glm|hy3|nemotron|mimo|claude|gemini/gi) || []).filter(
  (m) => !/^Zen$/i.test(m.trim()) // allow potential legit song titles like "Zen" alone? strict anyway
)
console.log('DOM leak matches:', JSON.stringify(leaks.slice(0, 10)))

await ctx.close()

// ---------- mobile ----------
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' })
const mpage = await mctx.newPage()
await mpage.goto(BASE, { waitUntil: 'networkidle' })
await mpage.waitForSelector('h1, h2', { timeout: 45000 }).catch(() => {})
await mpage.waitForTimeout(5000)
await mpage.screenshot({ path: `${OUT}/07-home-mobile.png` })
await mctx.close()

await browser.close()
console.log('console errors:', consoleErrors.length ? consoleErrors.slice(0, 6) : 'none')
console.log('shots saved to download/phase2-shots/')
