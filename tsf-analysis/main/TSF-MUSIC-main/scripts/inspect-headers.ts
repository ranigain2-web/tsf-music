const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const res = await fetch(`https://music.youtube.com/youtubei/v1/search?key=${KEY}&prettyPrint=false`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } }, query: 'daft punk' }),
})
const j: any = await res.json()
const sections = j?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []
for (const s of sections) {
  if (s.itemSectionRenderer) {
    const isr = s.itemSectionRenderer
    const title = isr.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text
    const item = isr.contents?.[0]?.musicResponsiveListItemRenderer
    // gather all runs info for first item
    const runs: any[] = []
    item?.flexColumns?.forEach((c: any) => {
      c.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.forEach((r: any) => {
        runs.push({ t: r.text, wep: r.navigationEndpoint?.watchEndpoint?.videoId, bep: r.navigationEndpoint?.browseEndpoint?.browseId?.slice(0, 12) })
      })
    })
    console.log(`section "${title}" — first item runs:`, JSON.stringify(runs).slice(0, 400))
  }
}
