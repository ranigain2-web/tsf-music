// TSF Music — CI playback probe (the macOS gauntlet gate).
//
// Boots NOTHING itself: expects the production engine already running at
// $BASE (CI starts standalone + POT provider). Resolves the 20-track probe
// set (10 international + 10 Indian) through the REAL pipeline
// (/api/ytm/search → /api/stream) and classifies provider classes.
//
// Exit code 1 when full-length yield < $PROBE_MIN_FULL (default 50).
// Writes probe-report.json with per-track detail for the artifact.

const BASE = process.env.BASE || 'http://127.0.0.1:3100'
const MIN_FULL = Number(process.env.PROBE_MIN_FULL || 50)

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
    const r = await fetch(
      `${BASE}/api/stream?id=${vid}&head=1&fresh=1&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`,
    )
    const prov = r.headers.get('x-stream-provider') || 'none'
    const br = r.headers.get('x-stream-bitrate') || '?'
    const ms = Date.now() - t0
    const cls = classify(prov)
    results.push({ title, artist, region, cls, provider: prov, bitrate: br, ms, status: r.status })
    console.log(`${cls === 'FULL' ? '✓' : '·'} ${title} — ${artist} [${region}]: ${cls} (${prov}, ${br}kbps, ${ms}ms)`)
  } catch (e) {
    results.push({ title, artist, region, cls: 'ERROR', provider: String(e), ms: Date.now() - t0 })
    console.log(`✗ ${title} — ${artist} [${region}]: ERROR ${e}`)
  }
}

const full = results.filter((r) => r.cls === 'FULL').length
const preview = results.filter((r) => r.cls === 'PREVIEW').length
const synth = results.filter((r) => r.cls === 'SYNTH').length
const fail = results.filter((r) => r.cls === 'SEARCH-FAIL' || r.cls === 'ERROR').length
const pct = Math.round((full / results.length) * 100)
const latencies = results.filter((r) => r.cls === 'FULL').map((r) => r.ms).sort((a, b) => a - b)
const p50 = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null

const summary = {
  total: results.length,
  full,
  preview,
  synth,
  failed: fail,
  fullPct: pct,
  fullP50ms: p50,
  minRequired: MIN_FULL,
  pass: pct >= MIN_FULL,
  at: new Date().toISOString(),
}

console.log('\n══════════ PROBE SUMMARY ══════════')
console.log(`full-length : ${full}/${results.length} (${pct}%)  [required ≥ ${MIN_FULL}%]`)
console.log(`preview     : ${preview}   synth: ${synth}   failed: ${fail}`)
console.log(`full p50    : ${p50 ?? '-'} ms`)
console.log(`verdict     : ${summary.pass ? '✅ PASS' : '❌ FAIL'}`)

import { writeFileSync } from 'node:fs'
writeFileSync('probe-report.json', JSON.stringify({ summary, results }, null, 2))

if (!summary.pass) process.exit(1)
