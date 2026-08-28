/**
 * TSF Synth Engine — unit-level gauntlet tests.
 * Run: bun scripts/test-synth.ts
 *
 * Tests:
 *  1. Determinism — same (videoId, dur) → byte-identical WAV
 *  2. Uniqueness  — different videoIds → different audio (multiple offsets)
 *  3. Duration    — rendered length matches requested duration
 *  4. Musicality  — non-silent, no clipping, section dynamics vary,
 *                   spectral content present (bass + mids + highs)
 *  5. Performance — render speed (samples/sec) fast enough for streaming
 *  6. Range math  — arbitrary byte ranges render consistently with full render
 */
import { buildPlan, clampDuration } from '../src/lib/synth/arrangement'
import { renderSamples, renderWavBytes, wavTotalBytes, makeWavHeader, parseRange } from '../src/lib/synth/render'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ---------- 1+2: determinism & uniqueness ----------
console.log('\n[1] Determinism & [2] Uniqueness')
const ids = ['IlyHIUeid5I', 'kJQP7kiw5Fk', '3JZ_D3ELwOQ', 'dQw4w9WgXcQ', 'abcdef12345']
const plans = ids.map((id) => buildPlan(id, 187))
const plans2 = ids.map((id) => buildPlan(id, 187)) // rebuild → cache hit

for (let i = 0; i < ids.length; i++) {
  const p1 = plans[i]
  const p2 = plans2[i]
  const b1 = renderWavBytes(p1, 44, 65536)
  const b2 = renderWavBytes(p2, 44, 65536)
  let same = b1.length === b2.length
  for (let k = 0; same && k < b1.length; k++) if (b1[k] !== b2[k]) same = false
  check(`deterministic ${ids[i]}`, same)
}

// uniqueness across pairs at 3 offsets (skip pure silence regions)
let allUnique = true
for (let a = 0; a < ids.length; a++) {
  for (let b = a + 1; b < ids.length; b++) {
    for (const off of [44 + 44100 * 30 * 2, 44 + 44100 * 60 * 2, 44 + 44100 * 90 * 2]) {
      const ba = renderWavBytes(plans[a], off, 4096)
      const bb = renderWavBytes(plans[b], off, 4096)
      let diff = false
      for (let k = 0; k < ba.length; k++) if (Math.abs(ba[k] - bb[k]) > 2) { diff = true; break }
      if (!diff) { allUnique = false; console.log(`    ${ids[a]} vs ${ids[b]} @${off} identical`) }
    }
  }
}
check('all tracks unique at all offsets', allUnique)

// metadata uniqueness
const bpms = new Set(plans.map((p) => p.bpm))
const keys = new Set(plans.map((p) => p.events.find((e) => e.inst === 'bass')?.freq))
const genres = new Set(plans.map((p) => p.genre))
check('tempo variety across tracks', bpms.size >= 2, `${[...bpms].join(', ')} bpm`)
check('genre variety across tracks', genres.size >= 2, [...genres].join(', '))
check('bass/key variety across tracks', keys.size >= 3, `${keys.size}/5 distinct bass roots`)

// ---------- 3: duration ----------
console.log('\n[3] Duration honored')
for (const d of [21, 45, 93, 187, 250, 420]) {
  const p = buildPlan(`durtest-${d}`, d)
  const total = wavTotalBytes(p)
  const wavDur = (total - 44) / 44100 / 2
  check(`dur=${d}s → WAV ${wavDur.toFixed(1)}s`, Math.abs(wavDur - clampDuration(d)) < 0.01)
}
const pShort = buildPlan('shorty', 21)
check('short track has events', pShort.events.length > 20, `${pShort.events.length} events`)
const pLong = buildPlan('longy', 420)
check('long track has many events', pLong.events.length > 1000, `${pLong.events.length} events`)

// ---------- 4: musicality ----------
console.log('\n[4] Musicality (RMS, dynamics, spectrum)')
function rms(buf: Float32Array): number {
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
  return Math.sqrt(s / buf.length)
}
function peak(buf: Float32Array): number {
  let m = 0
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a }
  return m
}

for (const p of plans) {
  // intro (t=4s), verse (t=20s), chorus — find first chorus start ~ intro+verse
  const intro = renderSamples(p, 4 * 44100, 44100)
  const mid = renderSamples(p, Math.floor(p.durationSec * 0.35) * 44100, 44100)
  const loud = renderSamples(p, Math.floor(p.durationSec * 0.5) * 44100, 44100)
  const rIntro = rms(intro), rMid = rms(mid), rLoud = rms(loud)
  check(`${p.videoId} non-silent (intro RMS>0.01)`, rIntro > 0.01, `RMS intro=${rIntro.toFixed(3)} mid=${rMid.toFixed(3)} loud=${rLoud.toFixed(3)}`)
  check(`${p.videoId} no clipping (peak<0.999)`, peak(loud) < 0.999, `peak=${peak(loud).toFixed(3)}`)
  check(`${p.videoId} dynamics vary across sections`, Math.abs(rLoud - rIntro) > 0.005 || Math.abs(rMid - rIntro) > 0.005)

  // crude spectrum check via zero-crossing rate bands
  const full = renderSamples(p, 20 * 44100, 44100 * 2)
  let zc = 0
  for (let i = 1; i < full.length; i++) if ((full[i] >= 0) !== (full[i - 1] >= 0)) zc++
  const zcr = zc / full.length
  check(`${p.videoId} has spectral variety (ZCR 0.02..0.5)`, zcr > 0.02 && zcr < 0.5, `ZCR=${zcr.toFixed(3)}`)
}

// fade in/out sanity
const pf = buildPlan('fadetest', 60)
const first = renderSamples(pf, 0, 64)
check('starts from silence (fade-in)', Math.abs(first[0]) < 0.001)
const tail = renderSamples(pf, pf.totalSamples - 32, 32)
check('ends at silence (fade-out)', Math.abs(tail[tail.length - 1]) < 0.001)

// ---------- 5: performance ----------
console.log('\n[5] Performance')
{
  const p = buildPlan('perftest', 240)
  const N = 44100 * 4 // 4 seconds of audio
  const t0 = performance.now()
  renderSamples(p, 44100 * 30, N)
  const dt = performance.now() - t0
  const rt = (N / 44100) / (dt / 1000)
  check(`render 4s audio in <400ms (${dt.toFixed(0)}ms, ${rt.toFixed(1)}x realtime)`, dt < 400)
}

// ---------- 6: range consistency ----------
console.log('\n[6] Range render consistency')
{
  const p = buildPlan('rangetest', 120)
  const full = renderWavBytes(p, 44, 44100 * 2 * 30) // first 30s
  // render the same span in 3 odd-sized chunks
  const c1 = renderWavBytes(p, 44, 300001)
  const c2 = renderWavBytes(p, 44 + 300001, 300001)
  const c3 = renderWavBytes(p, 44 + 600002, 44100 * 2 * 30 - 600002)
  const stitched = Buffer.concat([c1, c2, c3])
  let same = stitched.length === full.length
  for (let k = 0; same && k < full.length; k++) if (full[k] !== stitched[k]) same = false
  check('chunked render == full render (odd boundaries)', same, `${full.length} bytes`)

  // WAV header integrity
  const hdr = makeWavHeader(wavTotalBytes(p))
  check('WAV header RIFF/WAVE', String.fromCharCode(...hdr.slice(0, 4)) === 'RIFF' && String.fromCharCode(...hdr.slice(8, 12)) === 'WAVE')
  const dv = new DataView(hdr.buffer)
  check('WAV header mono 16-bit 44.1k', dv.getUint16(22, true) === 1 && dv.getUint32(24, true) === 44100 && dv.getUint16(34, true) === 16)

  // range parser
  const req = new Request('http://x/audio.wav', { headers: { range: 'bytes=100-199' } })
  const r = parseRange(req, 1000)
  check('range parser 100-199', r.start === 100 && r.end === 199 && r.isRange)
  const req2 = new Request('http://x/audio.wav', { headers: { range: 'bytes=0-' } })
  const r2 = parseRange(req2, 1000)
  check('range parser 0- (open)', r2.start === 0 && r2.end === 999)
}

// ---------- 7: genre/structure sanity ----------
console.log('\n[7] Structure')
{
  const p = buildPlan('structtest', 200)
  const kinds = new Set<string>()
  let lastStart = 0
  for (const e of p.events) {
    kinds.add(e.inst)
    if (e.start + e.len > lastStart) lastStart = e.start + e.len
  }
  check('has drums+bass+pad+lead', ['kick', 'snare', 'hat', 'bass', 'pad', 'lead'].every((k) => kinds.has(k)), [...kinds].join(','))
  check('events span ≥80% of duration', lastStart >= p.totalSamples * 0.8, `${(lastStart / 44100).toFixed(0)}s / ${p.durationSec}s`)
}

console.log(`\n========== ${pass} passed, ${fail} failed ==========`)
process.exit(fail > 0 ? 1 : 0)
