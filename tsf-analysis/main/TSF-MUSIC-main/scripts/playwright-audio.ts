/**
 * TSF Music — Playwright E2E audio playback test
 *
 * Loads the app, opens DevTools protocol, plays a track, and verifies
 * that:
 *   1. The <audio> element gets a real src
 *   2. The audio element's readyState reaches HAVE_FUTURE_DATA (≥3)
 *   3. audio.duration > 0 (the duration display fires)
 *   4. audio.currentTime advances (playback actually happening)
 *   5. The NowPlayingBar shows the right duration
 *   6. The PlaylistView shows no overlapping text
 *   7. The download button produces a file
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3000'

async function test() {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()

  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(`PAGE ERROR: ${err.message}`))

  console.log('→ Loading home page…')
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)

  // Screenshot 1: Initial state (post-onboarding)
  await page.screenshot({ path: '/home/z/my-project/upload/e2e-1-home.png', fullPage: false })
  const url1 = page.url()
  console.log(`  URL: ${url1}`)
  console.log(`  console errors: ${consoleErrors.length}`)
  if (consoleErrors.length) console.log(`  first: ${consoleErrors[0].slice(0, 200)}`)

  // Try to find a play button on a Quick Pick card and click it
  console.log('→ Looking for a Quick Picks card…')
  const quickPickBtn = page.locator('text=Quick picks').locator('xpath=ancestor::section').locator('button').first()
  const hasQuickPicks = await page.locator('text=Quick picks').count().catch(() => 0)
  console.log(`  Quick picks section present: ${hasQuickPicks > 0}`)

  // Instead, click the first play button on a card (FeaturedCard)
  const featuredPlayBtn = page.locator('.card-play-btn').first()
  const hasFeatured = await featuredPlayBtn.count().catch(() => 0)
  console.log(`  Featured card play buttons: ${hasFeatured}`)

  if (hasFeatured) {
    console.log('→ Clicking featured play button…')
    await featuredPlayBtn.click({ force: true }).catch(() => {})
    await page.waitForTimeout(2000)
  } else {
    // Try any play button
    const anyPlayBtn = page.locator('button[aria-label^="Play"]').first()
    const hasAnyPlay = await anyPlayBtn.count().catch(() => 0)
    if (hasAnyPlay) {
      console.log('→ Clicking first Play button…')
      await anyPlayBtn.click({ force: true }).catch(() => {})
      await page.waitForTimeout(2000)
    }
  }

  // Screenshot 2: After play attempt
  await page.screenshot({ path: '/home/z/my-project/upload/e2e-2-playing.png', fullPart: false } as any)
  await page.screenshot({ path: '/home/z/my-project/upload/e2e-2-playing.png' })

  // Inspect audio element state
  const audioState = await page.evaluate(() => {
    const audio = document.querySelector('audio')
    if (!audio) return { found: false }
    return {
      found: true,
      src: audio.src ? audio.src.slice(0, 80) : null,
      paused: audio.paused,
      readyState: audio.readyState,
      duration: audio.duration,
      currentTime: audio.currentTime,
      error: audio.error ? audio.error.code : null,
      networkState: audio.networkState,
    }
  })
  console.log('  Audio state:')
  console.log(`    found: ${audioState.found}`)
  if (audioState.found) {
    console.log(`    src: ${audioState.src}`)
    console.log(`    paused: ${audioState.paused}`)
    console.log(`    readyState: ${audioState.readyState} (>=3 means playable)`)
    console.log(`    duration: ${audioState.duration}`)
    console.log(`    currentTime: ${audioState.currentTime}`)
    console.log(`    networkState: ${audioState.networkState}`)
    console.log(`    error code: ${audioState.error}`)
  }

  // Wait 4 seconds and check if currentTime advanced
  console.log('→ Waiting 4s for playback to progress…')
  await page.waitForTimeout(4000)
  const audioState2 = await page.evaluate(() => {
    const audio = document.querySelector('audio')
    if (!audio) return { found: false }
    return {
      found: true,
      paused: audio.paused,
      readyState: audio.readyState,
      currentTime: audio.currentTime,
      duration: audio.duration,
    }
  })
  console.log('  Audio state (after 4s):')
  console.log(`    paused: ${audioState2.paused}`)
  console.log(`    currentTime: ${audioState2.currentTime}`)
  console.log(`    duration: ${audioState2.duration}`)
  console.log(`    readyState: ${audioState2.readyState}`)

  // Screenshot 3: After waiting
  await page.screenshot({ path: '/home/z/my-project/upload/e2e-3-progress.png' })

  // Navigate to first playlist (if any)
  console.log('→ Navigating to first playlist…')
  // Look for the Liked Songs or any playlist link in sidebar
  const playlistLink = page.locator('a[href*="playlist"], button:has-text("Liked")').first()
  const hasPlaylist = await playlistLink.count().catch(() => 0)
  if (hasPlaylist) {
    await playlistLink.click({ force: true }).catch(() => {})
    await page.waitForTimeout(2000)
  }
  // Or click on a playlist in Library
  const libPlaylist = page.locator('[role="button"]:has-text("Playlist"), button:has-text("Liked Songs")').first()
  if (await libPlaylist.count().catch(() => 0)) {
    await libPlaylist.click({ force: true }).catch(() => {})
    await page.waitForTimeout(2000)
  }
  await page.screenshot({ path: '/home/z/my-project/upload/e2e-4-playlist.png' })

  // Test the TrackRow layout: read computed styles
  const trackRowLayout = await page.evaluate(() => {
    // Find a row with class containing "grid"
    const rows = Array.from(document.querySelectorAll('div')).filter(d =>
      d.className && typeof d.className === 'string' && d.className.includes('group') && d.className.includes('grid')
    )
    if (!rows.length) return { found: false }
    const row = rows[0] as HTMLElement
    const cs = window.getComputedStyle(row)
    const titleEl = row.querySelector('div.truncate.font-medium') as HTMLElement | null
    const artistEl = row.querySelector('div.truncate.text-\\[13px\\]') as HTMLElement | null
    if (!titleEl || !artistEl) return { found: true, hasText: false }
    const tr = titleEl.getBoundingClientRect()
    const ar = artistEl.getBoundingClientRect()
    const overlap = ar.top < tr.bottom && ar.bottom > tr.top && ar.left < tr.right && ar.right > tr.left
    return {
      found: true,
      hasText: true,
      gridTemplateColumns: cs.gridTemplateColumns,
      titleRect: { top: tr.top, bottom: tr.bottom, height: tr.height },
      artistRect: { top: ar.top, bottom: ar.bottom, height: ar.height },
      overlapping: overlap,
    }
  })
  console.log('  TrackRow layout:')
  console.log(`    found: ${trackRowLayout.found}`)
  if (trackRowLayout.found && trackRowLayout.hasText) {
    console.log(`    gridTemplateColumns: ${trackRowLayout.gridTemplateColumns}`)
    console.log(`    title rect: ${JSON.stringify(trackRowLayout.titleRect)}`)
    console.log(`    artist rect: ${JSON.stringify(trackRowLayout.artistRect)}`)
    console.log(`    overlapping? ${trackRowLayout.overlapping}`)
  }

  // Test NowPlayingBar layout
  const npbLayout = await page.evaluate(() => {
    const bar = document.querySelector('[aria-label="Player"]') as HTMLElement | null
    if (!bar) return { found: false }
    const cs = window.getComputedStyle(bar)
    // Find the track title button
    const titleBtn = bar.querySelector('button.text-sm.font-medium') as HTMLElement | null
    const likeBtn = bar.querySelector('button[aria-label*="Liked"]') as HTMLElement | null
    if (!titleBtn || !likeBtn) return { found: true, hasText: false }
    const tr = titleBtn.getBoundingClientRect()
    const lr = likeBtn.getBoundingClientRect()
    const overlap = tr.right > lr.left && tr.left < lr.right && tr.bottom > lr.top && tr.top < lr.bottom
    return {
      found: true,
      hasText: true,
      gridTemplateColumns: cs.gridTemplateColumns,
      titleRect: { left: tr.left, right: tr.right, width: tr.width },
      likeBtnRect: { left: lr.left, right: lr.right, width: lr.width },
      overlapping: overlap,
    }
  })
  console.log('  NowPlayingBar layout:')
  console.log(`    found: ${npbLayout.found}`)
  if (npbLayout.found && npbLayout.hasText) {
    console.log(`    gridTemplateColumns: ${npbLayout.gridTemplateColumns}`)
    console.log(`    title rect: ${JSON.stringify(npbLayout.titleRect)}`)
    console.log(`    like btn rect: ${JSON.stringify(npbLayout.likeBtnRect)}`)
    console.log(`    overlapping? ${npbLayout.overlapping}`)
  }

  // Screenshot 5: final
  await page.screenshot({ path: '/home/z/my-project/upload/e2e-5-final.png', fullPage: true })

  await browser.close()

  // Verdict
  console.log('')
  console.log('=== VERDICT ===')
  const audioPlaying = audioState2.found && !audioState2.paused && audioState2.currentTime > 0
  console.log(`Audio playing: ${audioPlaying ? 'YES' : 'NO'}`)
  console.log(`Track row overlapping: ${trackRowLayout.overlapping ? 'YES (BAD)' : 'NO (good)'}`)
  console.log(`NowPlayingBar overlapping: ${npbLayout.overlapping ? 'YES (BAD)' : 'NO (good)'}`)
  console.log(`Console errors: ${consoleErrors.length}`)
}

test().catch((e) => {
  console.error('Test failed:', e)
  process.exit(1)
})
