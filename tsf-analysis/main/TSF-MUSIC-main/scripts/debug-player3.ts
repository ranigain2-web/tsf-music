/** Debug round 3: full client matrix incl. MEDIA_CONNECT_FRONTEND, ANDROID_VR, IOS_MUSIC */
const KEYS: Record<string, string> = {
  IOS: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
  WEB: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
  ANDROID: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
  YTM: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
  YTM_ANDROID: 'AIzaSyC2nHJD2s6GFhc2l6dG9vY0FvZnRzd2Fz', // placeholder-ish; try anyway
}
const videoId = 'LKYPYj2XX80'

const UA = {
  ios: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
  android: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
  vr: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
  tv: 'Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
}

async function getVisitorData(): Promise<string | null> {
  try {
    const res = await fetch('https://www.youtube.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    })
    const html = await res.text()
    const m = html.match(/"visitorData":"([^"]+)"/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

const configs: { label: string; key: string; host: string; ua: string; body: any }[] = [
  {
    label: 'MEDIA_CONNECT_FRONTEND',
    key: KEYS.ANDROID, host: 'https://www.youtube.com', ua: UA.android,
    body: { videoId, contentCheckOk: true, racyCheckOk: true, context: { client: { clientName: 'MEDIA_CONNECT_FRONTEND', clientVersion: '0.1', hl: 'en' } } },
  },
  {
    label: 'ANDROID_VR 1.60.19',
    key: KEYS.ANDROID, host: 'https://www.youtube.com', ua: UA.vr,
    body: { videoId, contentCheckOk: true, racyCheckOk: true, context: { client: { clientName: 'ANDROID_VR', clientVersion: '1.60.19', deviceMake: 'Meta', deviceModel: 'Quest 3', osName: 'Android', osVersion: '12L', androidSdkVersion: 32, hl: 'en' } } },
  },
  {
    label: 'ANDROID_VR on googleapis',
    key: KEYS.ANDROID, host: 'https://youtubei.googleapis.com', ua: UA.vr,
    body: { videoId, contentCheckOk: true, racyCheckOk: true, context: { client: { clientName: 'ANDROID_VR', clientVersion: '1.60.19', hl: 'en' } } },
  },
  {
    label: 'ANDROID on googleapis',
    key: KEYS.ANDROID, host: 'https://youtubei.googleapis.com', ua: UA.android,
    body: { videoId, contentCheckOk: true, racyCheckOk: true, context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11', hl: 'en' } } },
  },
  {
    label: 'IOS_MUSIC 8.02.2',
    key: KEYS.YTM, host: 'https://music.youtube.com', ua: 'YouTubeMusic/8.02.2 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    body: { videoId, contentCheckOk: true, racyCheckOk: true, context: { client: { clientName: 'IOS_MUSIC', clientVersion: '8.02.2', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', timeZone: 'UTC', utcOffsetMinutes: 0 } } },
  },
  {
    label: 'TVHTML5 no-embed v2.0',
    key: KEYS.WEB, host: 'https://www.youtube.com', ua: UA.tv,
    body: { videoId, contentCheckOk: true, racyCheckOk: true, context: { client: { clientName: 'TVHTML5', clientVersion: '7.20250312.16.00', hl: 'en' } } },
  },
]

async function main() {
  const vd = await getVisitorData()
  console.log(`visitorData: ${vd ? 'ok' : 'none'}\n`)
  for (const c of configs) {
    if (vd) c.body.context.client.visitorData = vd
    try {
      const res = await fetch(`${c.host}/youtubei/v1/player?key=${c.key}&prettyPrint=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': c.ua, 'X-Goog-Api-Format-Version': '2' },
        body: JSON.stringify(c.body),
      })
      if (!res.ok) {
        const txt = (await res.text()).slice(0, 120).replace(/\s+/g, ' ')
        console.log(`✗ ${c.label}: HTTP ${res.status} ${txt}`)
        continue
      }
      const j = await res.json()
      const status = j?.playabilityStatus?.status
      const reason = (j?.playabilityStatus?.reason || '').slice(0, 60)
      const formats = [...(j?.streamingData?.adaptiveFormats || []), ...(j?.streamingData?.formats || [])]
      const audio = formats.filter((f: any) => (f.mimeType || '').includes('audio')).sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0]
      console.log(`• ${c.label}: ${status} formats=${formats.length} audio=${audio?.itag ?? '-'} url=${!!audio?.url} ${reason}`)
      if (audio?.url) {
        const r = await fetch(audio.url, { headers: { Range: 'bytes=0-32768', 'User-Agent': c.ua } })
        const b = await r.arrayBuffer()
        console.log(`   → stream probe: HTTP ${r.status} ${r.headers.get('content-type')} ${b.byteLength}B`)
        if (r.status === 206 || r.status === 200) {
          console.log(`\n=== WINNER: ${c.label} ===`)
          return
        }
      }
    } catch (e: any) {
      console.log(`✗ ${c.label}: ${e.message}`)
    }
  }
  console.log('\n=== no winner yet ===')
}
main()
