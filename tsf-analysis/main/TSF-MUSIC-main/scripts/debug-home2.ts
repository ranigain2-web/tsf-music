const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const res = await fetch(`https://music.youtube.com/youtubei/v1/browse?key=${KEY}&prettyPrint=false`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
  body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } }, browseId: 'FEmusic_home' }),
})
const j: any = await res.json()
const sections = j?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []
const s0 = sections[0]?.musicCarouselShelfRenderer
for (const c of s0?.contents?.slice(0, 5) || []) {
  const r = c.musicTwoRowItemRenderer
  const bep = r?.navigationEndpoint?.browseEndpoint?.browseId
  const wep = r?.navigationEndpoint?.watchPlaylistEndpoint?.playlistId
  console.log(`"${r?.title?.runs?.[0]?.text}" — bep=${bep} watchPlaylist=${wep} subtitle=${r?.subtitle?.runs?.map((x: any) => x.text).join('')?.slice(0, 50)}`)
}
