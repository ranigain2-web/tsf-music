const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const res = await fetch(`https://music.youtube.com/youtubei/v1/search?key=${KEY}&prettyPrint=false`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } }, query: 'daft punk' }),
})
const j: any = await res.json()
const sections = j?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []
for (const s of sections) {
  if (s.musicCardShelfRenderer) {
    const card = s.musicCardShelfRenderer
    const item = card.content?.musicResponsiveListItemRenderer
    console.log('=== TOP RESULT card ===')
    if (item) {
      item.flexColumns?.forEach((c: any, i: number) => {
        console.log(`col${i}:`, JSON.stringify(c.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map((x: any) => ({ t: x.text?.slice(0, 30), bep: x.navigationEndpoint?.browseEndpoint?.browseId?.slice(0, 10) }))))
      })
      console.log('overlay videoId:', item.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId)
      console.log('playlistItemData:', JSON.stringify(item.playlistItemData))
    }
    console.log('header:', JSON.stringify(card.header?.musicCardShelfHeaderBasicRenderer?.title?.runs?.[0]?.text))
  }
  if (s.musicShelfRenderer) {
    console.log('shelf:', s.musicShelfRenderer.title?.runs?.[0]?.text, '— items:', s.musicShelfRenderer.contents?.length)
  }
}
