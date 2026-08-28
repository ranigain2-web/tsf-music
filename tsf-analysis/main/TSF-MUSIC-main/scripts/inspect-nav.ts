const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const res = await fetch(`https://music.youtube.com/youtubei/v1/search?key=${KEY}&prettyPrint=false`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } }, query: 'daft punk' }),
})
const j: any = await res.json()
const sections = j?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []
let shown = 0
for (const s of sections) {
  const item = s.itemSectionRenderer?.contents?.[0]?.musicResponsiveListItemRenderer
  if (!item) continue
  const runs: string[] = []
  item.flexColumns?.forEach((c: any) => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.forEach((r: any) => runs.push(r.text)))
  const type = runs[1]
  if ((type === 'Album' || type === 'Artist') && shown < 3) {
    shown++
    console.log(`\n=== ${type}: ${runs[0]} ===`)
    console.log('item.navigationEndpoint:', JSON.stringify(item.navigationEndpoint?.browseEndpoint?.browseId || item.navigationEndpoint?.watchEndpoint?.videoId || 'none'))
    console.log('flexCols[0] nav:', JSON.stringify(item.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || 'none'))
    console.log('menu first item:', JSON.stringify(item.menu?.menuRenderer?.items?.[0]?.menuNavigationItemRenderer?.navigationEndpoint?.browseEndpoint?.browseId || 'none'))
    console.log('full keys:', Object.keys(item).join(','))
  }
}
