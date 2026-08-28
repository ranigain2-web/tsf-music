const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const tries: [string, any][] = [
  ['next w/ playlist', { videoId: 'LKYPYj2XX80', playlistId: 'RDAMVM' + 'LKYPYj2XX80', params: 'wAEB', isAudioOnly: true }],
  ['next video only', { videoId: 'LKYPYj2XX80' }],
]
for (const [label, body] of tries) {
  const res = await fetch(`https://music.youtube.com/youtubei/v1/next?key=${KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } }, ...body }),
  })
  console.log(`${label}: HTTP ${res.status}`)
  if (!res.ok) { console.log((await res.text()).slice(0, 150)); continue }
  const j: any = await res.json()
  const panel = j?.contents?.singleColumnMusicWatchNextResultsRenderer?.playlist?.playlistPanelRenderer?.contents
  const tabs = j?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs
  console.log(`  playlistPanel contents: ${panel?.length ?? 0}`)
  if (panel?.length) {
    const r = panel[0]?.playlistPanelVideoRenderer
    console.log(`  first: ${r?.title?.runs?.[0]?.text} | videoId=${r?.videoId}`)
  }
  console.log(`  tabs: ${tabs?.map((t: any) => t.tabRenderer?.title).join(', ')}`)
}
