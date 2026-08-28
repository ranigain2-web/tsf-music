const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const res = await fetch(`https://music.youtube.com/youtubei/v1/browse?key=${KEY}&prettyPrint=false`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } }, browseId: 'MPREb_K8qWMWVqXGi' }),
})
const j: any = await res.json()
console.log('microformat title:', j.microformat?.microformatDataRenderer?.title)
console.log('contents keys:', Object.keys(j.contents || {}))
const t = j.contents?.twoColumnBrowseResultsRenderer
if (t) {
  console.log('twoColumn tabs:', t.tabs?.length)
  const primary = t.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents
  console.log('primary sections:', primary?.map((s: any) => Object.keys(s)[0]).join(', '))
  if (primary?.[0]?.musicResponsiveHeaderRenderer) {
    const h = primary[0].musicResponsiveHeaderRenderer
    console.log('title:', h.title?.runs?.[0]?.text)
    console.log('subtitle:', h.subtitle?.runs?.map((r: any) => r.text).join(''))
    console.log('thumbnail:', h.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)?.[0]?.url?.slice(0, 80))
  }
  // where are the tracks?
  for (const s of primary || []) {
    if (s.musicShelfRenderer) console.log('shelf:', s.musicShelfRenderer.title?.runs?.[0]?.text, '— items:', s.musicShelfRenderer.contents?.length)
  }
}
