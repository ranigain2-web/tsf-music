/** Debug: find the working iOS player request shape */
const KEYS = {
  IOS: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
  WEB: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
  YTM: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
}

const videoId = 'LKYPYj2XX80' // Around the World — official

async function tryPlayer(label: string, host: string, key: string, client: object, extra: object = {}) {
  try {
    const res = await fetch(`${host}/youtubei/v1/player?key=${key}&prettyPrint=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
        'X-Goog-Api-Format-Version': '2',
      },
      body: JSON.stringify({ videoId, contentCheckOk: true, racyCheckOk: true, context: { client }, ...extra }),
    })
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 200)
      console.log(`✗ ${label}: HTTP ${res.status} — ${txt}`)
      return null
    }
    const j = await res.json()
    const status = j?.playabilityStatus?.status
    const formats = j?.streamingData?.adaptiveFormats || []
    const audio = formats
      .filter((f: any) => (f.mimeType || '').includes('audio/mp4'))
      .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0]
    const hasUrl = !!audio?.url
    const reason = j?.playabilityStatus?.reason || ''
    console.log(
      `✓ ${label}: status=${status} formats=${formats.length} audioItag=${audio?.itag} url=${hasUrl} ${reason ? 'reason=' + reason : ''}`
    )
    return audio?.url ? j : null
  } catch (e: any) {
    console.log(`✗ ${label}: ${e.message}`)
    return null
  }
}

async function main() {
  const iOS = {
    clientName: 'IOS',
    clientVersion: '19.29.1',
    deviceMake: 'Apple',
    deviceModel: 'iPhone16,2',
    osName: 'iPhone',
    osVersion: '17.5.1.21F90',
    hl: 'en',
    timeZone: 'UTC',
    utcOffsetMinutes: 0,
  }

  // 1. www.youtube.com + IOS key (the classic InnerTune combo)
  let ok = await tryPlayer('www+IOSkey v19.29.1', 'https://www.youtube.com', KEYS.IOS, iOS)

  // 2. newer client version
  if (!ok) {
    ok = await tryPlayer('www+IOSkey v20.10.4', 'https://www.youtube.com', KEYS.IOS, {
      ...iOS,
      clientVersion: '20.10.4',
      osVersion: '18.3.2.22D82',
    })
  }

  // 3. music host + IOS key (what failed before)
  if (!ok) await tryPlayer('music+IOSkey', 'https://music.youtube.com', KEYS.IOS, iOS)

  // 4. TVHTML5 (known to sometimes bypass)
  if (!ok) {
    ok = await tryPlayer('www+TV key TVHTML5', 'https://www.youtube.com', KEYS.WEB, {
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      clientVersion: '2.0',
      hl: 'en',
    })
  }

  // 5. MWEB
  if (!ok) {
    ok = await tryPlayer('www+WEB key MWEB', 'https://www.youtube.com', KEYS.WEB, {
      clientName: 'MWEB',
      clientVersion: '2.20240726.17.00',
      hl: 'en',
    })
  }

  if (ok) {
    const url = ok.streamingData.adaptiveFormats.filter((f: any) => f.mimeType?.includes('audio/mp4')).sort((a: any, b: any) => b.bitrate - a.bitrate)[0].url
    console.log('\nProbing audio URL...')
    const r = await fetch(url, { headers: { Range: 'bytes=0-65535', 'User-Agent': 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)' } })
    const b = await r.arrayBuffer()
    console.log(`Audio fetch: HTTP ${r.status} ${r.headers.get('content-type')} ${b.byteLength} bytes`)
  } else {
    console.log('\n!!! No working player config found')
  }
}

main()
