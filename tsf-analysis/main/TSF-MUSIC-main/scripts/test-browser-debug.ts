/** Debug browser: what does YouTube serve to headless Chromium on this IP? */
import { chromium } from 'playwright'

const VIDEO = 'LKYPYj2XX80'

async function inspect(page: any, label: string) {
  const title = await page.title().catch(() => '?')
  const url = page.url()
  const html = await page.content().catch(() => '')
  console.log(`--- ${label} ---`)
  console.log(`title: "${title}"`)
  console.log(`url: ${url}`)
  console.log(`html length: ${html.length}`)
  console.log(`contains 'ytInitialPlayerResponse': ${html.includes('ytInitialPlayerResponse')}`)
  console.log(`contains consent: ${html.includes('consent.youtube.com')}`)
  console.log(`contains 'Sorry for the interruption' / bot: ${html.includes('not a bot') || html.includes('unusual traffic')}`)
  // try extracting via global
  const pr = await page.evaluate(() => (window as any).ytInitialPlayerResponse?.playabilityStatus ?? null).catch(() => null)
  console.log(`window.ytInitialPlayerResponse.playabilityStatus: ${JSON.stringify(pr)?.slice(0, 200)}`)
  await page.screenshot({ path: `/home/z/my-project/scripts/shot-${label}.png` }).catch(() => {})
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'] })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    // fake plugins to look real
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
  })
  const page = await ctx.newPage()

  // A. youtube watch
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e: any) => console.log('nav err', e.message))
  await page.waitForTimeout(3000)
  await inspect(page, 'watch')

  // B. youtube music
  await page.goto(`https://music.youtube.com/watch?v=${VIDEO}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e: any) => console.log('nav err', e.message))
  await page.waitForTimeout(3000)
  await inspect(page, 'ytmusic')
  await browser.close()
}
main()
