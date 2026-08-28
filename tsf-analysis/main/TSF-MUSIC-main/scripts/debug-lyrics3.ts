const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const ctx = { context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } } }
for (const [label, videoId] of [['Blinding Lights', '4NRXx6U8ABQ'], ['Someone Like You', 'hLQl3WQQoQ0']] as const) {
  const next = await fetch(`https://music.youtube.com/youtubei/v1/next?key=${KEY}&prettyPrint=false`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ ...ctx, videoId }),
  })
  const nj: any = await next.json()
  const tabs = nj?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || []
  const lid = tabs.find((t: any) => t.tabRenderer?.title === 'Lyrics')?.tabRenderer?.endpoint?.browseEndpoint?.browseId
  if (!lid) { console.log(`${label}: no lyrics tab`); continue }
  const lres = await fetch(`https://music.youtube.com/youtubei/v1/browse?key=${KEY}&prettyPrint=false`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ ...ctx, browseId: lid }),
  })
  const lj: any = await lres.json()
  const sect = lj?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer
  if (sect) {
    const lines = sect.description?.runs?.map((r: any) => r.text).join('').split('\n')
    console.log(`${label}: ${lines.length} lines — first 4:`)
    lines.slice(0, 4).forEach((l: string) => console.log('   ', l))
  } else {
    console.log(`${label}: message =`, lj?.contents?.messageRenderer?.text?.runs?.[0]?.text)
  }
}
