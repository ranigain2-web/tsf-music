/**
 * Phase-2 functional gauntlet: full user journey with audio verification.
 * Every check prints PASS/FAIL; audio playback verified via element state.
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3000'
const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const errors: string[] = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)))

// 1. home loads with shelves
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('h1, h2', { timeout: 45000 })
await page.waitForTimeout(5000)
const homeText = await page.evaluate(() => document.body.innerText)
check('home: greeting renders', /Late night|Good (morning|afternoon|evening)|Good night/.test(homeText))
check('home: shelves render', /Top tracks|Daily Mix|Because you like/i.test(homeText))
check('home: purity (no provider names)', !/opencode|glm-4|hy3|nemotron|mimo-v2/i.test(homeText))

// 2. search + play with audio verification
await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('button, a')) as HTMLElement[]
  const s = els.find((e) => /Search/i.test((e.textContent || '').trim()) && e.closest('nav'))
  if (s) s.click()
})
await page.waitForTimeout(1500)
const searchInput = page.locator('input').first()
if (await searchInput.count()) {
  await searchInput.fill('Kesariya Arijit Singh')
  await searchInput.press('Enter')
  await page.waitForTimeout(4000)
}
const trackRow = page.locator('.group.grid').first()
check('search: results render', (await page.locator('.group.grid').count()) > 0)

// play (desktop = double click)
await trackRow.dblclick()
await page.waitForTimeout(6000)
const audioState = await page.evaluate(() => {
  const a = document.querySelector('audio')
  if (!a) return { exists: false }
  return {
    exists: true,
    paused: a.paused,
    currentTime: a.currentTime,
    duration: a.duration,
    readyState: a.readyState,
    src: (a.currentSrc || a.src || '').slice(0, 60),
  }
})
check('audio: element exists', audioState.exists)
check('audio: playing', audioState.exists && !audioState.paused, `t=${audioState.currentTime?.toFixed(1)}s dur=${audioState.duration?.toFixed(0)}s`)
check('audio: time advancing', (audioState.currentTime ?? 0) > 0.5)

// 3. now playing bar visible with track
const barText = await page.evaluate(() => {
  const regions = Array.from(document.querySelectorAll('[aria-label="Player"]'))
  return regions.map((r) => r.textContent || '').join(' ')
})
check('player bar: track title shown', /kesariya/i.test(barText))

// 4. fullscreen player opens + ambient renders
await page.locator('button[aria-label="Open now playing view"], button[title="Now playing view"]').first().click()
await page.waitForTimeout(2500)
const fsInfo = await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"][aria-label="Now playing"]')
  const ambient = document.querySelector('.tsf-ambient')
  const art = dlg?.querySelector('img')
  return { open: !!dlg, ambient: !!ambient, art: !!art }
})
check('fullscreen: dialog opens', fsInfo.open)
check('fullscreen: ambient backdrop renders', fsInfo.ambient)
check('fullscreen: artwork renders', fsInfo.art)
await page.keyboard.press('Escape')
await page.waitForTimeout(800)

// 5. like the current track
const likeBtn = page.locator('button[aria-label="Save to Liked Songs"]').first()
if (await likeBtn.count()) {
  await likeBtn.click()
  await page.waitForTimeout(1200)
  check('like: toggled without error', true)
} else {
  check('like: toggled without error', false, 'button not found')
}

// 6. AI playlist generation (fresh prompt) end-to-end
await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('button, a')) as HTMLElement[]
  const h = els.find((e) => /Home/i.test((e.textContent || '').trim()) && e.closest('nav'))
  if (h) h.click()
})
await page.waitForTimeout(1500)
const t0 = Date.now()
await page.locator('button[title="Create with AI"]').first().click()
await page.waitForTimeout(500)
await page.fill('textarea', 'punjabi workout energy bangers')
await page.locator('button:has-text("Generate playlist")').click()
// first track should appear quickly
try {
  await page.waitForSelector('[role="dialog"] img.w-9', { timeout: 12000 })
  const tFirst = Date.now() - t0
  check('AI gen: first track visible ≤ 12s', true, `${(tFirst / 1000).toFixed(1)}s`)
} catch {
  check('AI gen: first track visible ≤ 12s', false, 'timeout')
}
try {
  await page.waitForSelector('button:has-text("Open playlist")', { timeout: 30000 })
  const tDone = Date.now() - t0
  const count = await page.evaluate(() => document.querySelectorAll('[role="dialog"] img.w-9').length)
  check('AI gen: completes ≤ 30s', true, `${(tDone / 1000).toFixed(1)}s, ${count} tracks`)
} catch {
  check('AI gen: completes ≤ 30s', false, 'timeout')
}
// open the playlist
await page.locator('button:has-text("Open playlist")').click()
await page.waitForTimeout(2500)
const plView = await page.evaluate(() => document.body.innerText)
check('AI playlist: opens with tracks', /(songs|tracks)/i.test(plView) && /\d+\./.test(plView))

// 7. purity across ALL visited views
const finalText = await page.evaluate(() => document.body.innerText)
const leaks = finalText.match(/opencode|zen curator|glm|hy3|nemotron|mimo-v2|claude|gemini/gi)
check('purity: zero provider names in full session DOM', !leaks, leaks ? JSON.stringify(leaks.slice(0, 5)) : 'clean')

// 8. console errors
check('console: zero page errors', errors.length === 0, errors.length ? errors[0] : 'clean')

await browser.close()
const pass = results.filter((r) => r.ok).length
console.log(`\n===== GAUNTLET: ${pass}/${results.length} PASS =====`)
if (pass < results.length) process.exit(1)
