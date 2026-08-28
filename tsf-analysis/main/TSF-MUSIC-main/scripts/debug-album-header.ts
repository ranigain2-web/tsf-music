const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const res = await fetch(`https://music.youtube.com/youtubei/v1/browse?key=${KEY}&prettyPrint=false`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } }, browseId: 'MPREb_K8qWMWVqXGi' }),
})
const j: any = await res.json()
console.log('top keys:', Object.keys(j).join(', '))
console.log('header keys:', j.header ? Object.keys(j.header).join(', ') : 'MISSING')
if (j.header?.musicResponsiveHeaderRenderer) {
  const h = j.header.musicResponsiveHeaderRenderer
  console.log('title:', h.title?.runs?.[0]?.text)
  console.log('subtitle:', h.subtitle?.runs?.map((r: any) => r.text).join(''))
  console.log('thumbnail present:', !!h.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.length)
}
if (j.header?.musicImmersiveHeaderRenderer) {
  const h = j.header.musicImmersiveHeaderRenderer
  console.log('immersive title:', h.title?.runs?.[0]?.text)
  console.log('immersive description:', h.description?.runs?.map((r: any) => r.text).join('')?.slice(0, 80))
}
// find where tracklist items live
const shelves = j?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []
console.log('sections:', shelves.map((s: any) => Object.keys(s)[0]).join(', '))
