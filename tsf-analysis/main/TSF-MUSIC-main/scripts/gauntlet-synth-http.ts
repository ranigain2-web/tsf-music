/**
 * TSF Music — HTTP gauntlet for the synth streaming pipeline.
 * Run: bun scripts/gauntlet-synth-http.ts   (dev server must be on :3000)
 *
 * Verifies:
 *  1. /api/stream/synth serves correct WAV headers + full length
 *  2. Range requests → 206 + correct Content-Range
 *  3. Different tracks → different bytes over HTTP
 *  4. Same track twice → identical bytes (determinism via HTTP)
 *  5. /api/stream?id= full chain falls back to tsf-synth with dur honored
 *  6. /api/download returns attachment with correct filename + full body
 *  7. TTFB fast enough for instant playback start
 */
const BASE = 'http://127.0.0.1:3000'
let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`) }
}
const SR = 44100

async function getRangeBytes(url: string, start: number, count: number) {
  const r = await fetch(url, { headers: { range: `bytes=${start}-${start + count - 1}` } })
  return { status: r.status, headers: r.headers, bytes: new Uint8Array(await r.arrayBuffer()) }
}

// ---------- 1: synth route basics ----------
console.log('\n[1] /api/stream/synth basics')
{
  const t0 = performance.now()
  const r = await fetch(`${BASE}/api/stream/synth?id=GAUNTLET-A&dur=210`)
  const ttfb = performance.now() - t0
  const cl = parseInt(r.headers.get('content-length') || '0')
  const expected = 44 + 210 * SR * 2
  check('status 200', r.status === 200)
  check('Content-Type audio/wav', r.headers.get('content-type') === 'audio/wav')
  check('Accept-Ranges bytes', r.headers.get('accept-ranges') === 'bytes')
  check('X-Stream-Provider tsf-synth', r.headers.get('x-stream-provider') === 'tsf-synth')
  check('Content-Length = full 210s WAV', cl === expected, `${cl} vs ${expected}`)
  check(`TTFB < 250ms`, ttfb < 250, `${ttfb.toFixed(0)}ms`)
  // abort the body — we don't need to download 18MB
  await r.body?.cancel()
}

// ---------- 2: range requests ----------
console.log('\n[2] Range requests')
{
  const total = 44 + 210 * SR * 2
  const { status, headers, bytes } = await getRangeBytes(`${BASE}/api/stream/synth?id=GAUNTLET-A&dur=210`, 100, 1000)
  check('206 partial', status === 206)
  check('Content-Range correct', headers.get('content-range') === `bytes 100-1099/${total}`, headers.get('content-range') || '')
  check('Content-Length 1000', headers.get('content-length') === '1000')
  check('1000 bytes returned', bytes.length === 1000)

  // open-ended range
  const r2 = await fetch(`${BASE}/api/stream/synth?id=GAUNTLET-A&dur=210`, { headers: { range: 'bytes=0-1' } })
  const b2 = new Uint8Array(await r2.arrayBuffer())
  check('probe range 0-1 → 206 + RIFF', r2.status === 206 && b2[0] === 0x52 && b2[1] === 0x49, `RIFF=${String.fromCharCode(b2[0], b2[1])}`)

  // seek deep into the file (mid-song)
  const r3 = await fetch(`${BASE}/api/stream/synth?id=GAUNTLET-A&dur=210`, { headers: { range: `bytes=${44 + 100 * SR * 2}-` } })
  check('deep seek open-ended → 206', r3.status === 206)
  const reader = r3.body!.getReader()
  const { value: firstChunk } = await reader.read()
  let nonzero = false
  for (let i = 0; i < firstChunk!.length; i++) if (firstChunk![i] !== 0) { nonzero = true; break }
  check('deep-seek audio non-silent', nonzero)
  await reader.cancel()
}

// ---------- 3+4: uniqueness & determinism over HTTP ----------
console.log('\n[3] Uniqueness & [4] determinism (HTTP)')
{
  const offs = [44 + 30 * SR * 2, 44 + 75 * SR * 2, 44 + 120 * SR * 2]
  const tracks = ['GAUNTLET-A', 'GAUNTLET-B', 'GAUNTLET-C']
  const samples: Record<string, Uint8Array[]> = {}
  for (const t of tracks) {
    samples[t] = []
    for (const off of offs) {
      const { bytes } = await getRangeBytes(`${BASE}/api/stream/synth?id=${t}&dur=210`, off, 2048)
      samples[t].push(bytes)
    }
  }
  let uniq = true
  for (let a = 0; a < tracks.length; a++)
    for (let b = a + 1; b < tracks.length; b++)
      for (let k = 0; k < offs.length; k++) {
        let diff = false
        for (let i = 0; i < 2048; i++) if (Math.abs(samples[tracks[a]][k][i] - samples[tracks[b]][k][i]) > 2) { diff = true; break }
        if (!diff) { uniq = false; console.log(`    ${tracks[a]} == ${tracks[b]} @${offs[k]}`) }
      }
  check('3 tracks distinct at 3 offsets', uniq)

  // determinism: re-fetch track A offset 0
  const again = await getRangeBytes(`${BASE}/api/stream/synth?id=GAUNTLET-A&dur=210`, offs[0], 2048)
  let same = true
  for (let i = 0; i < 2048; i++) if (again.bytes[i] !== samples['GAUNTLET-A'][0][i]) { same = false; break }
  check('same track re-fetch identical', same)
}

// ---------- 5: full chain via /api/stream ----------
console.log('\n[5] /api/stream full chain → synth fallback')
{
  const t0 = performance.now()
  const r = await fetch(`${BASE}/api/stream?id=eVTfSMUh7Wg&dur=201`, { headers: { range: 'bytes=0-1' } })
  const dt = performance.now() - t0
  check('status 206', r.status === 206)
  check('provider header tsf-synth', r.headers.get('x-stream-provider') === 'tsf-synth', r.headers.get('x-stream-provider') || '')
  const cr = r.headers.get('content-range') || ''
  const total = parseInt(cr.split('/')[1] || '0')
  const wavDur = (total - 44) / SR / 2
  check('dur=201 honored through chain', Math.abs(wavDur - 201) < 0.01, `${wavDur.toFixed(1)}s`)
  check(`resolve+respond < 4s (providers raced first)`, dt < 4000, `${dt.toFixed(0)}ms`)
  await r.body?.cancel()

  // second call hits the resolve cache → fast
  const t1 = performance.now()
  const r2 = await fetch(`${BASE}/api/stream?id=eVTfSMUh7Wg&dur=201`, { headers: { range: 'bytes=0-1' } })
  const dt2 = performance.now() - t1
  check('cached resolve fast (<1s)', dt2 < 1000, `${dt2.toFixed(0)}ms`)
  await r2.body?.cancel()
}

// ---------- 6: download ----------
console.log('\n[6] /api/download')
{
  const t0 = performance.now()
  const r = await fetch(`${BASE}/api/download?id=DL-TEST-1&title=Neon%20Skyline%20-%20TestArtist&dur=45`)
  const dt = performance.now() - t0
  const cd = r.headers.get('content-disposition') || ''
  check('Content-Disposition attachment', cd.includes('attachment'))
  check('filename has track title', cd.includes('Neon%20Skyline') || cd.includes('Neon Skyline'), cd.slice(0, 80))
  check('extension .wav', cd.includes('.wav'))
  const buf = new Uint8Array(await r.arrayBuffer())
  const expected = 44 + 45 * SR * 2
  check('full 45s body received', buf.length === expected, `${buf.length} vs ${expected}`)
  check('RIFF header present', String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) === 'RIFF')
  check('audio not silent', (() => { for (let i = 44; i < 44 + 88200; i += 97) if (buf[i] !== 0) return true; return false })())
  check(`download of 45s track < 8s`, dt < 8000, `${dt.toFixed(0)}ms`)

  // different track downloads different bytes
  const r2 = await fetch(`${BASE}/api/download?id=DL-TEST-2&title=Other%20Track&dur=45`)
  const buf2 = new Uint8Array(await r2.arrayBuffer())
  let diff = false
  for (let i = 44 + SR; i < Math.min(buf.length, buf2.length); i += 53) if (Math.abs(buf[i] - buf2[i]) > 2) { diff = true; break }
  check('different track → different download bytes', diff)
}

// ---------- 7: HEAD ----------
console.log('\n[7] HEAD preflight')
{
  const r = await fetch(`${BASE}/api/stream/synth?id=HEAD-TEST&dur=120`, { method: 'HEAD' })
  check('HEAD 200', r.status === 200)
  check('HEAD provider header', r.headers.get('x-stream-provider') === 'tsf-synth')
  check('HEAD content-length full', parseInt(r.headers.get('content-length') || '0') === 44 + 120 * SR * 2)
}

console.log(`\n========== ${pass} passed, ${fail} failed ==========`)
process.exit(fail > 0 ? 1 : 0)
