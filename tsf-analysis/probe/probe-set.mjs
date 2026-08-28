// TSF-MUSIC R1 probe: 20 tracks (10 international + 10 Indian) through the
// REAL resolve pipeline (/api/ytm/search → /api/stream?id&head=1&fresh=1).
// Measures provider class + latency. fresh=1 skips cache for honest numbers.
const BASE = 'http://localhost:3000'

const PROBE = [
  // --- International (10) ---
  ['Blank Space', 'Taylor Swift', 'intl'],
  ['Shape of You', 'Ed Sheeran', 'intl'],
  ['Bohemian Rhapsody', 'Queen', 'intl'],
  ['Counting Stars', 'OneRepublic', 'intl'],
  ['Uptown Funk', 'Mark Ronson', 'intl'],
  ['Rolling in the Deep', 'Adele', 'intl'],
  ['Numb', 'Linkin Park', 'intl'],
  ['Blinding Lights', 'The Weeknd', 'intl'],
  ['As It Was', 'Harry Styles', 'intl'],
  ['Anti-Hero', 'Taylor Swift', 'intl'],
  // --- Indian / national (10) ---
  ['Kesariya', 'Arijit Singh', 'in'],
  ['Tum Hi Ho', 'Arijit Singh', 'in'],
  ['Kal Ho Naa Ho', 'Sonu Nigam', 'in'],
  ['Jai Ho', 'A.R. Rahman', 'in'],
  ['Chaiyya Chaiyya', 'Sukhwinder Singh', 'in'],
  ['Apna Bana Le', 'Arijit Singh', 'in'],
  ['Raataan Lambiyan', 'Jubin Nautiyal', 'in'],
  ['Kun Faya Kun', 'A.R. Rahman', 'in'],
  ['Zaalima', 'Arijit Singh', 'in'],
  ['Ilahi', 'Arijit Singh', 'in'],
]

function classify(provider) {
  if (/^(jiosaavn|yt-dlp|innertube-)/.test(provider)) return 'FULL'
  if (/itunes-preview/.test(provider)) return 'PREVIEW'
  if (/tsf-synth|demo-tone/.test(provider)) return 'SYNTH'
  return 'OTHER'
}

async function searchVideoId(title, artist) {
  const r = await fetch(`${BASE}/api/ytm/search?q=${encodeURIComponent(`${title} ${artist}`)}&filter=songs`)
  if (!r.ok) return null
  const j = await r.json()
  const items = j.tracks || (Array.isArray(j) ? j : j.results || j.items || [])
  const first = items.find((t) => t?.videoId || t?.id)
  return first?.videoId || first?.id || null
}

const results = []
for (const [title, artist, region] of PROBE) {
  const t0 = Date.now()
  try {
    const vid = await searchVideoId(title, artist)
    if (!vid) {
      results.push({ title, artist, region, cls: 'SEARCH-FAIL', provider: '-', ms: Date.now() - t0 })
      console.log(`✗ ${title} — ${artist} [${region}]: SEARCH FAIL`)
      continue
    }
    const r = await fetch(`${BASE}/api/stream?id=${vid}&head=1&fresh=1&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`)
    const prov = r.headers.get('x-stream-provider') || 'none'
    const br = r.headers.get('x-stream-bitrate') || '?'
    const ms = Date.now() - t0
    const cls = classify(prov)
    results.push({ title, artist, region, cls, provider: prov, bitrate: br, ms })
    console.log(`${cls === 'FULL' ? '✓' : cls === 'PREVIEW' ? '~' : '✗'} ${title} — ${artist} [${region}]: ${cls} via ${prov} ${br}bps ${ms}ms`)
  } catch (e) {
    results.push({ title, artist, region, cls: 'ERROR', provider: String(e).slice(0, 60), ms: Date.now() - t0 })
    console.log(`✗ ${title} — ${artist}: ERROR ${String(e).slice(0, 60)}`)
  }
}

const full = results.filter((r) => r.cls === 'FULL').length
const prev = results.filter((r) => r.cls === 'PREVIEW').length
const synth = results.filter((r) => r.cls === 'SYNTH').length
const fail = results.filter((r) => r.cls === 'SEARCH-FAIL' || r.cls === 'ERROR').length
const inFull = results.filter((r) => r.region === 'in' && r.cls === 'FULL').length
const intlFull = results.filter((r) => r.region === 'intl' && r.cls === 'FULL').length
const lat = results.filter((r) => r.cls !== 'ERROR').map((r) => r.ms).sort((a, b) => a - b)
const p50 = lat[Math.floor(lat.length / 2)] ?? -1
console.log('\n===== R1 PROBE SUMMARY =====')
console.log(`FULL: ${full}/20 (intl ${intlFull}/10, national ${inFull}/10) | PREVIEW: ${prev} | SYNTH: ${synth} | FAIL: ${fail}`)
console.log(`resolve p50: ${p50}ms  (bar ≤ 3000ms for warm; cold first-play tuned for full-length yield)`)
console.log(JSON.stringify(results, null, 1))
