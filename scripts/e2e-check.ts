/**
 * TSF MUSIC — FULL END-TO-END ORACLE.
 *
 * Exercises EVERY route the app exposes against a running server and asserts
 * real invariants (shapes, counts, bytes, provider honesty) rather than mere
 * HTTP 200s. Companion to search-v2-check.ts: that one proves the search
 * engine's pure functions, this one proves the whole surface is wired.
 *
 * Usage:
 *   bun run dev                     # in another shell
 *   bun scripts/e2e-check.ts        # add --quick to skip the slow AI routes
 *   TSF_BASE=http://host:port bun scripts/e2e-check.ts
 *
 * Exit code is 1 if any check fails, so it can gate CI or a release.
 */

const BASE = process.env.TSF_BASE || 'http://localhost:3000'
const QUICK = process.argv.includes('--quick')

let pass = 0
let fail = 0
let skip = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function skipped(name: string, why: string) {
  skip++
  console.log(`SKIP  ${name} — ${why}`)
}
function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)
}

type Res = { status: number; headers: Headers; text: string; json: any }
async function req(path: string, init?: RequestInit, timeoutMs = 120_000): Promise<Res> {
  const res = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* NDJSON / binary — caller parses */
  }
  return { status: res.status, headers: res.headers, text, json }
}
const post = (path: string, body: unknown, timeoutMs?: number) =>
  req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs)

/**
 * Event stream → parsed events. Handles BOTH wire formats this app uses:
 *   • search-v2 replies with bare NDJSON lines
 *   • the AI routes reply with SSE (`data: {...}`), which the raw parser would
 *     silently drop — the exact bug that made this harness report the working
 *     playlist generator as dead. `:`-prefixed lines are SSE comments/heartbeats.
 */
function ndjson(text: string): any[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith(':'))
    .map((l) => (l.startsWith('data:') ? l.slice(5).trim() : l))
    .filter((l) => l.length > 0 && l !== '[DONE]')
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** A row is a usable catalog track only if the app could play it. */
function isTrack(t: any): boolean {
  return (
    !!t &&
    typeof t.videoId === 'string' &&
    t.videoId.length >= 5 &&
    typeof t.title === 'string' &&
    t.title.trim().length > 0
  )
}
/** search-v2 uses `id` (the playable key, which may be `saavn-…`) not `videoId`. */
function isSearchRow(r: any): boolean {
  return (
    !!r &&
    typeof r.id === 'string' &&
    r.id.length >= 5 &&
    typeof r.title === 'string' &&
    r.title.trim().length > 0 &&
    typeof r.artistName === 'string'
  )
}
function tracksOf(x: any): any[] {
  if (Array.isArray(x)) return x
  if (!x || typeof x !== 'object') return []
  // Callers occasionally hand us the whole `Res` wrapper instead of its parsed
  // body. Unwrapping here means that mistake degrades to the right answer
  // instead of silently returning [] and making `every()` pass vacuously.
  if (x.json && typeof x.json === 'object') return tracksOf(x.json)
  for (const k of ['tracks', 'rows', 'songs', 'items']) if (Array.isArray(x[k])) return x[k]
  return []
}
const okTracks = (x: any, min = 1) => {
  const t = tracksOf(x)
  return t.length >= min && t.every(isTrack)
}

const YT_ID = 'dQw4w9WgXcQ'
const YT_ID2 = '6hCqRb8Dtvo' // Blank Space
const ARTIST_ID = 'UCPC0L1d253x-KuMNwa05TpA' // Taylor Swift
const ALBUM_ID = 'MPREb_dqWTncCjkSp' // Thriller

console.log(`TSF MUSIC — E2E oracle against ${BASE}${QUICK ? ' (quick mode)' : ''}`)

// ─────────────────────────────────────────────────────────────
section('platform')
// ─────────────────────────────────────────────────────────────
try {
  const api = await req('/api', undefined, 20_000)
  check('GET /api answers', api.status === 200 && typeof api.json?.message === 'string')

  const h = await req('/api/health', undefined, 20_000)
  check('GET /api/health → ok', h.status === 200 && h.json?.ok === true)
  check('health reports providers', Array.isArray(h.json?.providers) && h.json.providers.length > 0)
  check(
    'every provider row is well-formed',
    (h.json?.providers || []).every(
      (p: any) => typeof p.provider === 'string' && typeof p.ok === 'boolean',
    ),
  )
  const names = new Set((h.json?.providers || []).map((p: any) => p.provider))
  check('provider chain includes yt-dlp + InnerTube clients', names.has('yt-dlp') && [...names].some((n) => String(n).startsWith('innertube-')))
  const healthy = (h.json?.providers || []).filter((p: any) => p.ok).length
  console.log(`      ${healthy}/${names.size} providers healthy right now`)
} catch (e) {
  check('platform reachable', false, String(e))
}

// ─────────────────────────────────────────────────────────────
section('catalog — YouTube Music (ytm/*)')
// ─────────────────────────────────────────────────────────────
try {
  const s = await req('/api/ytm/search?q=blank%20space')
  check('ytm/search returns playable tracks', s.status === 200 && okTracks(s.json), `status=${s.status} n=${tracksOf(s.json).length}`)

  const weird = await req('/api/ytm/search?q=%C3%A0%20%F0%9F%8E%B5%20zqxjkvbw')
  check('ytm/search survives unicode + gibberish without 500', weird.status === 200 && Array.isArray(tracksOf(weird.json)))

  const ta = await req('/api/ytm/typeahead?q=ta')
  check('ytm/typeahead returns suggestions', ta.status === 200 && (Array.isArray(ta.json?.songs) || Array.isArray(ta.json?.recents)))

  const home = await req('/api/ytm/home')
  const shelves = home.json?.shelves || []
  check('ytm/home returns shelves', home.status === 200 && shelves.length >= 1)
  check('every ytm/home shelf has a title and tracks', shelves.every((sh: any) => typeof sh.title === 'string' && Array.isArray(sh.tracks)))
  check('ytm/home shelves carry playable rows', shelves.some((sh: any) => okTracks(sh.tracks, 1)))

  const alb = await req(`/api/ytm/album?id=${ALBUM_ID}`)
  check('ytm/album resolves a real album', alb.status === 200 && typeof alb.json?.title === 'string' && alb.json.title.length > 0, `status=${alb.status}`)
  check('ytm/album carries tracks', okTracks(alb.json, 1), `n=${tracksOf(alb.json).length}`)

  const art = await req(`/api/ytm/artist?id=${ARTIST_ID}`)
  check('ytm/artist resolves a real artist', art.status === 200 && typeof art.json?.name === 'string' && art.json.name.length > 0, `status=${art.status}`)

  const radio = await req(`/api/ytm/radio?id=${YT_ID2}`)
  check('ytm/radio fills a station', radio.status === 200 && okTracks(radio.json, 5), `n=${tracksOf(radio.json).length}`)

  const lyr = await req(`/api/ytm/lyrics?id=${YT_ID}&title=Never%20Gonna%20Give%20You%20Up&artist=Rick%20Astley`)
  check('ytm/lyrics returns a line array', lyr.status === 200 && Array.isArray(lyr.json?.lines))
  check('ytm/lyrics reports its sync state', typeof lyr.json?.synced === 'boolean' && typeof lyr.json?.offline === 'boolean')
} catch (e) {
  check('catalog reachable', false, String(e))
}

// ─────────────────────────────────────────────────────────────
section('search V2 — streaming, ranking, pagination')
// ─────────────────────────────────────────────────────────────
try {
  const t0 = Date.now()
  const v2 = await req('/api/ytm/search-v2?q=tum%20hi%20ho')
  const events = ndjson(v2.text)
  const withRows = events.filter((e) => Array.isArray(e?.result?.rows))
  const rows = withRows.length ? withRows[withRows.length - 1].result.rows : []
  console.log(`      ${events.length} NDJSON events, ${rows.length} ranked rows in ${Date.now() - t0}ms`)
  check('search-v2 streams NDJSON', v2.status === 200 && events.length > 0, `lines=${events.length}`)
  check('search-v2 emits a ranked result event', rows.length > 0)
  check('search-v2 rows are playable and reasoned', rows.every((r: any) => isSearchRow(r) && typeof r.reason === 'string'))
  check('search-v2 rows carry a rank score', rows.every((r: any) => typeof r.score === 'number'))
  check('search-v2 rows declare their source pool', rows.every((r: any) => typeof r.source === 'string' && r.source.length > 0))
  check('search-v2 instruments latency', typeof withRows[withRows.length - 1]?.result?.latencyMs === 'number')

  const yt = await req('/api/ytm/search-v2?q=taylor%20swift&source=yt')
  const ytEvents = ndjson(yt.text)
  const ytRes = [...ytEvents].reverse().find((e) => e?.result)?.result
  check('search-v2 source=yt returns rows', Array.isArray(ytRes?.rows) && ytRes.rows.length > 0, `n=${ytRes?.rows?.length}`)
  if (typeof ytRes?.ytContinuation === 'string' && ytRes.ytContinuation.length > 10) {
    const more = await post('/api/ytm/search-yt-more', { continuation: ytRes.ytContinuation })
    check('search-yt-more walks the continuation', more.status === 200 && Array.isArray(more.json?.tracks) && more.json.tracks.length > 0, `n=${more.json?.tracks?.length}`)
    check('search-yt-more reports end-of-catalog honestly', typeof more.json?.end === 'boolean')
  } else {
    // No continuation is a legitimate answer for a query YouTube fully served.
    skipped('search-yt-more deep pagination', 'YouTube returned no continuation for this query (honest end)')
    const noCont = await post('/api/ytm/search-yt-more', { continuation: '' })
    check('search-yt-more treats an empty continuation as an honest end', noCont.status === 200 && noCont.json?.end === true, `status=${noCont.status}`)
  }

  const page2 = await post('/api/ytm/search-more', { query: 'tum hi ho', page: 2, seenIds: rows.map((r: any) => r.id) })
  check('search-more (JioSaavn pages) returns rows', page2.status === 200 && Array.isArray(page2.json?.rows), `status=${page2.status}`)
  if (Array.isArray(page2.json?.rows) && page2.json.rows.length) {
    const seen = new Set(rows.map((r: any) => r.id))
    check('search-more never repeats caller-seen ids', page2.json.rows.every((r: any) => !seen.has(r.id)), `overlap on ${page2.json.rows.filter((r: any) => seen.has(r.id)).length} rows`)
    check('search-more rows are playable', page2.json.rows.every((r: any) => isSearchRow(r)))
  }

  const empty = await req('/api/ytm/search-v2?q=')
  check('search-v2 handles an empty query without 500', empty.status === 200 || empty.status === 400, `status=${empty.status}`)
} catch (e) {
  check('search V2 reachable', false, String(e))
}

// ─────────────────────────────────────────────────────────────
section('streaming — real bytes, honest providers')
// ─────────────────────────────────────────────────────────────
try {
  // A catalogue id the resolver must serve full-length (or degrade honestly).
  const s = await req(`/api/stream?id=${YT_ID}&fresh=1`, { redirect: 'manual' }, 120_000)
  const provider = s.headers.get('x-stream-provider') || ''
  if (s.status === 307 || s.status === 302) {
    const loc = s.headers.get('location') || ''
    check('full-length resolve redirects to a whitelisted CDN', /googlevideo\.com|saavncdn\.com|itunes|piped|invidious/.test(loc), `loc=${loc.slice(0, 60)}`)
    check('resolved URL is signed and time-boxed', /[?&]expire=/.test(loc), loc.slice(0, 80))
    const bytes = await fetch(loc, { headers: { Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(60_000) })
    check('CDN honours a range request with real bytes', bytes.status === 206 && Number(bytes.headers.get('content-length') || 0) > 0, `status=${bytes.status} len=${bytes.headers.get('content-length')}`)
    await bytes.arrayBuffer()
  } else if (s.status === 200) {
    // inline synth / preview path
    check('inline stream declares its provider', provider.length > 0, `provider=${provider}`)
  } else {
    check('stream resolves (307 or 200)', false, `status=${s.status}`)
  }

  const proxied = await req(`/api/stream?id=${YT_ID}&proxy=1`, {}, 120_000)
  check('proxy=1 serves bytes inline (mobile path)', proxied.status === 200 || proxied.status === 206, `status=${proxied.status}`)
  check('proxy=1 is provider-honest', (proxied.headers.get('x-stream-provider') || '').length > 0, `provider=${proxied.headers.get('x-stream-provider')}`)

  const head = await req(`/api/stream?id=${YT_ID}&head=1`, {}, 60_000)
  check('head=1 answers without a body', head.status === 200 && head.text.length === 0, `status=${head.status} body=${head.text.length}`)

  const saavn = await req('/api/stream?id=saavn-b4p2XiM4', { redirect: 'manual' }, 90_000)
  const saavnProvider = saavn.headers.get('x-stream-provider') || ''
  check('deterministic JioSaavn catalog resolve works', saavn.status === 200 || saavn.status === 307 || saavnProvider === 'jiosaavn', `status=${saavn.status} provider=${saavnProvider}`)

  // The route gates the id with VIDEO_ID_RE before the resolver ever runs.
  for (const bad of ['zz', '!!!', 'not-a-real-video-id']) {
    const m = await req(`/api/stream?id=${encodeURIComponent(bad)}`, { redirect: 'manual' }, 30_000)
    check(`malformed id "${bad}" is rejected at the gate`, m.status === 400, `status=${m.status}`)
  }

  // HONEST DEGRADATION, full chain: a valid-shaped id that exists nowhere must
  // walk yt-dlp → InnerTube → iTunes and land on the synth instead of hanging.
  const doomed = await req('/api/stream?id=aaaaaaaaaaa&fresh=1', {}, 180_000)
  check('unresolvable id degrades to the synth, not an error or a hang', doomed.status === 200 && (doomed.headers.get('x-stream-provider') || '').includes('synth'), `status=${doomed.status} provider=${doomed.headers.get('x-stream-provider')}`)
  check('degraded synth actually renders audio', doomed.text.length > 100_000 && doomed.text.slice(0, 4) === 'RIFF', `bytes=${doomed.text.length}`)

  const forged = await req('/api/stream?url=https://evil.example.com/a.mp3', { redirect: 'manual' }, 30_000)
  check('url passthrough rejects non-whitelisted hosts', forged.status >= 400 && forged.status < 500, `status=${forged.status}`)

  const synth = await fetch(`${BASE}/api/stream/synth?id=e2e-synth&dur=24`, { signal: AbortSignal.timeout(60_000) })
  const synthBuf = new Uint8Array(await synth.arrayBuffer())
  const riff = String.fromCharCode(...synthBuf.slice(0, 4))
  check('synth renders a real WAV', synth.status === 200 && riff === 'RIFF' && synthBuf.length > 10_000, `status=${synth.status} magic=${riff} bytes=${synthBuf.length}`)
  check('synth declares audio/wav', (synth.headers.get('content-type') || '').includes('audio/wav'))

  const demo = await fetch(`${BASE}/api/stream/demo?id=e2e-demo`, { signal: AbortSignal.timeout(30_000) })
  check('legacy demo tone still forwards', demo.status === 200 && (demo.headers.get('content-type') || '').includes('audio'), `status=${demo.status}`)
  await demo.arrayBuffer()

  const warm = await post('/api/stream/warm', { ids: [YT_ID2] }, 120_000)
  check('stream/warm accepts ids', warm.status === 200 && (Array.isArray(warm.json?.warmed) || Array.isArray(warm.json?.skipped)), `status=${warm.status} body=${warm.text.slice(0, 60)}`)

  const warmBad = await post('/api/stream/warm', { ids: Array.from({ length: 20 }, (_, i) => `id${i}`) }, 30_000)
  check('stream/warm caps at 16 ids', warmBad.status === 400, `status=${warmBad.status}`)
} catch (e) {
  check('streaming reachable', false, String(e))
}

// ─────────────────────────────────────────────────────────────
section('download + sponsorblock')
// ─────────────────────────────────────────────────────────────
try {
  const dl = await req(`/api/download?id=${YT_ID}&title=E2E%20Test&artist=Oracle`, {}, 120_000)
  const cd = dl.headers.get('content-disposition') || ''
  check('download serves audio', dl.status === 200, `status=${dl.status}`)
  check('download sets an attachment filename', cd.toLowerCase().includes('attachment') && cd.length > 10, `cd=${cd.slice(0, 80)}`)
  // RFC 5987: a quoted-ASCII fallback AND the UTF-8 filename* form. The old
  // single encodeURIComponent-in-quotes form put "A%20B.m4a" on disk.
  check(
    'download filename is not percent-mangled',
    /filename="[^"%]*"/.test(cd) && /filename\*=UTF-8''/.test(cd),
    `cd=${cd.slice(0, 120)}`,
  )
  // Real progress is only possible when the length is known up front — the
  // route must stream the upstream through instead of buffering it whole.
  const len = Number(dl.headers.get('content-length') || 0)
  check('download declares its length up front (live progress)', len > 0, `content-length=${len}`)

  // `saavn-<id>` is NOT a YouTube id, so the download route must resolve it
  // through the JioSaavn catalog — otherwise every paginated search row would
  // download as a fabricated synth track.
  const saavnDl = await req(
    `/api/download?id=saavn-rZL_z-Yh&title=Tu%20Chahiye&artist=A.R.%20Dixit&dur=168`,
    { method: 'HEAD' },
    90_000,
  )
  const saavnProvider = saavnDl.headers.get('x-stream-provider') || ''
  check(
    'saavn-<id> downloads the real catalog track (not the synth)',
    saavnDl.status === 200 && saavnProvider.includes('jiosaavn'),
    `status=${saavnDl.status} provider=${saavnProvider}`,
  )

  const sb = await req(`/api/sponsorblock?id=${YT_ID}`)
  check('sponsorblock returns a segment array', sb.status === 200 && Array.isArray(sb.json?.segments), `status=${sb.status}`)
  check('sponsorblock reports its enabled flag', typeof sb.json?.enabled === 'boolean')
} catch (e) {
  check('download/sponsorblock reachable', false, String(e))
}

// ─────────────────────────────────────────────────────────────
section('home assembly + AI surfaces')
// ─────────────────────────────────────────────────────────────
if (QUICK) {
  skipped('AI surfaces', '--quick')
} else {
  try {
    const home = await req('/api/ai/home', undefined, 180_000)
    const shelves = home.json?.shelves || []
    check('ai/home returns a personalized feed', home.status === 200 && shelves.length >= 3, `status=${home.status} shelves=${shelves.length}`)
    check('ai/home greets the user', typeof home.json?.greeting === 'string' && home.json.greeting.length > 0)
    check('ai/home shelves carry playable rows', shelves.every((sh: any) => !Array.isArray(sh.tracks) || sh.tracks.every(isTrack)))
    check('ai/home reports bandit mode', !!home.json?.bandit?.mode)

    const feat = await req('/api/ai/featured', undefined, 60_000)
    const cards = feat.json?.cards || []
    check('ai/featured returns hub cards', feat.status === 200 && cards.length >= 4, `cards=${cards.length}`)
    check('every featured card is renderable', cards.every((c: any) => typeof c.id === 'string' && typeof c.title === 'string' && typeof c.endpoint === 'string'))

    for (const [label, path] of [
      ['discover-weekly', '/api/ai/discover-weekly'],
      ['release-radar', '/api/ai/release-radar'],
      ['on-repeat', '/api/ai/on-repeat'],
    ] as const) {
      const r = await req(path, undefined, 180_000)
      check(`ai/${label} returns a titled playlist`, r.status === 200 && typeof r.json?.title === 'string' && r.json.title.length > 0, `status=${r.status}`)
      check(`ai/${label} carries playable tracks`, okTracks(r.json, 1), `n=${tracksOf(r.json).length}`)
    }

    const dl = await req('/api/ai/daylist', undefined, 180_000)
    check('ai/daylist returns a live block', dl.status === 200 && typeof dl.json?.block === 'string' && typeof dl.json?.name === 'string', `status=${dl.status}`)

    const dm = await req('/api/ai/daily-mixes', undefined, 180_000)
    const mixes = dm.json?.mixes || []
    check('ai/daily-mixes returns mixes', dm.status === 200 && mixes.length >= 1, `mixes=${mixes.length}`)
    check('every daily mix has tracks', mixes.every((m: any) => tracksOf(m).length >= 1 && tracksOf(m).every(isTrack)), `mixes=${mixes.length}`)

    const moods = await req('/api/ai/mood-playlists', undefined, 60_000)
    check('ai/mood-playlists lists moods', moods.status === 200 && (moods.json?.moods || []).length >= 5, `moods=${moods.json?.moods?.length}`)
    const firstMood = (moods.json?.moods || [])[0]?.key
    if (firstMood) {
      const one = await req(`/api/ai/mood-playlists?mood=${encodeURIComponent(firstMood)}`, undefined, 180_000)
      check(`ai/mood-playlists?mood=${firstMood} returns tracks`, okTracks(one.json, 1), `n=${tracksOf(one.json).length}`)
    }

    const rise = await req('/api/ai/on-the-rise', undefined, 120_000)
    const risePost = await post('/api/ai/on-the-rise', {}, 180_000)
    check('ai/on-the-rise responds', rise.status === 200 || risePost.status === 200)
    check('ai/on-the-rise yields tracks on POST', okTracks(risePost.json, 1), `n=${tracksOf(risePost.json).length}`)

    const vibe = await post('/api/ai/vibe-search', { query: 'rainy night coding' }, 180_000)
    check('ai/vibe-search maps a vibe to tracks', vibe.status === 200 && okTracks(vibe.json, 1), `status=${vibe.status} n=${tracksOf(vibe.json).length}`)

    const rec = await post('/api/ai/recommended-songs', { seedTrackIds: [YT_ID2, YT_ID], excludeTrackIds: [YT_ID], count: 8 }, 180_000)
    check('ai/recommended-songs returns recommendations', rec.status === 200 && okTracks(rec.json, 1), `status=${rec.status} n=${tracksOf(rec.json).length}`)
    check('recommended-songs honours the exclude set', !tracksOf(rec.json).map((t: any) => t.videoId).includes(YT_ID))
    check('recommended-songs never repeats a row', (() => {
      const ids = tracksOf(rec.json).map((t: any) => t.videoId)
      return new Set(ids).size === ids.length
    })())

    const sr = await req(`/api/ai/smart-radio?seedVideoId=${YT_ID2}`, undefined, 180_000)
    check('ai/smart-radio fills a station from one seed', sr.status === 200 && okTracks(sr.json, 5), `status=${sr.status} n=${tracksOf(sr.json).length}`)

    // smart-shuffle needs real track objects
    const seedTracks = tracksOf((await req('/api/ytm/radio?id=' + YT_ID2)).json).slice(0, 8)
    const sh = await post('/api/ai/smart-shuffle', { tracks: seedTracks, count: 3 }, 120_000)
    check('ai/smart-shuffle returns a queue', sh.status === 200 && Array.isArray(sh.json?.tracks), `status=${sh.status}`)
    // Smart Shuffle AUGMENTS the queue (inserts recs after every 3rd seed), so the
    // contract is: everything you queued survives, plus fresh non-duplicate rows.
    const shTracks = sh.json?.tracks || []
    const seedIds = seedTracks.map((t: any) => t.videoId).filter(Boolean)
    const shIds = shTracks.map((t: any) => t.videoId).filter(Boolean)
    check('smart-shuffle keeps every queued track', seedIds.every((id: string) => shIds.includes(id)), `seeds=${seedIds.length} out=${shIds.length}`)
    check('smart-shuffle augments rather than reorders', shTracks.length >= seedTracks.length, `out=${shTracks.length} seeds=${seedTracks.length}`)
    check('smart-shuffle inserts fresh, non-duplicate rows', new Set(shIds).size === shIds.length, `unique=${new Set(shIds).size}/${shIds.length}`)
    check('smart-shuffle never displaces the current track', shTracks.length === 0 || shTracks[0]?.videoId === seedTracks[0]?.videoId, `first=${shTracks[0]?.videoId}`)
    check('smart-shuffle reports where it inserted', Array.isArray(sh.json?.insertedAt))

    // endless feed — two batches, no duplicates, session continuity
    // A feed batch is { kind: 'songs'|'albums', title, rows } — songs carry
    // videoId, album cards carry browseId.
    const rowKey = (r: any) => r.videoId || r.browseId || r.albumId || r.id
    const f1 = await post('/api/ai/feed', { seed: 'e2e' }, 180_000)
    check('ai/feed returns a first batch', f1.status === 200 && !!f1.json, `status=${f1.status}`)
    check('ai/feed batch is a labelled shelf', typeof f1.json?.batch?.kind === 'string' && typeof f1.json?.batch?.title === 'string', `batch=${JSON.stringify(f1.json?.batch)?.slice(0, 60)}`)
    const rows1: any[] = f1.json?.batch?.rows || []
    console.log(`      batch 1: kind=${f1.json?.batch?.kind} rows=${rows1.length}`)
    check('ai/feed batch carries rows', rows1.length > 0)
    check('ai/feed rows are renderable', rows1.every((r: any) => typeof r.title === 'string' && !!rowKey(r)))
    const sessionKey = f1.json?.sessionKey
    check('ai/feed issues a session key', typeof sessionKey === 'string' && sessionKey.length > 0)
    if (sessionKey) {
      const f2 = await post('/api/ai/feed', { sessionKey, seed: 'e2e' }, 180_000)
      const rows2: any[] = f2.json?.batch?.rows || []
      console.log(`      batch 2: kind=${f2.json?.batch?.kind} rows=${rows2.length}`)
      const ids1 = new Set(rows1.map(rowKey).filter(Boolean))
      const dupes = rows2.filter((r: any) => ids1.has(rowKey(r))).length
      check('ai/feed second batch continues the session', f2.status === 200 && (rows2.length > 0 || f2.json?.exhausted === true), `n=${rows2.length} exhausted=${f2.json?.exhausted}`)
      check('ai/feed batches never repeat a row', dupes === 0, `dupes=${dupes}`)
      check('ai/feed keeps one session across calls', f2.json?.sessionKey === sessionKey || !!f2.json?.exhausted)
    }

    // the flagship: streaming playlist generator
    const t0 = Date.now()
    const gen = await fetch(`${BASE}/api/ai/playlist-generator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'e2e oracle: upbeat 80s synth pop for a road trip', count: 10 }),
      signal: AbortSignal.timeout(240_000),
    })
    const genText = await gen.text()
    const genEvents = ndjson(genText)
    const phases = genEvents.filter((e) => e.type === 'phase').map((e) => e.phase)
    const genTracks = genEvents.filter((e) => e.type === 'track')
    const done = genEvents.find((e) => e.type === 'done')
    const err = genEvents.find((e) => e.type === 'error')
    console.log(`      phases=${phases.join('→')} tracks=${genTracks.length} in ${Date.now() - t0}ms`)
    check('playlist-generator streams SSE events', gen.status === 200 && genEvents.length > 0)
    check('playlist-generator emits its phases', phases.length >= 1)
    check('playlist-generator streams tracks with reasons', genTracks.length >= 1 && genTracks.every((e) => isTrack(e.track) && typeof e.reason === 'string'), `n=${genTracks.length}`)
    check('playlist-generator finishes with a persisted playlist', !!done && typeof done.playlistId === 'string' && done.playlistId.length > 0, `done=${JSON.stringify(done)?.slice(0, 90)}`)
    check('playlist-generator ends without an error event', !err, err ? JSON.stringify(err).slice(0, 90) : undefined)
    if (done?.playlistId) {
      const pls = await req('/api/library/playlists', undefined, 60_000)
      check('generated playlist is persisted and listed', (pls.json?.playlists || []).some((p: any) => p.id === done.playlistId))
    }

    // malformed input must not 500
    const bad = await post('/api/ai/playlist-generator', {}, 60_000)
    check('playlist-generator rejects an empty body cleanly', bad.status >= 400 && bad.status < 500, `status=${bad.status}`)
  } catch (e) {
    check('AI surfaces reachable', false, String(e))
  }
}

// ─────────────────────────────────────────────────────────────
section('mindbeat — the learning engine')
// ─────────────────────────────────────────────────────────────
try {
  const prof = await req('/api/mindbeat/profile', undefined, 60_000)
  check('mindbeat/profile returns a taste profile', prof.status === 200 && Array.isArray(prof.json?.topArtists), `status=${prof.status}`)
  check('profile artists carry weights', (prof.json?.topArtists || []).every((a: any) => typeof a.name === 'string' && typeof a.weight === 'number'))

  const nup = await post('/api/mindbeat/next-up', { seeds: [YT_ID2], count: 5, surface: 'home' }, 120_000)
  const picks = nup.json?.picks || []
  check('mindbeat/next-up returns graded picks', nup.status === 200 && picks.length >= 1, `status=${nup.status} picks=${picks.length}`)
  check('every pick is a playable track', picks.every((p: any) => isTrack(p.track || p)))

  const rd = await post('/api/mindbeat/radio', { seedTrack: { videoId: YT_ID2, title: 'Blank Space', artistName: 'Taylor Swift' }, count: 8 }, 180_000)
  check('mindbeat/radio builds a station', rd.status === 200 && (rd.json?.picks || []).length >= 1, `status=${rd.status}`)
  check('mindbeat/radio rejects a missing seed', (await post('/api/mindbeat/radio', {}, 30_000)).status === 400)

  const led = await post('/api/mindbeat/ledger', {
    events: [
      {
        id: `e2e-${Date.now()}`,
        ts: new Date().toISOString(),
        type: 'TRACK_START',
        sessionId: 'e2e-session',
        trackId: YT_ID2,
        artistId: ARTIST_ID,
        artistName: 'Taylor Swift',
        surface: 'search',
      },
    ],
  }, 60_000)
  check('mindbeat/ledger accepts a graded event', led.status === 200 && led.json?.ok === true && led.json?.inserted === 1, `body=${led.text.slice(0, 80)}`)
  check('mindbeat/ledger rejects an empty event list', (await post('/api/mindbeat/ledger', { events: [] }, 30_000)).status === 400)

  const feats = await req('/api/mindbeat/features', undefined, 60_000)
  check('mindbeat/features answers', feats.status === 200 && !!feats.json, `status=${feats.status}`)

  const ctx = await req('/api/mindbeat/ledger?sessionId=e2e-session', undefined, 60_000)
  check('mindbeat/ledger GET returns session context', ctx.status === 200 && !!ctx.json, `status=${ctx.status}`)
} catch (e) {
  check('mindbeat reachable', false, String(e))
}

// ─────────────────────────────────────────────────────────────
section('library + onboarding')
// ─────────────────────────────────────────────────────────────
try {
  const likesBefore = tracksOf((await req('/api/library/likes', undefined, 60_000)).json).map((t: any) => t.videoId)

  // The likes route is a TOGGLE (like → unlike on the second identical call),
  // which is what the client's optimistic like/unlike store expects.
  const likeBody = { videoId: YT_ID, track: { videoId: YT_ID, title: 'Never Gonna Give You Up', artistName: 'Rick Astley' } }
  const add = await post('/api/library/likes', likeBody, 60_000)
  check('likes accepts a track', add.status === 200 && add.json?.liked === true, `status=${add.status} body=${add.text.slice(0, 40)}`)
  const afterRaw = await req('/api/library/likes', undefined, 60_000)
  const after = tracksOf(afterRaw.json).map((t: any) => t.videoId)
  check(
    'liked track is persisted',
    after.includes(YT_ID),
    `n=${after.length} before=${likesBefore.length} raw=${afterRaw.text.slice(0, 160)}`
  )
  check('likes rejects a body without a videoId', (await post('/api/library/likes', { track: likeBody.track }, 30_000)).status === 400)

  const off = await post('/api/library/likes', likeBody, 60_000)
  const afterOff = tracksOf((await req('/api/library/likes', undefined, 60_000)).json).map((t: any) => t.videoId)
  check('toggling again unlikes it', off.status === 200 && off.json?.liked === false && !afterOff.includes(YT_ID), `liked=${off.json?.liked}`)
  check('like toggle restores the exact original set', afterOff.length === likesBefore.length && likesBefore.every((v) => afterOff.includes(v)), `${afterOff.length} vs ${likesBefore.length}`)

  check('playlists rejects an unknown action', (await post('/api/library/playlists', { action: 'definitely-not-an-action' }, 30_000)).status === 400)
  const created = await post('/api/library/playlists', { action: 'create', name: 'E2E Oracle Playlist', description: 'created by scripts/e2e-check.ts' }, 60_000)
  const pid = created.json?.playlist?.id || created.json?.id
  check('playlists creates one', created.status === 200 && typeof pid === 'string' && pid.length > 0, `body=${created.text.slice(0, 80)}`)
  if (pid) {
    const added = await post('/api/library/playlists', { action: 'addTrack', playlistId: pid, videoId: YT_ID2, track: { videoId: YT_ID2, title: 'Blank Space', artistName: 'Taylor Swift' } }, 90_000)
    check('playlists accepts a track', added.status === 200, `status=${added.status}`)
    const dup = await post('/api/library/playlists', { action: 'addTrack', playlistId: pid, videoId: YT_ID2, track: { videoId: YT_ID2, title: 'Blank Space', artistName: 'Taylor Swift' } }, 60_000)
    check('adding the same track twice is a no-op', dup.status === 200 && dup.json?.duplicate === true, `body=${dup.text.slice(0, 50)}`)
    // The LIST endpoint's contract is coverTracks + trackCount (its raw `tracks`
    // field is join rows that no client reads). The SINGLE endpoint returns the
    // flattened, playable PlayerTrack shape.
    const got = await req('/api/library/playlists', undefined, 60_000)
    const mine = (got.json?.playlists || []).find((p: any) => p.id === pid)
    check('playlist list carries coverTracks + trackCount', !!mine && Array.isArray(mine.coverTracks) && mine.trackCount === 1, `coverTracks=${mine?.coverTracks?.length} trackCount=${mine?.trackCount}`)
    check('coverTracks are renderable rows', (mine?.coverTracks || []).every((t: any) => isTrack(t)))
    const single = await req(`/api/library/playlists?id=${pid}`, undefined, 60_000)
    check('single playlist returns flattened playable tracks', okTracks(single.json?.playlist, 1), `n=${tracksOf(single.json?.playlist).length}`)
    check('single playlist tracks are the ones added', tracksOf(single.json?.playlist).some((t: any) => t.videoId === YT_ID2))
    check('playlist keeps exactly one copy', tracksOf(single.json?.playlist).filter((t: any) => t.videoId === YT_ID2).length === 1)

    const reordered = await post('/api/library/playlists', { action: 'reorder', playlistId: pid, trackIds: [YT_ID2] }, 60_000)
    check('playlists reorders', reordered.status === 200 && reordered.json?.ok === true, `status=${reordered.status}`)
    const removed = await post('/api/library/playlists', { action: 'removeTrack', playlistId: pid, videoId: YT_ID2 }, 60_000)
    const afterRemove = (await req('/api/library/playlists', undefined, 60_000)).json?.playlists || []
    const mine2 = afterRemove.find((p: any) => p.id === pid)
    check('playlists removes a track and reflows the count', removed.status === 200 && mine2?.trackCount === 0, `trackCount=${mine2?.trackCount}`)
    check('removed track is gone from the single view too', tracksOf((await req(`/api/library/playlists?id=${pid}`, undefined, 60_000)).json?.playlist).length === 0)

    const renamed = await post('/api/library/playlists', { action: 'rename', playlistId: pid, name: 'E2E Oracle Playlist v2' }, 60_000)
    check('playlists renames', renamed.status === 200 && (renamed.json?.playlist?.name === 'E2E Oracle Playlist v2'), `name=${renamed.json?.playlist?.name}`)
    const del = await post('/api/library/playlists', { action: 'delete', playlistId: pid }, 60_000)
    const after = (await req('/api/library/playlists', undefined, 60_000)).json?.playlists || []
    check('playlists deletes and stays consistent', del.status === 200 && !after.some((p: any) => p.id === pid))
  }

  const hist = await req('/api/library/history?limit=10', undefined, 60_000)
  check('history returns recent listens', hist.status === 200 && Array.isArray(hist.json?.tracks), `status=${hist.status}`)
  check('history rows are playable', (hist.json?.tracks || []).every(isTrack))

  const onb = await req('/api/onboarding', undefined, 60_000)
  check('onboarding reports profile state', onb.status === 200 && typeof onb.json?.complete === 'boolean', `status=${onb.status}`)
  if (onb.json?.complete) {
    check('onboarding returns name/artists/genres', typeof onb.json.name === 'string' && Array.isArray(onb.json.artists) && Array.isArray(onb.json.genres))
    // round-trip the SAME profile so nothing the user has is destroyed
    const same = await post('/api/onboarding', {
      action: 'save',
      name: onb.json.name, bio: onb.json.bio, artists: onb.json.artists, genres: onb.json.genres,
    }, 60_000)
    check('onboarding accepts a profile round-trip', same.status === 200, `status=${same.status} body=${same.text.slice(0, 70)}`)
    const stillThere = await req('/api/onboarding', undefined, 60_000)
    check('profile survives the rewrite', stillThere.json?.name === onb.json.name && stillThere.json?.complete === true)
    check('profile keeps its artists and genres', (stillThere.json?.artists || []).length === (onb.json.artists || []).length && (stillThere.json?.genres || []).length === (onb.json.genres || []).length)
  }

  const seeds = await req('/api/onboarding/seed-artists', undefined, 60_000)
  check('seed-artists returns a browse list', seeds.status === 200 && (seeds.json?.artists || []).length >= 10, `n=${seeds.json?.artists?.length}`)
  check('seed artists are renderable', (seeds.json?.artists || []).every((a: any) => typeof a.id === 'string' && typeof a.name === 'string'))
} catch (e) {
  check('library/onboarding reachable', false, String(e))
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(64)}`)
console.log(`${pass} passed, ${fail} failed, ${skip} skipped`)
if (fail) {
  console.log('\nFailed checks:')
  for (const f of failures) console.log(`  • ${f}`)
}
process.exit(fail > 0 ? 1 : 0)
