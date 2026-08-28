const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const res = await fetch(`https://music.youtube.com/youtubei/v1/search?key=${KEY}&prettyPrint=false`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } }, query: 'daft punk', params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D' }),
})
const j: any = await res.json()
const sections = j?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []
console.log('sections:', sections.map((s: any) => Object.keys(s)[0]).join(', '))
const songs = sections.find((s: any) => s.musicShelfRenderer)
const item = songs?.musicShelfRenderer?.contents?.[0]
if (item) {
  const r = item.musicResponsiveListItemRenderer
  console.log('\n=== first song item flexColumns ===')
  r.flexColumns.forEach((c: any, i: number) => {
    const fc = c.musicResponsiveListItemFlexColumnRenderer
    console.log(`col${i}:`, JSON.stringify(fc?.text?.runs?.map((x: any) => ({ t: x.text, bep: x.navigationEndpoint?.browseEndpoint?.browseId?.slice(0, 12) }))))
  })
  console.log('\nfixedColumns:', JSON.stringify(r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text))
}
