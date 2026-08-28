/** Debug round 5: MEDIA_CONNECT key matrix + WEB_EMBEDDED_PLAYER on embeddable videos */
const KEYS: Record<string, string> = {
  IOS: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
  WEB: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
  ANDROID: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
  YTM: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
  YTM_ANDROID: 'AIzaSyC2nHJD2s6GFhc2l6dG9vY0FvZnRzd2Fz',
}
const HOSTS = ['https://www.youtube.com', 'https://music.youtube.com', 'https://youtubei.googleapis.com']

// videos that are typically embeddable (topic uploads, old classics)
const VIDEOS = ['jNQXAC9IVRw', '9bZkp7q19f0', 'kJQP7kiw5Fk'] // Me at the zoo, Gangnam Style, Despacito

async function tryPlayer(label: string, host: string, key: string, ua: string, body: any) {
  try {
    const res = await fetch(`${host}/youtubei/v1/player?key=${key}&prettyPrint=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': ua, 'X-Goog-Api-Format-Version': '2' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return { label, ok: false, note: `HTTP ${res.status}` }
    const j = await res.json()
    const ps = j?.playabilityStatus || {}
    const formats = [...(j?.streamingData?.adaptiveFormats || []), ...(j?.streamingData?.formats || [])]
    const audio = formats.filter((f: any) => (f.mimeType || '').includes('audio')).sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0]
    const got = !!audio?.url
    return { label, ok: got, note: `${ps.status} "${(ps.reason || '').slice(0, 50)}" itag=${audio?.itag ?? '-'}`, url: audio?.url, ua }
  } catch (e: any) {
    return { label, ok: false, note: e.message }
  }
}

async function main() {
  const hits: any[] = []

  // A. MEDIA_CONNECT_FRONTEND across keys × hosts
  for (const [kn, key] of Object.entries(KEYS)) {
    for (const host of HOSTS) {
      const r = await tryPlayer(`MC_FRONTEND/${kn}/${host.replace('https://', '')}`, host, key,
        'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
        { videoId: 'jNQXAC9IVRw', contentCheckOk: true, racyCheckOk: true, context: { client: { clientName: 'MEDIA_CONNECT_FRONTEND', clientVersion: '0.1', hl: 'en' } } })
      console.log(`${r.ok ? '✓' : '•'} ${r.label}: ${r.note}`)
      if (r.ok) hits.push(r)
    }
  }

  // B. WEB_EMBEDDED_PLAYER across the 3 videos
  for (const vid of VIDEOS) {
    const r = await tryPlayer(`WEB_EMBEDDED/${vid}`, 'https://www.youtube.com', KEYS.WEB,
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      {
        videoId: vid, contentCheckOk: true, racyCheckOk: true,
        context: {
          client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20250310.01.00', clientScreen: 'EMBED', hl: 'en' },
          thirdParty: { embedUrl: 'https://www.google.com/' },
        },
      })
    console.log(`${r.ok ? '✓' : '•'} ${r.label}: ${r.note}`)
    if (r.ok) hits.push(r)
  }

  // C. ANDROID_MUSIC with the remix-android key on music host
  for (const [vn, key] of [['YTM_ANDROID', KEYS.YTM_ANDROID], ['YTM', KEYS.YTM]] as const) {
    const r = await tryPlayer(`ANDROID_MUSIC/${vn}`, 'https://music.youtube.com', key,
      'com.google.android.apps.youtube.music/8.02.53 (Linux; U; Android 13) gzip',
      { videoId: 'LKYPYj2XX80', contentCheckOk: true, racyCheckOk: true, context: { client: { clientName: 'ANDROID_MUSIC', clientVersion: '8.02.53', androidSdkVersion: 33, osName: 'Android', osVersion: '13', hl: 'en' } } })
    console.log(`${r.ok ? '✓' : '•'} ${r.label}: ${r.note}`)
    if (r.ok) hits.push(r)
  }

  if (hits.length) {
    console.log(`\n=== ${hits.length} HIT(S) — probing stream ===`)
    for (const h of hits.slice(0, 2)) {
      const probe = await fetch(h.url, { headers: { Range: 'bytes=0-32768', 'User-Agent': h.ua } })
      const b = await probe.arrayBuffer()
      console.log(`${h.label}: HTTP ${probe.status} ${probe.headers.get('content-type')} ${b.byteLength}B`)
    }
  } else console.log('\n=== no hits ===')
}
main()
