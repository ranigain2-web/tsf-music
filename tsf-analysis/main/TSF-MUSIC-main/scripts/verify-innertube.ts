/**
 * TSF Music — InnerTube live verification (Phase 0 gate)
 * Tests: 1) YT Music search  2) iOS-client stream resolution  3) actual audio bytes (Range/206)
 */
const YTM_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const IOS_KEY = 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc'

const IOS_CTX = {
  context: {
    client: {
      clientName: 'IOS',
      clientVersion: '19.29.1',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '17.5.1.21F90',
      hl: 'en',
      timeZone: 'UTC',
      utcOffsetMinutes: 0,
    },
  },
  contentCheckOk: true,
  racyCheckOk: true,
}

const WEBREMIX_CTX = {
  context: {
    client: {
      clientName: 'WEB_REMIX',
      clientVersion: '1.20240403.01.00',
      hl: 'en',
      gl: 'US',
    },
  },
}

async function ytFetch(path: string, key: string, body: object) {
  const res = await fetch(`https://music.youtube.com/youtubei/v1/${path}?key=${key}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
      'X-Goog-Api-Format-Version': '2',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}

function dig(obj: any, path: string): any {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj)
}

async function main() {
  // ---- TEST 1: YT Music search ----
  console.log('[1] YT Music search: "Daft Punk Around the World"')
  const search = await ytFetch('search', YTM_KEY, { ...WEBREMIX_CTX, query: 'Daft Punk Around the World' })
  const results: any[] = []
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (n.musicResponsiveListItemRenderer) {
      const item = n.musicResponsiveListItemRenderer
      const title = dig(item, 'flexColumns.0.musicResponsiveListItemFlexColumnRenderer.text.runs.0.text')
      const videoId = dig(item, 'flexColumns.0.musicResponsiveListItemFlexColumnRenderer.text.runs.0.navigationEndpoint.watchEndpoint.videoId')
        || dig(item, 'playlistItemData.videoId')
      if (videoId) results.push({ title, videoId })
    }
    for (const v of Object.values(n)) walk(v)
  }
  walk(search)
  console.log(`    found ${results.length} songs; first 3:`, JSON.stringify(results.slice(0, 3), null, 0))
  if (!results.length) throw new Error('SEARCH FAILED — no songs parsed')
  const videoId = results[0].videoId

  // ---- TEST 2: iOS stream resolution ----
  console.log(`[2] iOS player resolve: ${videoId}`)
  const player = await ytFetch('player', IOS_KEY, { ...IOS_CTX, videoId })
  const status = dig(player, 'playabilityStatus.status')
  const formats: any[] = dig(player, 'streamingData.adaptiveFormats') || []
  const audio = formats
    .filter((f) => f.itag === 140 || (f.mimeType || '').includes('audio/mp4'))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]
  console.log(`    playability=${status}, adaptiveFormats=${formats.length}, best-audio itag=${audio?.itag} mime=${audio?.mimeType?.slice(0, 30)} bitrate=${audio?.bitrate}`)
  if (!audio?.url) {
    // try fallback: dashManifestUrl presence
    console.log('    !! no direct url; cipher=', !!audio?.signatureCipher, 'dash=', !!dig(player, 'streamingData.dashManifestUrl'))
    throw new Error('STREAM RESOLVE FAILED — no direct audio URL from iOS client')
  }

  // ---- TEST 3: actual audio bytes ----
  console.log('[3] Range-fetch first 64KB of the stream URL...')
  const t0 = Date.now()
  const audioRes = await fetch(audio.url, {
    headers: { Range: 'bytes=0-65535', 'User-Agent': 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)' },
  })
  const buf = await audioRes.arrayBuffer()
  const ms = Date.now() - t0
  console.log(`    HTTP ${audioRes.status} ${audioRes.headers.get('content-type')} bytes=${buf.byteLength} in ${ms}ms`)
  if (audioRes.status !== 206 && audioRes.status !== 200) throw new Error(`AUDIO FETCH FAILED — HTTP ${audioRes.status}`)
  // MP4 sanity: ftyp box within first bytes
  const head = Buffer.from(buf.slice(0, 64))
  const isMp4 = head.slice(4, 8).toString('ascii') === 'ftyp' || head.includes(Buffer.from('ftyp'))
  console.log(`    MP4 ftyp marker present: ${isMp4}`)

  console.log('\n=== ALL INNERTUBE TESTS PASSED — foundation is LIVE ===')
}

main().catch((e) => {
  console.error('\n=== FAILURE ===')
  console.error(e)
  process.exit(1)
})
