/**
 * Capture TSF Music onboarding screens for gauntlet-loop A/B vs Spotify.
 * Walks through: welcome → name → bio → artists (with search) → genres → summary.
 *
 * Also captures the post-onboarding home view with Daily Mixes.
 *
 * Output: /home/z/my-project/download/ours/onboarding-*.png
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const OUT = '/home/z/my-project/download/ours'
mkdirSync(OUT, { recursive: true })

const BASE = 'http://localhost:3000'

async function shot(page: any, name: string) {
  const path = `${OUT}/onboarding-${name}.png`
  await page.screenshot({ path, fullPage: false })
  console.log(`✓ ${path}`)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  })
  const page = await ctx.newPage()
  page.on('console', (msg) => console.log('  [browser]', msg.type(), msg.text().slice(0, 200)))
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message.slice(0, 300)))

  console.log('\n[1] Welcome screen')
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(1500)
  await shot(page, '1-welcome')

  console.log('[2] Click "Get started"')
  await page.getByRole('button', { name: /Get started/i }).click().catch(() => {
    // fallback: click any button containing the text
    return page.click('text=Get started').catch(() => page.click('button >> nth=0'))
  })
  await page.waitForTimeout(800)
  await shot(page, '2-name')

  console.log('[3] Fill name → Continue')
  await page.fill('input[type="text"]', 'Alex').catch(() => {})
  await page.keyboard.press('Enter').catch(() => {})
  await page.waitForTimeout(800)
  await shot(page, '3-bio')

  console.log('[4] Skip bio (no skip — type nothing, click Continue)')
  // Click the visible Continue button — there should be only one visible at this point
  await page.getByRole('button', { name: /^Skip$|^Continue$/i }).click().catch(() => {})
  await page.waitForTimeout(800)
  await shot(page, '4-artists-empty')

  console.log('[5] Type "drake" in search')
  try {
    const searchInput = page.locator('input[placeholder*="Search"]').first()
    await searchInput.fill('drake')
    await page.waitForTimeout(2000)
    await shot(page, '5-artists-search')
    await searchInput.fill('')
    await page.waitForTimeout(500)
  } catch (e) {
    console.log('  - search step skipped:', (e as Error).message.slice(0, 120))
  }

  console.log('[6] Select 3 artists')
  const artistButtons = await page.locator('button[aria-pressed]').all()
  console.log(`  - found ${artistButtons.length} artist buttons`)
  let selected = 0
  for (const b of artistButtons) {
    if (selected >= 5) break
    const pressed = await b.getAttribute('aria-pressed')
    if (pressed === 'true') continue // skip already selected
    const label = await b.getAttribute('aria-label') || ''
    if (!label) continue
    await b.click().catch(() => {})
    selected++
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(500)
  await shot(page, '6-artists-selected')

  console.log('[7] Click Continue on artists')
  await page.getByRole('button', { name: /^Continue$/i }).last().click().catch(() => {})
  await page.waitForTimeout(800)
  await shot(page, '7-genres')

  console.log('[8] Pick 3 genres')
  const genreButtons = await page.locator('button[aria-pressed]').all()
  let gpicked = 0
  for (const b of genreButtons) {
    if (gpicked >= 4) break
    const pressed = await b.getAttribute('aria-pressed')
    if (pressed === 'true') continue
    await b.click().catch(() => {})
    gpicked++
    await page.waitForTimeout(120)
  }
  await page.waitForTimeout(500)
  await shot(page, '8-genres-selected')

  console.log('[9] Continue → Summary')
  await page.getByRole('button', { name: /^Continue$|^Skip for now$/i }).last().click().catch(() => {})
  await page.waitForTimeout(800)
  await shot(page, '9-summary')

  console.log('[10] Finish → Home (with Daily Mixes)')
  await page.getByRole('button', { name: /^Finish$/i }).click().catch(() => {})
  // Poll until the "Made for" heading appears (Daily Mixes loaded) — up to 35s
  const startWait = Date.now()
  while (Date.now() - startWait < 35000) {
    const hasMadeFor = await page.locator('h1:has-text("Made for")').count()
    if (hasMadeFor > 0) {
      // Give it one more beat so the grid renders
      await page.waitForTimeout(800)
      break
    }
    await page.waitForTimeout(500)
  }
  console.log(`  - waited ${(Date.now() - startWait) / 1000}s for Daily Mixes`)
  await shot(page, '10-home-mixes')

  await browser.close()
  console.log('\nDONE')
}

main().catch((e) => { console.error(e); process.exit(1) })
