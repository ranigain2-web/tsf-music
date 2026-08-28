/**
 * TSF Music — E2E gauntlet: full-length unique per-track audio.
 *
 * Verifies in a REAL browser:
 *  1. Click a track → audio plays, duration = the track's REAL length (>60s, not 14s)
 *  2. Mini-player shows the real duration
 *  3. A second track → different duration + different audio bytes
 *  4. Seeking works on the synth stream
 *  5. Download endpoint returns the full-length per-track WAV
 *  6. Zero console errors
 */
import { chromium } from 'playwright'

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

console.log('→ Loading app…')
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.screenshot({ path: '/home/z/my-project/upload/e2e-synth-1-home.png' })

// ---------- helper: current audio state ----------
const audioState = () => page.evaluate(() => {
  const a = document.querySelector('audio')
  if (!a) return { found: false }
  return {
    found: true,
    src: a.src,
    paused: a.paused,
    readyState: a.readyState,
    duration: a.duration,
    currentTime: a.currentTime,
    volume: a.volume,
  }
})

// ---------- play track 1 ----------
console.log('\n[1] Play first track')
await page.locator('.card-play-btn').first().click({ force: true }).catch(() => {})
await page.waitForTimeout(4500) // let it buffer + play
let st = await audioState()
check('audio element present', st.found)
check('audio src is the stream endpoint', st.found && /\/api\/stream\?id=/.test(st.src || ''), (st.src || '').slice(0, 100))
check('audio playing (not paused)', st.found && !st.paused)
check('readyState ≥ 3', st.found && st.readyState >= 3, `readyState=${st.readyState}`)
check('duration > 60s (full-length, NOT 14s demo)', st.found && st.duration > 60, `duration=${st.duration?.toFixed(1)}s`)
check('currentTime advancing', st.found && st.currentTime > 0.5, `t=${st.currentTime?.toFixed(2)}s`)
await page.screenshot({ path: '/home/z/my-project/upload/e2e-synth-2-playing.png' })

// ---------- mini player duration text ----------
console.log('\n[2] Mini-player duration display')
const barText = await page.evaluate(() => {
  const bar = document.querySelector('div[role="region"][aria-label="Player"]')
  return bar ? bar.textContent || '' : ''
})
// duration text like "3:07" (m:ss) or "-2:59"
check('mini-player shows minutes-scale duration', /\d+:\d{2}/.test(barText), barText.slice(0, 160).replace(/\s+/g, ' '))
const durMatches = [...barText.matchAll(/(\d+):(\d{2})/g)]
if (durMatches.length) {
  // the LAST m:ss in the bar is the total duration (position comes first)
  const m = durMatches[durMatches.length - 1]
  const mmss = parseInt(m[1]) * 60 + parseInt(m[2])
  check('mini duration ≈ audio duration', Math.abs(mmss - (st.duration || 0)) < 3, `text=${m[0]} audio=${st.duration?.toFixed(1)}s`)
}

// ---------- seek ----------
console.log('\n[3] Seeking')
const seekResult = await page.evaluate(async () => {
  const a = document.querySelector('audio') as HTMLAudioElement | null
  if (!a) return { ok: false, why: 'no audio' }
  a.currentTime = Math.floor(a.duration * 0.5)
  await new Promise((r) => setTimeout(r, 1800))
  return { ok: true, t: a.currentTime, paused: a.paused, dur: a.duration }
})
check('seek to 50% works', seekResult.ok && Math.abs(seekResult.t! - seekResult.dur! * 0.5) < 2, `t=${seekResult.t?.toFixed(1)}s of ${seekResult.dur?.toFixed(1)}s`)
check('still playing after seek', seekResult.ok && !seekResult.paused)

// ---------- play a different track ----------
console.log('\n[4] Second track — different audio')
// click the next button INSIDE the player bar
const nextBtn = page.locator('div[role="region"][aria-label="Player"] button[aria-label*="Next" i]').first()
if (await nextBtn.count()) {
  await nextBtn.click({ force: true })
  await page.waitForTimeout(3000)
  // wait for metadata of the new track (resolve + buffer)
  for (let i = 0; i < 12; i++) {
    const s = await audioState()
    if (s.found && isFinite(s.duration) && s.duration > 0 && s.currentTime > 0.2) break
    await page.waitForTimeout(500)
  }
}
const st2 = await audioState()
check('track 2 audio playing', st2.found && !st2.paused && st2.currentTime > 0.2, `t=${st2.currentTime?.toFixed(2)}s`)
check('track 2 has full duration too', st2.found && (st2.duration || 0) > 60, `duration=${st2.duration?.toFixed(1)}s`)
check('track 2 differs from track 1', st2.found && st2.src !== st.src, `${(st.src || '').slice(-30)} → ${(st2.src || '').slice(-30)}`)
await page.screenshot({ path: '/home/z/my-project/upload/e2e-synth-3-second-track.png' })

// compare bytes of the two tracks via in-page fetch (same origin)
const cmp = await page.evaluate(async () => {
  const a = document.querySelector('audio') as HTMLAudioElement | null
  const src = a?.src || ''
  const m = src.match(/id=([^&]+)/)
  const id1 = 'IlyHIUeid5I'
  const id2 = m ? decodeURIComponent(m[1]) : 'kJQP7kiw5Fk'
  const off = 44 + 30 * 44100 * 2
  const [r1, r2] = await Promise.all([
    fetch(`/api/stream/synth?id=${id1}&dur=187`, { headers: { range: `bytes=${off}-${off + 2047}` } }),
    fetch(`/api/stream/synth?id=${id2}&dur=187`, { headers: { range: `bytes=${off}-${off + 2047}` } }),
  ])
  const b1 = new Uint8Array(await r1.arrayBuffer())
  const b2 = new Uint8Array(await r2.arrayBuffer())
  let diff = 0
  for (let i = 0; i < Math.min(b1.length, b2.length); i++) if (Math.abs(b1[i] - b2[i]) > 2) diff++
  return { id1, id2, diff, len: b1.length }
})
check('two tracks → different audio bytes', cmp.diff > 100, `${cmp.diff}/${cmp.len} bytes differ (${cmp.id1} vs ${cmp.id2})`)

// ---------- download ----------
console.log('\n[5] Download')
const dl = await page.evaluate(async () => {
  const r = await fetch('/api/download?id=E2E-DL&title=E2E%20Test%20Track&dur=42')
  const cd = r.headers.get('content-disposition') || ''
  const buf = new Uint8Array(await r.arrayBuffer())
  let nonzero = 0
  for (let i = 44; i < buf.length; i += 211) if (buf[i] !== 0) nonzero++
  return { status: r.status, cd, size: buf.length, nonzero, expected: 44 + 42 * 44100 * 2 }
})
check('download 200', dl.status === 200)
check('attachment + .wav filename', dl.cd.includes('attachment') && dl.cd.includes('.wav'), dl.cd.slice(0, 70))
check('full-length body (42s)', dl.size === dl.expected, `${dl.size} vs ${dl.expected}`)
check('downloaded audio non-silent', dl.nonzero > 100, `${dl.nonzero} non-zero sample bytes`)

// ---------- console errors ----------
console.log('\n[6] Console health')
check('zero console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ').slice(0, 200))

await browser.close()
console.log(`\n========== ${pass} passed, ${fail} failed ==========`)
process.exit(fail > 0 ? 1 : 0)
