/** Debug round 4: WEB_REMIX player, embed with reasons, newest IOS, ANDROID_CREATOR */
const KEYS: Record<string, string> = {
  IOS: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
  WEB: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
  ANDROID: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
  YTM: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
}
const EMBED_PARAMS = '8sYwghZ6HFoYdGRXb0NHdEFTaVFIc0FqUUtJblJFQUkuc2hvdF9tZXRyaWNzPUSHgJi5lKi3kZ7VDQ%3D%3D'

async function getVisitorData(): Promise<string | null> {
  const res = await fetch('https://www.youtube.com/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
  })
  return (await res.text()).match(/"visitorData":"([^"]+)"/)?.[1] ?? null
}

async function tryPlayer(label: string, host: string, key: string, ua: string, body: any) {
  try {
    const res = await fetch(`${host}/youtubei/v1/player?key=${key}&prettyPrint=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': ua, 'X-Goog-Api-Format-Version': '2', Origin: host },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      console.log(`✗ ${label}: HTTP ${res.status}`)
      return null
    }
    const j = await res.json()
    const ps = j?.playabilityStatus || {}
    const formats = [...(j?.streamingData?.adaptiveFormats || []), ...(j?.streamingData?.formats || [])]
    const audio = formats.filter((f: any) => (f.mimeType || '').includes('audio')).sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0]
    const video = formats.filter((f: any) => (f.mimeType || '').includes('video')).sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0]
    console.log(`• ${label}: ${ps.status} | reason="${(ps.reason || '').slice(0, 70)}" | formats=${formats.length} audio=${audio?.itag ?? '-'}(${!!audio?.url}) video=${video?.itag ?? '-'}(${!!video?.url})`)
    return audio?.url || video?.url ? { j, audio, video } : null
  } catch (e: any) {
    console.log(`✗ ${label}: ${e.message}`)
    return null
  }
}

async function main() {
  const vd = await getVisitorData()
  console.log(`visitorData: ${vd ? 'ok' : 'none'}\n`)
  const results: any[] = []
  const add = (label: string, host: string, key: string, ua: string, body: any) => results.push({ label, host, key, ua, body })

  // A. WEB_REMIX player (music host)
  add('WEB_REMIX player', 'https://music.youtube.com', KEYS.YTM,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    { videoId: 'LKYPYj2XX80', contentCheckOk: true, racyCheckOk: true, context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } } })

  // B. TVHTML5_SIMPLY_EMBEDDED_PLAYER + params + thirdParty (full InnerTune shape)
  add('TVHTML5 embed+3p', 'https://www.youtube.com', KEYS.WEB, 'Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15',
    {
      videoId: 'LKYPYj2XX80', contentCheckOk: true, racyCheckOk: true, params: EMBED_PARAMS,
      context: {
        client: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', clientScreen: 'EMBED', hl: 'en' },
        thirdParty: { embedUrl: 'https://www.youtube.com/watch?v=LKYPYj2XX80' },
      },
    })

  // C. WEB_EMBEDDED_PLAYER + params
  add('WEB_EMBEDDED_PLAYER', 'https://www.youtube.com', KEYS.WEB, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    {
      videoId: 'LKYPYj2XX80', contentCheckOk: true, racyCheckOk: true,
      context: {
        client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20250310.01.00', clientScreen: 'EMBED', hl: 'en' },
        thirdParty: { embedUrl: 'https://www.google.com/' },
      },
    })

  // D. IOS newest-ish with visitorData
  add('IOS 21.51.2', 'https://www.youtube.com', KEYS.IOS, 'com.google.ios.youtube/21.51.2 (iPhone17,1; U; CPU iOS 18_3_2 like Mac OS X;)',
    { videoId: 'LKYPYj2XX80', contentCheckOk: true, racyCheckOk: true, context: { client: { clientName: 'IOS', clientVersion: '21.51.2', deviceMake: 'Apple', deviceModel: 'iPhone17,1', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', timeZone: 'UTC', utcOffsetMinutes: 0, visitorData: vd || undefined } } })

  // E. ANDROID_CREATOR
  add('ANDROID_CREATOR', 'https://www.youtube.com', KEYS.ANDROID, 'com.google.android.apps.youtube.creator/25.06.35 (Linux; U; Android 14)',
    { videoId: 'LKYPYj2XX80', contentCheckOk: true, racyCheckOk: true, context: { client: { clientName: 'ANDROID_CREATOR', clientVersion: '25.06.35', androidSdkVersion: 34, osName: 'Android', osVersion: '14', hl: 'en' } } })

  for (const r of results) {
    const hit = await tryPlayer(r.label, r.host, r.key, r.ua, r.body)
    if (hit) {
      const url = hit.audio?.url || hit.video?.url
      const probe = await fetch(url, { headers: { Range: 'bytes=0-32768', 'User-Agent': r.ua } })
      const b = await probe.arrayBuffer()
      console.log(`   → probe: HTTP ${probe.status} ${probe.headers.get('content-type')} ${b.byteLength}B`)
      if (probe.status === 206 || probe.status === 200) {
        console.log(`\n=== WINNER: ${r.label} ===`)
        return
      }
    }
  }
  console.log('\n=== no winner ===')
}
main()
