const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const res = await fetch(`https://music.youtube.com/youtubei/v1/next?key=${KEY}&prettyPrint=false`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } }, videoId: 'LKYPYj2XX80', playlistId: 'RDAMVM' + 'LKYPYj2XX80', params: 'wAEB', isAudioOnly: true }),
})
const j: any = await res.json()

// find ALL playlistPanelVideoRenderer instances anywhere
const hits: any[] = []
const walk = (n: any, path: string) => {
  if (!n || typeof n !== 'object') return
  if (Array.isArray(n)) { n.forEach((x, i) => walk(x, `${path}[${i}]`)); return }
  if (n.playlistPanelVideoRenderer) hits.push({ path, r: n.playlistPanelVideoRenderer })
  for (const [k, v] of Object.entries(n)) walk(v, `${path}.${k}`)
}
walk(j, '$')
console.log(`playlistPanelVideoRenderer count: ${hits.length}`)
if (hits.length) {
  const r = hits[0].r
  console.log('first path:', hits[0].path)
  console.log('first title:', r.title?.runs?.[0]?.text, '| videoId:', r.videoId)
  // also dump the parent of the array containing them
  const parentPath = hits[0].path.replace(/\[\d+\]$/, '')
  console.log('array path:', parentPath)
}

// dump top structure
const sc = j?.contents?.singleColumnMusicWatchNextResultsRenderer
console.log('\nsingleColumnMusicWatchNextResultsRenderer keys:', sc ? Object.keys(sc).join(', ') : 'MISSING')
if (sc?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs) {
  for (const tab of sc.tabbedRenderer.watchNextTabbedResultsRenderer.tabs) {
    const tr = tab.tabRenderer
    if (tr?.title === 'Up next') {
      console.log('\nUp next tab content keys:', Object.keys(tr.content || {}))
      const ttr = tr.content?.musicQueueRenderer?.content?.playlistPanelRenderer
      console.log('musicQueue→playlistPanel contents:', ttr?.contents?.length)
      if (ttr?.contents?.length) {
        const r = ttr.contents[0]?.playlistPanelVideoRenderer
        console.log('first:', r?.title?.runs?.[0]?.text, '| videoId:', r?.videoId)
      }
    }
  }
}
