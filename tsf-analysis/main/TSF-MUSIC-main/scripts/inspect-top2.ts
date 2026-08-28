const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const res = await fetch(`https://music.youtube.com/youtubei/v1/search?key=${KEY}&prettyPrint=false`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } }, query: 'daft punk' }),
})
const j: any = await res.json()
const sections = j?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []
console.log('section types:', sections.map((s: any) => Object.keys(s)[0]))
for (const s of sections.slice(0, 3)) {
  const key = Object.keys(s)[0]
  console.log(`\n=== ${key} ===`)
  console.log(JSON.stringify(s[key], null, 1).slice(0, 2500))
}
