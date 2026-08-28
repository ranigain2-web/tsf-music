/**
 * HTTP gauntlet — iTunes REAL-audio resolver verification.
 *
 * Verifies, against the LIVE home catalog:
 *   1. Resolution: /api/stream?id&title&artist → provider itunes-preview
 *   2. Redirect target = Apple's audio CDN (audio-ssl.itunes.apple.com)
 *   3. The redirected URL serves REAL AAC audio (m4a magic, not WAV/synth)
 *   4. Different tracks → different audio bytes (no shared dummy file)
 *   5. Range requests → 206 with correct Content-Range
 *   6. /api/download → attachment with real AAC bytes + correct filename
 *   7. Match rate across the catalog + latency stats
 *   8. Warm-cache latency
 */
const BASE = 'http://127.0.0.1:3000'

interface Track { videoId: string; title: string; artistName: string; duration?: number }

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ FAIL: ${name}${extra ? ' — ' + extra : ''}`) }
}

async function getCatalog(): Promise<Track[]> {
  const r = await fetch(`${BASE}/api/ai/home`)
  const d = await r.json()
  const seen = new Set<string>()
  const tracks: Track[] = []
  const walk = (o: any) => {
    if (o && typeof o === 'object') {
      if (Array.isArray(o)) { o.forEach(walk); return }
      if (o.videoId && o.title && !seen.has(o.videoId)) {
        seen.add(o.videoId)
        tracks.push({ videoId: o.videoId, title: o.title, artistName: o.artistName || '', duration: o.duration })
      }
      Object.values(o).forEach(walk)
    }
  }
  walk(d)
  return tracks
}

async function main() {
  const catalog = await getCatalog()
  console.log(`\n=== HTTP GAUNTLET — iTunes real-audio resolver ===`)
  console.log(`catalog tracks found: ${catalog.length}\n`)

  // ---- 1. Resolve a diverse sample through the full stream endpoint ----
  const sample = catalog.filter(t => t.videoId).slice(0, 14)
  const results: { t: Track; provider: string; url: string; ms: number }[] = []
  for (const t of sample) {
    const q = `id=${encodeURIComponent(t.videoId)}&title=${encodeURIComponent(t.title)}&artist=${encodeURIComponent(t.artistName)}&dur=${t.duration || 0}`
    const t0 = Date.now()
    const r = await fetch(`${BASE}/api/stream?${q}`, { redirect: 'manual' })
    const ms = Date.now() - t0
    const loc = r.headers.get('location') || ''
    const prov = r.headers.get('x-stream-provider') || ''
    results.push({ t, provider: prov || (loc ? 'redirect' : `status-${r.status}`), url: loc, ms })
    console.log(`  [${String(r.status).padStart(3)}] ${String(ms).padStart(5)}ms ${t.artistName.slice(0, 22).padEnd(22)} | ${t.title.slice(0, 30).padEnd(30)} → ${prov || 'no-provider-header'} ${loc ? loc.slice(8, 60) : ''}`)
  }

  const itunes = results.filter(r => r.provider === 'itunes-preview')
  const synth = results.filter(r => r.provider === 'tsf-synth')
  const matchRate = (itunes.length / results.length) * 100

  ok(`match rate >= 60% (${itunes.length}/${results.length} = ${matchRate.toFixed(0)}%)`, matchRate >= 60)
  ok(`redirects point at Apple CDN`, itunes.every(r => r.url.includes('itunes.apple.com')))

  // ---- 2. Real AAC audio from the redirect target ----
  for (const r of itunes.slice(0, 3)) {
    const audioR = await fetch(r.url, { headers: { Range: 'bytes=0-8191' } })
    const buf = Buffer.from(await audioR.arrayBuffer())
    const isMp4 = buf.length > 11 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70 // "ftyp"
    const isWav = buf.length > 11 && buf[0] === 0x52 && buf[1] === 0x49 // "RIFF"
    ok(`REAL m4a audio for "${r.t.title}" (206=${audioR.status === 206}, mp4=${isMp4}, NOT wav=${!isWav})`,
      audioR.status === 206 && isMp4 && !isWav, `${buf.length}B type=${audioR.headers.get('content-type')}`)
    ok(`range Content-Range present`, !!audioR.headers.get('content-range'))
  }

  // ---- 3. Distinctness: different tracks must give different audio ----
  if (itunes.length >= 2) {
    const fetches = await Promise.all(itunes.slice(0, 4).map(async r => {
      const a = await fetch(r.url, { headers: { Range: 'bytes=0-4095' } })
      return Buffer.from(await a.arrayBuffer())
    }))
    let allDistinct = true
    for (let i = 0; i < fetches.length; i++)
      for (let j = i + 1; j < fetches.length; j++)
        if (fetches[i].equals(fetches[j])) allDistinct = false
    ok(`audio bytes differ across ${fetches.length} tracks`, allDistinct)
  }

  // ---- 4. Download endpoint serves the REAL recording ----
  const dl = itunes[0]
  if (dl) {
    const q = `id=${encodeURIComponent(dl.t.videoId)}&title=${encodeURIComponent(dl.t.title)}&artist=${encodeURIComponent(dl.t.artistName)}&dur=${dl.t.duration || 0}`
    const r = await fetch(`${BASE}/api/download?${q}`)
    const buf = Buffer.from(await r.arrayBuffer())
    const cd = r.headers.get('content-disposition') || ''
    const isMp4 = buf.length > 11 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70
    ok(`download = attachment .m4a`, cd.includes('attachment') && cd.includes('.m4a'), cd.slice(0, 80))
    ok(`download body is REAL m4a (${buf.length} bytes)`, isMp4 && buf.length > 100000)
    ok(`download provider header = itunes-preview`, r.headers.get('x-stream-provider') === 'itunes-preview')

    // Same track downloads identically (cache consistency)
    const r2 = await fetch(`${BASE}/api/download?${q}`)
    const buf2 = Buffer.from(await r2.arrayBuffer())
    ok(`re-download byte-identical`, buf.equals(buf2))
  } else {
    ok(`download test (no itunes track resolved)`, false)
  }

  // ---- 5. Warm cache latency ----
  if (itunes[0]) {
    const t0 = Date.now()
    const r = await fetch(`${BASE}/api/stream?id=${encodeURIComponent(itunes[0].t.videoId)}&title=${encodeURIComponent(itunes[0].t.title)}&artist=${encodeURIComponent(itunes[0].t.artistName)}`, { redirect: 'manual' })
    const warm = Date.now() - t0
    ok(`warm resolve < 100ms`, warm < 100 && (r.headers.get('x-stream-provider') === 'itunes-preview' || r.status === 307 || r.status === 302), `${warm}ms`)
  }

  // ---- 6. HEAD preflight reports provider ----
  if (itunes[0]) {
    const r = await fetch(`${BASE}/api/stream?id=${encodeURIComponent(itunes[0].t.videoId)}&title=${encodeURIComponent(itunes[0].t.title)}&artist=${encodeURIComponent(itunes[0].t.artistName)}`, { method: 'HEAD' })
    ok(`HEAD preflight x-stream-provider = itunes-preview`, r.headers.get('x-stream-provider') === 'itunes-preview')
  }

  // ---- 7. Fallback integrity: synth still works for unmatched tracks ----
  if (synth.length > 0) {
    const s = synth[0]
    const r = await fetch(`${BASE}/api/stream?id=${encodeURIComponent(s.t.videoId)}&dur=${s.t.duration || 180}&title=${encodeURIComponent(s.t.title)}&artist=${encodeURIComponent(s.t.artistName)}`)
    const buf = Buffer.from(await r.arrayBuffer())
    const isWav = buf.length > 44 && buf[0] === 0x52 && buf[1] === 0x49
    ok(`synth fallback still serves WAV for unmatched "${s.t.title}"`, isWav)
  } else {
    console.log(`  (no synth-fallback tracks in sample — all matched, fallback not exercised)`)
  }

  // ---- 8. Cold vs warm stats ----
  const coldAvg = Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length)
  console.log(`\n  latency: cold avg ${coldAvg}ms | provider mix: itunes=${itunes.length} synth=${synth.length} other=${results.length - itunes.length - synth.length}`)

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error('GAUNTLET CRASH:', e); process.exit(1) })
