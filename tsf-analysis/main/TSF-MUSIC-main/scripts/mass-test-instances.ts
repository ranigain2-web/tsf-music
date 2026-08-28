/** Mass-test proxy instances with realistic browser headers */
const VIDEO = 'LKYPYj2XX80'
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.google.com/',
}

const PIPED = [
  'pipedapi.kavin.rocks', 'pipedapi.adminforge.de', 'api.piped.private.coffee',
  'pipedapi.drgns.space', 'papi.piped.yt', 'pipedapi.leptons.xyz', 'piped-api.lunar.icu',
  'api.piped.projectsegfau.lt', 'pipedapi.in.projectsegfau.lt', 'watchapi.whatever.social',
  'pipedapi.smnz.de', 'pipedapi.astartes.nl', 'pipedapi.ducks.party',
  'pipedapi.orangenet.cc', 'pipedapi.nosebs.ru', 'api.piped.privacydev.net',
]
const INVIDIOUS = [
  'inv.nadeko.net', 'invidious.nerdvpn.de', 'yewtu.be', 'invidious.f5.si',
  'iv.melmac.space', 'invidious.privacyredirect.com', 'inv.vern.cc',
  'invidious.protokolla.fi', 'iv.ggtyler.dev', 'invidious.lunivers.trade',
  'iv.datura.network', 'invidious.perennialte.ch', 'inv.tux.pizza',
  'invidious.fdn.fr', 'invidious.materialio.us', 'iv.duti.dev',
]
const COBALT = [
  'cobalt-api.kwiatekmiki.com', 'capi.3kh0.net', 'cobalt-backend.canine.tools',
  'cobalt-api.meowing.de', 'api.cobalt.tools', 'cobalt-api.kwiatekmiki.win',
]

async function probe(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { headers: { ...BROWSER_HEADERS, Range: 'bytes=0-32768' }, signal: AbortSignal.timeout(8000) })
    const b = await r.arrayBuffer()
    const ct = r.headers.get('content-type') || ''
    return (r.status === 206 || r.status === 200) && b.byteLength > 8000 && !ct.includes('text/html')
  } catch { return false }
}

async function main() {
  console.log('=== PIPED ===')
  for (const host of PIPED) {
    try {
      const r = await fetch(`https://${host}/streams/${VIDEO}`, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(8000) })
      if (!r.ok) { console.log(`✗ ${host}: ${r.status}`); continue }
      const j = await r.json()
      const audio = (j.audioStreams || []).filter((a: any) => a.mimeType?.includes('audio/mp4')).sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0]
      if (audio && (await probe(audio.url))) { console.log(`✅✅✅ PIPED WORKS: ${host} — ${j.title}`); return }
      console.log(`• ${host}: ok-json audio=${!!audio} probe-failed`)
    } catch (e: any) { console.log(`✗ ${host}: ${e.message.slice(0, 40)}`) }
  }

  console.log('=== INVIDIOUS ===')
  for (const host of INVIDIOUS) {
    try {
      const r = await fetch(`https://${host}/api/v1/videos/${VIDEO}`, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(8000) })
      if (!r.ok) { console.log(`✗ ${host}: ${r.status}`); continue }
      const j = await r.json()
      const audio = (j.adaptiveFormats || []).filter((a: any) => a.type?.includes('audio/mp4')).sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0]
      if (audio && (await probe(audio.url))) { console.log(`✅✅✅ INVIDIOUS WORKS: ${host} — ${j.title}`); return }
      console.log(`• ${host}: ok-json audio=${!!audio} probe-failed`)
    } catch (e: any) { console.log(`✗ ${host}: ${e.message.slice(0, 40)}`) }
  }

  console.log('=== COBALT ===')
  for (const host of COBALT) {
    try {
      const r = await fetch(`https://${host}/`, {
        method: 'POST', headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${VIDEO}`, downloadMode: 'audio' }),
        signal: AbortSignal.timeout(12000),
      })
      if (!r.ok) { console.log(`✗ ${host}: ${r.status}`); continue }
      const j = await r.json()
      if (j.url && (await probe(j.url))) { console.log(`✅✅✅ COBALT WORKS: ${host} status=${j.status}`); return }
      console.log(`• ${host}: ${j.status} ${j.error?.code || ''} probe=${j.url ? 'fail' : 'nourl'}`)
    } catch (e: any) { console.log(`✗ ${host}: ${e.message.slice(0, 40)}`) }
  }
  console.log('\n=== ALL DEAD ===')
}
main()
