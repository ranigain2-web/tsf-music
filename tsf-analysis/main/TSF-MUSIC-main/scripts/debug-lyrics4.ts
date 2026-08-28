const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const versions = ['1.20260804.01.00', '1.20260701.01.00', '1.20260101.01.00', '1.20251001.01.00']
for (const ver of versions) {
  const ctx = { context: { client: { clientName: 'WEB_REMIX', clientVersion: ver, hl: 'en', gl: 'US' } } }
  try {
    const next = await fetch(`https://music.youtube.com/youtubei/v1/next?key=${KEY}&prettyPrint=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ ...ctx, videoId: '4NRXx6U8ABQ' }),
    })
    if (!next.ok) { console.log(`${ver}: next HTTP ${next.status}`); continue }
    const nj: any = await next.json()
    const tabs = nj?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || []
    const lid = tabs.find((t: any) => t.tabRenderer?.title === 'Lyrics')?.tabRenderer?.endpoint?.browseEndpoint?.browseId
    if (!lid) { console.log(`${ver}: no lyrics tab`); continue }
    const lres = await fetch(`https://music.youtube.com/youtubei/v1/browse?key=${KEY}&prettyPrint=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ ...ctx, browseId: lid }),
    })
    const lj: any = await lres.json()
    const sect = lj?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer
    if (sect) {
      const lines = sect.description?.runs?.map((r: any) => r.text).join('').split('\n')
      console.log(`✓ ${ver}: ${lines.length} LINES — "${lines[0]?.slice(0, 60)}"`)
    } else {
      console.log(`${ver}: ${lj?.contents?.messageRenderer?.text?.runs?.[0]?.text}`)
    }
  } catch (e: any) { console.log(`${ver}: ${e.message.slice(0, 50)}`) }
}
