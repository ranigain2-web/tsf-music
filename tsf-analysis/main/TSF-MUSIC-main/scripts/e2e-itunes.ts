/**
 * TSF Music — E2E gauntlet: REAL audio (iTunes previews) in the browser.
 *
 * The user's complaint: every track played "dummy" audio (procedural synth).
 * This gauntlet verifies the fix END-TO-END in a real browser:
 *   1. Click a track → audio plays REAL Apple-catalog audio
 *      (browser network shows requests to audio-ssl.itunes.apple.com)
 *   2. Duration ≈ 30s preview (NOT 14s demo, NOT 138-600s synth)
 *   3. Playback genuinely advances (decoding real AAC)
 *   4. Next track → different REAL audio bytes from Apple's CDN
 *   5. Mini-player duration text matches actual audio duration
 *   6. Download button → saves the REAL m4a recording (>100KB, mp4 magic)
 *   7. Zero console errors
 */
import { chromium } from 'playwright'
import { writeFileSync } from 'fs'

const BASE = 'http://127.0.0.1:3000'
let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`) }
}

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const consoleErrors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(`PAGE ERROR: ${e.message}`))

// Track every network request that touches Apple's audio CDN
const appleRequests: { url: string; bytes: Buffer }[] = []
page.on('response', async (res) => {
  try {
    const u = res.url()
    if (u.includes('itunes.apple.com') && u.includes('mzaf')) {
      const buf = Buffer.from(await res.body())
      appleRequests.push({ url: u, bytes: buf })
    }
  } catch { /* body unavailable (streamed/redirect) — fine */ }
})

console.log('→ Loading app…')
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)

const audioState = () => page.evaluate(() => {
  const a = document.querySelector('audio')
  if (!a) return { found: false }
  return {
    found: true,
    src: a.src,
    currentSrc: a.currentSrc,
    paused: a.paused,
    readyState: a.readyState,
    duration: a.duration,
    currentTime: a.currentTime,
  }
})

// ---------- 1. play track 1 ----------
console.log('\n[1] Click first track — expect REAL Apple audio')
await page.locator('.card-play-btn').first().click({ force: true }).catch(() => {})
await page.waitForTimeout(5000) // resolve + redirect + buffer + play
let st = await audioState()
check('audio element present', st.found)
check('audio playing (not paused)', st.found && !st.paused, `paused=${st.paused}`)
check('readyState ≥ 3 (decoding)', st.found && st.readyState >= 3, `readyState=${st.readyState}`)
check('duration is preview-scale ~30s (NOT 14s demo, NOT 138-600s synth)',
  st.found && st.duration > 20 && st.duration < 45, `duration=${st.duration?.toFixed(1)}s`)
check('currentTime advancing (real decode)', st.found && st.currentTime > 1, `t=${st.currentTime?.toFixed(2)}s`)
const appleBefore = appleRequests.length
check('browser fetched REAL audio from Apple CDN', appleBefore > 0, `${appleBefore} request(s), first=${appleRequests[0]?.url.slice(30, 90)}`)
if (appleRequests[0]) {
  const b = appleRequests[0].bytes
  const isMp4 = b.length > 11 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
  check('Apple CDN bytes are REAL m4a (ftyp magic, not WAV)', isMp4, `${b.length} bytes`)
}
await page.screenshot({ path: '/home/z/my-project/upload/e2e-itunes-1-playing.png' })

// ---------- 2. mini player duration ----------
console.log('\n[2] Mini-player duration display')
const barText = await page.evaluate(() => {
  const bar = document.querySelector('div[role="region"][aria-label="Player"]')
  return bar ? bar.textContent || '' : ''
})
const durMatches = [...barText.matchAll(/(\d+):(\d{2})/g)]
if (durMatches.length) {
  const m = durMatches[durMatches.length - 1]
  const mmss = parseInt(m[1]) * 60 + parseInt(m[2])
  check('mini duration text ≈ audio duration (~30s)', Math.abs(mmss - (st.duration || 0)) < 3, `text=${m[0]} audio=${st.duration?.toFixed(1)}s`)
} else {
  check('mini duration text present', false, barText.slice(0, 140))
}

// ---------- 3. next track → different REAL audio ----------
console.log('\n[3] Next track — different real recording')
const nextBtn = page.locator('div[role="region"][aria-label="Player"] button[aria-label*="Next" i]').first()
const bytesBefore = appleRequests.map(r => r.bytes.length).join(',')
if (await nextBtn.count()) {
  await nextBtn.click({ force: true })
  // wait for the new track to resolve + play
  let st2: any = null
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500)
    st2 = await audioState()
    if (st2.found && isFinite(st2.duration) && st2.duration > 0 && st2.currentTime > 0.3 && !st2.paused) break
  }
  check('second track playing', st2?.found && !st2.paused, `t=${st2?.currentTime?.toFixed(2)}s dur=${st2?.duration?.toFixed(1)}s`)
  const newApple = appleRequests.slice(0)
  check('second track ALSO fetched from Apple CDN (real audio)', newApple.length > appleBefore, `total=${newApple.length}`)
  // distinct audio: compare the first 2 apple byte payloads
  const payloads = appleRequests.filter(r => r.bytes.length > 1000).map(r => r.bytes)
  if (payloads.length >= 2) {
    let distinct = false
    for (let i = 0; i < payloads.length && !distinct; i++)
      for (let j = i + 1; j < payloads.length && !distinct; j++) {
        let diff = 0
        const n = Math.min(4096, payloads[i].length, payloads[j].length)
        for (let k = 0; k < n; k++) if (payloads[i][k] !== payloads[j][k]) { diff++; break }
        if (diff > 0) distinct = true
      }
    check('audio bytes DIFFER between tracks (no shared dummy)', distinct)
  } else {
    check('two apple payloads captured', false, `captured=${payloads.length}`)
  }
  await page.screenshot({ path: '/home/z/my-project/upload/e2e-itunes-2-second-track.png' })
} else {
  check('next button found', false)
}

// ---------- 4. download the REAL recording ----------
console.log('\n[4] Download — real m4a saved')
const dlPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null)
await page.locator('div[role="region"][aria-label="Player"] button[aria-label="Download this track"]').first().click({ force: true })
const dl = await dlPromise
if (dl) {
  const path = '/home/z/my-project/upload/e2e-itunes-download.m4a'
  await dl.saveAs(path)
  const fs = await import('fs')
  const buf = fs.readFileSync(path)
  const isMp4 = buf.length > 11 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70
  check('download saved', true, dl.suggestedFilename())
  check('downloaded file is REAL m4a > 100KB', isMp4 && buf.length > 100000, `${(buf.length / 1024).toFixed(0)}KB magic=ftyp`)
} else {
  check('download event fired', false)
}

// ---------- 5. console errors ----------
console.log('\n[5] Console health')
check('zero console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ').slice(0, 200))

console.log(`\n=== BROWSER E2E RESULT: ${pass} passed, ${fail} failed ===`)
await browser.close()
process.exit(fail > 0 ? 1 : 0)
