/** Retest iOS player now that InnerTube recovered */
const IOS_KEY = 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc'
const VIDEO = 'LKYPYj2XX80'

async function main() {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${IOS_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)', 'X-Goog-Api-Format-Version': '2' },
    body: JSON.stringify({
      videoId: VIDEO, contentCheckOk: true, racyCheckOk: true,
      context: { client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', timeZone: 'UTC', utcOffsetMinutes: 0 } },
    }),
  })
  if (!res.ok) { console.log(`player HTTP ${res.status} — still blocked`); return }
  const j = await res.json()
  const ps = j?.playabilityStatus
  console.log(`playability: ${ps?.status} "${ps?.reason || ''}"`)
  const formats = j?.streamingData?.adaptiveFormats || []
  const audio = formats.filter((f: any) => f.mimeType?.includes('audio/mp4')).sort((a: any, b: any) => b.bitrate - a.bitrate)[0]
  console.log(`formats=${formats.length} bestAudio=${audio?.itag} url=${!!audio?.url}`)
  if (audio?.url) {
    const r = await fetch(audio.url, { headers: { Range: 'bytes=0-65535', 'User-Agent': 'com.google.ios.youtube/20.10.4' } })
    const b = await r.arrayBuffer()
    console.log(`stream probe: HTTP ${r.status} ${r.headers.get('content-type')} ${b.byteLength}B`)
    if (r.status === 206 || r.status === 200) console.log('\n=== iOS CLIENT IS LIVE — DIRECT STREAMS WORK ===')
  }
}
main()
