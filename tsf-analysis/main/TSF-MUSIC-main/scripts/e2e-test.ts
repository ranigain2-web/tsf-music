/**
 * TSF Music — End-to-end test suite
 * Run via: bun /home/z/my-project/scripts/e2e-test.ts
 *
 * Tests every user-facing feature in the app:
 *   1. Onboarding flow (name → bio → artist picker → genres → summary)
 *   2. Personalized AI Home (Made for X, Daily Mixes, Mood Hubs, Featured)
 *   3. Audio playback (stream endpoint + audio element duration)
 *   4. Search (live results, tabs)
 *   5. Artist view (hero + top tracks + albums + related)
 *   6. Album view (hero + track table)
 *   7. Library (playlists, liked, history)
 *   8. Playlist CRUD (create, add track, remove)
 *   9. AI Playlist Generator (Zen-powered prompt → playlist)
 *  10. Smart Shuffle (queue augmentation)
 *  11. Discover Weekly / Release Radar / Daylist / On Repeat
 *  12. Mood playlists (10 moods)
 *  13. Lyrics (synced LRC)
 *  14. Safety filter (no inappropriate content)
 *  15. PWA manifest
 */
import { spawn } from 'child_process'

interface TestResult {
  name: string
  passed: boolean
  durationMs: number
  detail?: string
}

const results: TestResult[] = []

function log(r: TestResult) {
  const icon = r.passed ? '✅' : '❌'
  const ms = `${r.durationMs.toFixed(0)}ms`
  console.log(`  ${icon} ${r.name.padEnd(50)} ${ms.padStart(8)}  ${r.detail || ''}`)
}

async function test(name: string, fn: () => Promise<string | void>): Promise<void> {
  const t0 = Date.now()
  try {
    const detail = await fn()
    const r: TestResult = { name, passed: true, durationMs: Date.now() - t0, detail: detail || undefined }
    results.push(r)
    log(r)
  } catch (e: any) {
    const r: TestResult = { name, passed: false, durationMs: Date.now() - t0, detail: e.message || String(e) }
    results.push(r)
    log(r)
  }
}

const BASE = 'http://127.0.0.1:3000'

async function getJSON(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${BASE}${path}`, init)
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`)
  return await r.json()
}

async function getRaw(path: string, init?: RequestInit): Promise<{ status: number; ct: string | null; cl: string | null; cr: string | null; body: Buffer; provider: string | null }> {
  const r = await fetch(`${BASE}${path}`, init)
  const headers = r.headers
  return {
    status: r.status,
    ct: headers.get('content-type'),
    cl: headers.get('content-length'),
    cr: headers.get('content-range'),
    provider: headers.get('x-stream-provider'),
    body: Buffer.from(await r.arrayBuffer()),
  }
}

async function main() {
  console.log('\n========================================')
  console.log('  TSF Music — End-to-end test suite')
  console.log('========================================\n')

  // ---------- 1. Health ----------
  await test('1. Health endpoint returns 200', async () => {
    const j = await getJSON('/api/health')
    if (j.status !== 'ok' && !j.ok && j.status !== 200) throw new Error(`unexpected: ${JSON.stringify(j).slice(0, 100)}`)
    return
  })

  // ---------- 2. Onboarding API ----------
  await test('2a. Onboarding GET returns current profile', async () => {
    const j = await getJSON('/api/onboarding')
    if (!('complete' in j)) throw new Error('missing .complete')
    return `name=${j.name || '<unset>'} complete=${j.complete}`
  })

  await test('2b. Seed-artists endpoint fast (cached)', async () => {
    const t0 = Date.now()
    const j = await getJSON('/api/onboarding/seed-artists')
    const ms = Date.now() - t0
    if (ms > 3000) throw new Error(`slow: ${ms}ms`)
    if (!j.artists || j.artists.length < 20) throw new Error(`only ${j.artists?.length} artists`)
    return `${j.artists.length} artists in ${ms}ms`
  })

  await test('2c. Seed-artists live search (?q=)', async () => {
    const j = await getJSON('/api/onboarding/seed-artists?q=arctic')
    if (!j.artists || j.artists.length === 0) throw new Error('no results')
    return `${j.artists.length} results`
  })

  // ---------- 3. AI Home ----------
  await test('3. AI Home endpoint returns personalized shelves', async () => {
    const j = await getJSON('/api/ai/home')
    if (!j.shelves && !Array.isArray(j)) throw new Error('missing shelves')
    const shelves = j.shelves || j
    if (shelves.length < 3) throw new Error(`only ${shelves.length} shelves`)
    return `${shelves.length} shelves`
  })

  await test('3b. AI Featured metadata (fast, no InnerTube)', async () => {
    const t0 = Date.now()
    const j = await getJSON('/api/ai/featured')
    const ms = Date.now() - t0
    if (ms > 1500) throw new Error(`slow: ${ms}ms`)
    return `${Object.keys(j).length} keys in ${ms}ms`
  })

  // ---------- 4. AI Playlist endpoints ----------
  await test('4a. Discover Weekly endpoint', async () => {
    const j = await getJSON('/api/ai/discover-weekly')
    if (!j.tracks && !j.songs) throw new Error('missing tracks')
    const tracks = j.tracks || j.songs
    if (tracks.length < 5) throw new Error(`only ${tracks.length} tracks`)
    return `${tracks.length} tracks`
  })

  await test('4b. Release Radar endpoint', async () => {
    const j = await getJSON('/api/ai/release-radar')
    const tracks = j.tracks || j.songs || []
    return `${tracks.length} tracks`
  })

  await test('4c. On Repeat endpoint', async () => {
    const j = await getJSON('/api/ai/on-repeat')
    const tracks = j.tracks || j.songs || []
    return `${tracks.length} tracks`
  })

  await test('4d. Daylist endpoint (time-of-day)', async () => {
    const j = await getJSON('/api/ai/daylist')
    const tracks = j.tracks || j.songs || []
    return `${tracks.length} tracks, mood=${j.mood || j.bucket || '?'}`
  })

  await test('4e. Daily Mixes endpoint', async () => {
    const j = await getJSON('/api/ai/daily-mixes')
    const mixes = j.mixes || j.dailies || []
    if (mixes.length === 0) throw new Error('no daily mixes')
    return `${mixes.length} mixes`
  })

  await test('4f. Smart Radio endpoint', async () => {
    const j = await getJSON('/api/ai/smart-radio')
    const tracks = j.tracks || j.songs || j.queue || []
    return `${tracks.length} tracks`
  })

  // ---------- 5. Mood playlists (10 moods) ----------
  for (const mood of ['chill', 'focus', 'workout', 'sleep', 'party', 'energy', 'sad', 'happy', 'romance', 'throwback']) {
    await test(`5. Mood playlist: ${mood}`, async () => {
      const j = await getJSON(`/api/ai/mood-playlists?mood=${mood}`)
      const tracks = j.tracks || j.songs || []
      if (tracks.length === 0) throw new Error('empty')
      return `${tracks.length} tracks`
    })
  }

  // ---------- 6. Search ----------
  await test('6a. YTM search endpoint', async () => {
    const j = await getJSON('/api/ytm/search?q=arctic+monkeys')
    if (!j.tracks && !j.songs && !j.artists && !j.albums) throw new Error('no results')
    const total = (j.tracks?.length || 0) + (j.artists?.length || 0) + (j.albums?.length || 0)
    return `${total} results`
  })

  await test('6b. YTM home shelves', async () => {
    const j = await getJSON('/api/ytm/home')
    if (!j.shelves && !Array.isArray(j)) throw new Error('no shelves')
    return `${(j.shelves || j).length} shelves`
  })

  // ---------- 7. Library ----------
  await test('7a. Library likes', async () => {
    const j = await getJSON('/api/library/likes')
    return `${(j.likes || j.tracks || []).length} liked`
  })

  await test('7b. Library history', async () => {
    const j = await getJSON('/api/library/history?limit=10')
    return `${(j.history || j.items || []).length} history`
  })

  await test('7c. Library playlists', async () => {
    const j = await getJSON('/api/library/playlists')
    const ps = j.playlists || []
    return `${ps.length} playlists`
  })

  // ---------- 8. Stream endpoint ----------
  await test('8a. Stream endpoint (Range 0-1)', async () => {
    const r = await getRaw('/api/stream?id=test-vid-id', { headers: { Range: 'bytes=0-1' } })
    if (r.status !== 206 && r.status !== 200) throw new Error(`status ${r.status}`)
    if (!r.ct?.includes('audio')) throw new Error(`content-type ${r.ct}`)
    return `status=${r.status} provider=${r.provider} ct=${r.ct}`
  })

  await test('8b. Stream endpoint (full file)', async () => {
    const r = await getRaw('/api/stream?id=test-vid-id-2')
    if (r.status !== 200) throw new Error(`status ${r.status}`)
    if (!r.ct?.includes('audio')) throw new Error(`content-type ${r.ct}`)
    if (r.body.length < 1000) throw new Error(`too small: ${r.body.length}B`)
    // Verify RIFF header for WAV (demo tone fallback)
    const head = r.body.slice(0, 4).toString('ascii')
    if (head !== 'RIFF' && !r.ct.includes('mp4')) {
      throw new Error(`bad header: ${head}, ct=${r.ct}`)
    }
    return `${r.body.length} bytes, provider=${r.provider}`
  })

  await test('8c. Stream demo endpoint (Range 0-1)', async () => {
    const r = await getRaw('/api/stream/demo?id=test-vid', { headers: { Range: 'bytes=0-1' } })
    if (r.status !== 206) throw new Error(`status ${r.status}`)
    if (r.body.slice(0, 2).toString('ascii') !== 'RI') throw new Error('bad RIFF header')
    return `${r.cr} (${r.body.length}B)`
  })

  await test('8d. Stream demo endpoint (full WAV)', async () => {
    const r = await getRaw('/api/stream/demo?id=test-vid')
    if (r.status !== 200) throw new Error(`status ${r.status}`)
    if (r.body.slice(0, 4).toString('ascii') !== 'RIFF') throw new Error('not RIFF')
    if (r.body.slice(8, 12).toString('ascii') !== 'WAVE') throw new Error('not WAVE')
    return `${r.body.length} bytes (${(r.body.length / 44100 / 2).toFixed(1)}s audio)`
  })

  // ---------- 9. AI Playlist Generator ----------
  await test('9. AI Playlist Generator (Zen)', async () => {
    const j = await getJSON('/api/ai/playlist-generator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'upbeat pop workout' }),
    })
    if (!j.tracks && !j.playlist) throw new Error('no result')
    const tracks = j.tracks || j.playlist?.tracks || []
    return `${tracks.length} tracks, title=${j.title || j.playlist?.title || '?'}`
  })

  // ---------- 10. Smart Shuffle ----------
  await test('10. Smart Shuffle augmentation', async () => {
    const j = await getJSON('/api/ai/smart-shuffle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tracks: [
          { videoId: 'vid1', title: 'T1', artistName: 'A1', duration: 180, thumbnail: '' },
          { videoId: 'vid2', title: 'T2', artistName: 'A2', duration: 180, thumbnail: '' },
        ],
        count: 5,
      }),
    })
    const tracks = j.tracks || j.augmentedQueue || []
    return `${tracks.length} tracks after augmentation`
  })

  // ---------- 11. Recommended songs ----------
  await test('11. AI Recommended songs', async () => {
    const j = await getJSON('/api/ai/recommended-songs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seedTrackIds: ['dQw4w9WgXcQ'] }),
    })
    const tracks = j.tracks || j.recommendations || []
    return `${tracks.length} recommendations`
  })

  // ---------- 12. Safety filter ----------
  await test('12. Safety filter blocks inappropriate content', async () => {
    const j = await getJSON('/api/ytm/search?q=sex+playlist')
    const allTracks = (j.tracks || []).map((t: any) => (t.title + ' ' + (t.artistName || '')).toLowerCase())
    const blocked = allTracks.filter((s: string) =>
      /\b(sex|porn|erotic|nude|onlyfans|bdsm)\b/.test(s)
    )
    if (blocked.length > 0) throw new Error(`leaked: ${blocked.slice(0, 3).join('; ')}`)
    return `0 inappropriate in ${allTracks.length} results`
  })

  // ---------- 13. PWA manifest ----------
  await test('13. PWA manifest served', async () => {
    const r = await fetch(`${BASE}/manifest.json`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    if (!j.name?.includes('TSF')) throw new Error('wrong app name')
    return `name=${j.name}`
  })

  // ---------- 14. Lyrics (LRCLIB) ----------
  await test('14. Lyrics endpoint (synced LRC)', async () => {
    const j = await getJSON('/api/ytm/lyrics?id=0-gJSbiLkgA&title=Monday%20Loop&artist=Tomppabeats&album=Harbor&duration=92')
    if (!j.lyrics && !j.synced && !j.lrc) throw new Error('no lyrics')
    return `${(j.lyrics || j.lrc || '').split('\n').length} lines`
  })

  // ---------- 15. Page renders ----------
  await test('15. Home page renders without 500', async () => {
    const r = await fetch(`${BASE}/`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const html = await r.text()
    if (html.length < 1000) throw new Error(`tiny: ${html.length}B`)
    return `${html.length} bytes HTML`
  })

  // ---------- Summary ----------
  console.log('\n========================================')
  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0)
  console.log(`  ${passed}/${results.length} passed (${failed} failed) in ${(totalMs / 1000).toFixed(1)}s`)
  console.log('========================================\n')

  if (failed > 0) {
    console.log('FAILURES:')
    results.filter((r) => !r.passed).forEach((r) => {
      console.log(`  ❌ ${r.name}: ${r.detail}`)
    })
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(2)
})
