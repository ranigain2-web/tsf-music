const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
// test home feed with explicit accept-language
const res = await fetch(`https://music.youtube.com/youtubei/v1/browse?key=${KEY}&prettyPrint=false`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  body: JSON.stringify({
    context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } },
    browseId: 'FEmusic_home',
  }),
})
const j: any = await res.json()
const s = JSON.stringify(j)
// count CJK chars
const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
console.log(`response size=${s.length}, CJK chars=${cjk}`)
// get shelf titles
const sections = j?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []
const titles: string[] = []
const walkTitles = (n: any) => {
  if (!n || typeof n !== 'object') return
  if (n.musicCarouselShelfRenderer?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text) {
    titles.push(n.musicCarouselShelfRenderer.header.musicCarouselShelfBasicHeaderRenderer.title.runs[0].text)
  }
  for (const v of Object.values(n)) walkTitles(v)
}
walkTitles(j)
console.log('shelf titles:', titles.slice(0, 12).join(' | '))
