const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const ctx = { context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } } }
const next = await fetch(`https://music.youtube.com/youtubei/v1/next?key=${KEY}&prettyPrint=false`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  body: JSON.stringify({ ...ctx, videoId: 'LKYPYj2XX80' }),
})
const nj: any = await next.json()
const tabs = nj?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || []
for (const tab of tabs) {
  const tr = tab.tabRenderer
  console.log(`tab: ${tr?.title} — selected=${tr?.selected} — browseId=${tr?.endpoint?.browseEndpoint?.browseId}`)
}
// fetch the lyrics tab
const lyricsTab = tabs.find((t: any) => t.tabRenderer?.title === 'Lyrics')
const lid = lyricsTab?.tabRenderer?.endpoint?.browseEndpoint?.browseId
console.log('\nlyrics browseId:', lid)
if (lid) {
  const lres = await fetch(`https://music.youtube.com/youtubei/v1/browse?key=${KEY}&prettyPrint=false`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ ...ctx, browseId: lid }),
  })
  const lj: any = await lres.json()
  console.log('lyrics response keys:', Object.keys(lj).join(', '))
  const s = JSON.stringify(lj)
  console.log('has runs?', s.includes('"runs"'))
  // find description runs with \n
  const sect = lj?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer
  console.log('musicDescriptionShelfRenderer?', !!sect)
  if (sect) {
    const lines = sect.description?.runs?.map((r: any) => r.text).join('').split('\n')
    console.log('line count:', lines.length)
    console.log(lines.slice(0, 6))
  }
  // check for timed lyrics (bRun / timedLyricsModel)
  console.log('timedLyricsModel?', s.includes('timedLyrics'))
}
