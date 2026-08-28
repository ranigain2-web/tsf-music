/**
 * Capture real Spotify signup / onboarding screens as the bar for gauntlet-loop.
 * Output: /home/z/my-project/download/bar/spotify-*.png
 *
 * Targets:
 *  - https://accounts.spotify.com/signup (initial form)
 *  - The artist/genre pickers inside the post-signup onboarding flow
 *    (this requires a fresh account each run; we attempt with a temp email)
 *
 * If the in-app onboarding flow needs login, we still capture the public signup
 * form as the closest comparable bar for typography, layout, color, and input style.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const OUT = '/home/z/my-project/download/bar'
mkdirSync(OUT, { recursive: true })

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile',  width: 390,  height: 844 },
]

async function shot(page: any, name: string, viewport: typeof VIEWPORTS[number]) {
  const path = `${OUT}/spotify-${name}-${viewport.name}.png`
  await page.screenshot({ path, fullPage: false })
  console.log(`✓ ${path}`)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp, locale: 'en-US' })
    const page = await ctx.newPage()

    // 1. Spotify signup form (public)
    try {
      console.log(`\n[${vp.name}] Spotify signup (accounts.spotify.com)…`)
      await page.goto('https://accounts.spotify.com/signup', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(2500)
      await shot(page, 'signup-form', vp)

      // Try to advance to "what's your name?" step by entering an email
      try {
        await page.fill('input[type="email"]', `tsf-test-${Date.now()}@example.com`).catch(() => {})
        await page.click('button:has-text("Next"), button[type="submit"]').catch(() => {})
        await page.waitForTimeout(2000)
        await shot(page, 'signup-form-2', vp)
      } catch (e) { console.log('  - step 2 skip', (e as Error).message) }
    } catch (e) {
      console.log(`  ✗ signup-form failed: ${(e as Error).message}`)
    }

    // 2. Spotify US homepage hero — typography & green reference
    try {
      console.log(`[${vp.name}] Spotify US homepage…`)
      await page.goto('https://www.spotify.com/us/', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(2500)
      await shot(page, 'home', vp)
    } catch (e) {
      console.log(`  ✗ home failed: ${(e as Error).message}`)
    }

    // 3. Open.spotify.com web player (often requires login — but the landing
    //    pre-login screen and the "Get Premium" / download CTAs are public)
    try {
      console.log(`[${vp.name}] open.spotify.com landing…`)
      await page.goto('https://open.spotify.com/', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(2500)
      await shot(page, 'web-player-landing', vp)
    } catch (e) {
      console.log(`  ✗ web-player failed: ${(e as Error).message}`)
    }

    await ctx.close()
  }
  await browser.close()
  console.log('\nDONE — screenshots in', OUT)
}

main().catch((e) => { console.error(e); process.exit(1) })
