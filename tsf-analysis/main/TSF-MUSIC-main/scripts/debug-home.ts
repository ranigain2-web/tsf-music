const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const res = await fetch(`https://music.youtube.com/youtubei/v1/browse?key=${KEY}&prettyPrint=false`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'en-US,en;q=0.9' },
  body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } }, browseId: 'FEmusic_home' }),
})
const j: any = await res.json()
const sections = j?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []
console.log('total sections:', sections.length)
for (let i = 0; i < Math.min(sections.length, 8); i++) {
  const s = sections[i]
  const key = Object.keys(s)[0]
  const r = s[key]
  const title = r?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text || r?.title?.runs?.[0]?.text || '(no title)'
  const contentKeys = (r?.contents || []).slice(0, 2).map((c: any) => Object.keys(c)[0])
  console.log(`[${i}] ${key} "${title}" — items=${r?.contents?.length} first-item-keys=${contentKeys.join(',')}`)
}
