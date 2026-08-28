/** Test: real Chromium via Playwright extracts audio stream URLs from a YouTube watch page */
import { chromium } from 'playwright'

const VIDEO = 'LKYPYj2XX80' // Daft Punk - Around the World

async function main() {
  console.log('launching chromium...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
  })
  // stealth-ish: override webdriver flag
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })

  const page = await ctx.newPage()
  const t0 = Date.now()
  console.log('navigating to watch page...')
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  console.log(`page loaded in ${Date.now() - t0}ms — title: ${await page.title()}`)

  // dismiss consent dialog if present
  for (const sel of ['button[aria-label*="Accept"]', 'button[aria-label*="Reject"]', 'tp-yt-paper-button[aria-label*="Accept the use"]']) {
    try {
      const btn = await page.$(sel)
      if (btn) { await btn.click({ timeout: 2000 }); console.log('dismissed consent via', sel); break }
    } catch {}
  }

  // extract player response
  console.log('extracting player response...')
  const playerResponse = await page.evaluate(() => {
    const p = document.getElementById('movie_player') as any
    if (p && typeof p.getPlayerResponse === 'function') return p.getPlayerResponse()
    // fallback: ytInitialPlayerResponse global
    return (window as any).ytInitialPlayerResponse || null
  })

  if (!playerResponse) {
    console.log('!! no player response found')
    const html = await page.content()
    console.log('page has bot check:', html.includes('confirm you') || html.includes('not a bot'))
    await browser.close()
    return
  }

  const status = playerResponse?.playabilityStatus?.status
  const formats = [...(playerResponse?.streamingData?.adaptiveFormats || []), ...(playerResponse?.streamingData?.formats || [])]
  const audio = formats.filter((f: any) => f.mimeType?.includes('audio/mp4')).sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))
  console.log(`playability=${status} formats=${formats.length} audioFormats=${audio.length} best=${audio[0]?.itag}/${audio[0]?.bitrate}bps url=${!!audio[0]?.url}`)
  console.log(`audio duration: ${playerResponse?.videoDetails?.lengthSeconds}s title="${playerResponse?.videoDetails?.title}"`)

  if (audio[0]?.url) {
    // probe the URL from node (outside browser, same machine egress IP)
    const r = await fetch(audio[0].url, { headers: { Range: 'bytes=0-65535' } })
    const b = await r.arrayBuffer()
    console.log(`\nprobe outside browser: HTTP ${r.status} ${r.headers.get('content-type')} ${b.byteLength}B`)
    if (r.status === 206 || r.status === 200) console.log('=== BROWSER EXTRACTION WORKS — WE HAVE AUDIO ===')
  }
  await browser.close()
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
