/** Debug round 2: community bypasses — TVHTML5 embed params, visitorData, ANDROID variants */
const KEYS = {
  IOS: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
  WEB: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
  ANDROID: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
  YTM: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
}
const videoId = 'LKYPYj2XX80'

// The InnerTune "embed bypass" params (shot_metrics / embed_preview)
const EMBED_PARAMS = '8sYwghZ6HFoYdGRXb0NHdEFTaVFIc0FqUUtJblJFQUkuc2hvdF9tZXRyaWNzPUSHgJi5lKi3kZ7VDQ%3D%3D'

async function getVisitorData(): Promise<string | null> {
  try {
    const res = await fetch('https://www.youtube.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' },
    })
    const html = await res.text()
    const m = html.match(/"visitorData":"([^"]+)"/)
    return m ? m[1] : null
  } catch (e) {
    console.log('visitorData fetch failed:', (e as Error).message)
    return null
  }
}

async function tryPlayer(label: string, key: string, body: object, host = 'https://www.youtube.com') {
  try {
    const res = await fetch(`${host}/youtubei/v1/player?key=${key}&prettyPrint=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip', 'X-Goog-Api-Format-Version': '2' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 150)
      console.log(`✗ ${label}: HTTP ${res.status} — ${txt.replace(/\n/g, ' ')}`)
      return null
    }
    const j = await res.json()
    const status = j?.playabilityStatus?.status
    const formats = [...(j?.streamingData?.adaptiveFormats || []), ...(j?.streamingData?.formats || [])]
    const audio = formats.filter((f: any) => (f.mimeType || '').includes('audio')).sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0]
    console.log(`✓ ${label}: status=${status} formats=${formats.length} bestAudio=${audio?.itag}/${(audio?.mimeType || '').split(';')[0]} directUrl=${!!audio?.url}`)
    if (audio?.url) return { j, audio }
    return null
  } catch (e: any) {
    console.log(`✗ ${label}: ${e.message}`)
    return null
  }
}

async function main() {
  const vd = await getVisitorData()
  console.log(`visitorData: ${vd ? vd.slice(0, 40) + '...' : 'NOT FOUND'}\n`)

  // 1. TVHTML5_SIMPLY_EMBEDDED_PLAYER + params (InnerTune embed bypass)
  let hit = await tryPlayer('TVHTML5+embedParams', KEYS.WEB, {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    params: EMBED_PARAMS,
    context: {
      client: {
        clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
        clientVersion: '2.0',
        clientScreen: 'EMBED',
        hl: 'en',
        visitorData: vd || undefined,
      },
      thirdParty: { embedUrl: 'https://www.youtube.com/' },
    },
  })

  // 2. IOS + visitorData
  if (!hit) {
    hit = await tryPlayer('IOS+visitorData', KEYS.IOS, {
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      context: {
        client: {
          clientName: 'IOS', clientVersion: '19.29.1', deviceMake: 'Apple', deviceModel: 'iPhone16,2',
          osName: 'iPhone', osVersion: '17.5.1.21F90', hl: 'en', timeZone: 'UTC', utcOffsetMinutes: 0,
          visitorData: vd || undefined,
        },
      },
    })
  }

  // 3. ANDROID v19.09.37 (pre-integrity)
  if (!hit) {
    hit = await tryPlayer('ANDROID 19.09.37', KEYS.ANDROID, {
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      context: {
        client: {
          clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30,
          osName: 'Android', osVersion: '11', hl: 'en',
          visitorData: vd || undefined,
        },
      },
    })
  }

  // 4. ANDROID_MUSIC
  if (!hit) {
    hit = await tryPlayer('ANDROID_MUSIC 8.02.53', 'AIzaSyC2nHJD2s6GFhc2l6dG9vY0FvZnRzd2Fz', {
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      context: {
        client: {
          clientName: 'ANDROID_MUSIC', clientVersion: '8.02.53', androidSdkVersion: 30,
          osName: 'Android', osVersion: '13', hl: 'en',
          visitorData: vd || undefined,
        },
      },
    })
  }

  if (hit) {
    console.log('\n--- probing stream URL ---')
    const r = await fetch(hit.audio.url, { headers: { Range: 'bytes=0-65535', 'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip' } })
    const b = await r.arrayBuffer()
    console.log(`HTTP ${r.status} ${r.headers.get('content-type')} ${b.byteLength} bytes`)
    if (r.status === 206 || r.status === 200) console.log('\n=== BYPASS FOUND — WE HAVE AUDIO ===')
  } else {
    console.log('\n=== still blocked ===')
  }
}
main()
