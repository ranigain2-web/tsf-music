/**
 * Quick diagnosis: which stream providers work right now?
 */
const CLIENTS = {
  IOS: {
    host: 'https://www.youtube.com',
    key: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    context: { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2', hl: 'en' },
  },
  ANDROID_VR: {
    host: 'https://www.youtube.com',
    key: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_YYM39w',
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12; eureka-user Build/SQ3A.220705.004.A1) gzip',
    context: { clientName: 'ANDROID_VR', clientVersion: '1.61.48', androidSdkVersion: 32, hl: 'en' },
  },
  TV_EMBEDDED: {
    host: 'https://www.youtube.com',
    key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    userAgent: 'Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko)',
    context: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', hl: 'en' },
  },
  MWEB: {
    host: 'https://m.youtube.com',
    key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/24.3 Mobile/15E148 Safari/604.1',
    context: { clientName: 'MWEB', clientVersion: '2.20250311.03.00', hl: 'en' },
  },
}

const VIDEO_IDS = ['IlyHIUeid5I', 'kJQP7kiw5Fk', '3JZ_D3ELwOQ'] // mix of popular ids

async function testInnertube(name: string, videoId: string) {
  const c = (CLIENTS as any)[name]
  const t0 = Date.now()
  try {
    const res = await fetch(`${c.host}/youtubei/v1/player?key=${c.key}&prettyPrint=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': c.userAgent,
        'X-Goog-Api-Format-Version': '2',
        Origin: 'https://www.youtube.com',
      },
      body: JSON.stringify({
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        context: { client: c.context },
      }),
      signal: AbortSignal.timeout(6000),
    })
    const ms = Date.now() - t0
    if (!res.ok) return `${name}: HTTP ${res.status} (${ms}ms)`
    const j: any = await res.json()
    const status = j?.playabilityStatus?.status
    const reason = j?.playabilityStatus?.reason || ''
    const formats = [...(j.streamingData?.adaptiveFormats || []), ...(j.streamingData?.formats || [])]
    const audio = formats.filter((f: any) => (f.mimeType || '').includes('audio')).length
    const hasUrl = formats.some((f: any) => f.url)
    return `${name}: status=${status} audioFormats=${audio} hasUrl=${hasUrl} reason="${reason}" (${ms}ms)`
  } catch (e: any) {
    return `${name}: FAIL ${(e as Error).message} (${Date.now() - t0}ms)`
  }
}

async function testPiped(base: string, videoId: string) {
  const t0 = Date.now()
  try {
    const res = await fetch(`${base}/streams/${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6000),
    })
    const ms = Date.now() - t0
    if (!res.ok) return `piped ${base}: HTTP ${res.status} (${ms}ms)`
    const j: any = await res.json()
    return `piped ${base}: OK audioStreams=${(j.audioStreams || []).length} (${ms}ms)`
  } catch (e: any) {
    return `piped ${base}: FAIL ${(e as Error).message} (${Date.now() - t0}ms)`
  }
}

async function testInvidious(base: string, videoId: string) {
  const t0 = Date.now()
  try {
    const res = await fetch(`${base}/api/v1/videos/${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6000),
    })
    const ms = Date.now() - t0
    if (!res.ok) return `invidious ${base}: HTTP ${res.status} (${ms}ms)`
    const j: any = await res.json()
    return `invidious ${base}: OK adaptive=${(j.adaptiveFormats || []).length} (${ms}ms)`
  } catch (e: any) {
    return `invidious ${base}: FAIL ${(e as Error).message} (${Date.now() - t0}ms)`
  }
}

const vid = process.argv[2] || VIDEO_IDS[0]
console.log(`=== Provider diagnosis for videoId=${vid} ===`)
const results = await Promise.all([
  testInnertube('IOS', vid),
  testInnertube('ANDROID_VR', vid),
  testInnertube('TV_EMBEDDED', vid),
  testInnertube('MWEB', vid),
  testPiped('https://pipedapi.kavin.rocks', vid),
  testPiped('https://pipedapi.adminforge.de', vid),
  testPiped('https://api.piped.private.coffee', vid),
  testInvidious('https://inv.nadeko.net', vid),
  testInvidious('https://invidious.nerdvpn.de', vid),
  testInvidious('https://yewtu.be', vid),
])
for (const r of results) console.log(r)
