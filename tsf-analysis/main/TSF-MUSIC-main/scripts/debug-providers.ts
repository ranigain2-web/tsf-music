/** Debug round 6: multi-provider stream test — Piped / Invidious / Cobalt instances */
const VIDEO_ID = 'LKYPYj2XX80' // Around the World

const PIPED = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.drgns.space',
]
const INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://invidious.f5.si',
]
const COBALT = [
  'https://cobalt-api.kwiatekmiki.com',
  'https://capi.3kh0.net',
  'https://cobalt-backend.canine.tools',
]

const probe = async (label: string, url: string, headers: Record<string, string> = {}) => {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-32768', ...headers } })
    const b = await r.arrayBuffer()
    const ct = r.headers.get('content-type') || ''
    const ok = (r.status === 206 || r.status === 200) && b.byteLength > 10000 && (ct.includes('audio') || ct.includes('mp4') || ct.includes('octet-stream'))
    console.log(`   ${ok ? '✅' : '❌'} probe ${r.status} ${ct.slice(0, 30)} ${b.byteLength}B`)
    return ok
  } catch (e: any) {
    console.log(`   ❌ probe fail: ${e.message.slice(0, 60)}`)
    return false
  }
}

async function testPiped() {
  for (const base of PIPED) {
    try {
      const t0 = Date.now()
      const r = await fetch(`${base}/streams/${VIDEO_ID}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) })
      if (!r.ok) { console.log(`• piped ${base}: HTTP ${r.status}`); continue }
      const j = await r.json()
      const audio = (j.audioStreams || []).filter((a: any) => a.mimeType?.includes('audio/mp4')).sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0]
      console.log(`• piped ${base}: title="${j.title?.slice(0, 30)}" audioStreams=${j.audioStreams?.length} best=${audio?.quality ?? '-'} ${Date.now() - t0}ms`)
      if (audio) { if (await probe('piped', audio.url)) return base }
    } catch (e: any) { console.log(`• piped ${base}: ${e.message.slice(0, 60)}`) }
  }
  return null
}

async function testInvidious() {
  for (const base of INVIDIOUS) {
    try {
      const r = await fetch(`${base}/api/v1/videos/${VIDEO_ID}?local=true`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) })
      if (!r.ok) { console.log(`• inv ${base}: HTTP ${r.status}`); continue }
      const j = await r.json()
      const audio = (j.adaptiveFormats || []).filter((a: any) => a.type?.includes('audio/mp4')).sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0]
      console.log(`• inv ${base}: title="${j.title?.slice(0, 30)}" adaptive=${j.adaptiveFormats?.length} best=${audio?.qualityLabel ?? audio?.itag ?? '-'}`)
      if (audio) { if (await probe('inv', audio.url)) return base }
    } catch (e: any) { console.log(`• inv ${base}: ${e.message.slice(0, 60)}`) }
  }
  return null
}

async function testCobalt() {
  for (const base of COBALT) {
    try {
      const r = await fetch(`${base}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${VIDEO_ID}`, downloadMode: 'audio', audioFormat: 'mp3' }),
        signal: AbortSignal.timeout(10000),
      })
      if (!r.ok) { console.log(`• cobalt ${base}: HTTP ${r.status}`); continue }
      const j = await r.json()
      console.log(`• cobalt ${base}: status=${j.status} ${j.url ? 'url!' : ''} ${j.error ? 'err=' + j.error.code : ''}`)
      if (j.url && j.status === 'tunnel' || j.status === 'redirect') { if (await probe('cobalt', j.url)) return base }
    } catch (e: any) { console.log(`• cobalt ${base}: ${e.message.slice(0, 60)}`) }
  }
  return null
}

async function main() {
  console.log('=== PIPED ===')
  const p = await testPiped()
  console.log('\n=== INVIDIOUS ===')
  const i = await testInvidious()
  console.log('\n=== COBALT ===')
  const c = await testCobalt()
  console.log(`\n=== RESULTS: piped=${p || '-'} invidious=${i || '-'} cobalt=${c || '-'} ===`)
}
main()
