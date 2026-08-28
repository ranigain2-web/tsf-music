import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('/tmp/app_cached_unfilt_soy.json', 'utf8'))
const contents = j?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []
function collectRuns(r) {
  const out = []
  for (const fc of r.flexColumns || []) {
    for (const run of fc.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []) out.push(run)
  }
  return out
}
function extractVideoId(r) {
  for (const run of collectRuns(r)) {
    if (run.navigationEndpoint?.watchEndpoint?.videoId) return run.navigationEndpoint.watchEndpoint.videoId
  }
  if (r.playlistItemData?.videoId) return r.playlistItemData.videoId
  const overlay = r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
  if (overlay?.playNavigationEndpoint?.watchEndpoint?.videoId) return overlay.playNavigationEndpoint.watchEndpoint.videoId
  if (r.navigationEndpoint?.watchEndpoint?.videoId) return r.navigationEndpoint.watchEndpoint.videoId
  return undefined
}
for (const sec of contents) {
  // both shelf and itemSection forms
  const sections = []
  if (sec.musicShelfRenderer) sections.push(...(sec.musicShelfRenderer.contents || []))
  if (sec.itemSectionRenderer) for (const c of sec.itemSectionRenderer.contents || []) sections.push(c)
  for (const item of sections) {
    const r = item.musicResponsiveListItemRenderer
    if (!r) continue
    const vid = extractVideoId(r)
    const runs = collectRuns(r).map(x => x.text).filter(Boolean)
    const durRun = runs.find(t => /^\d+(?::\d+)+$/.test(t))
    const type = runs[1] || ''
    if (!vid) continue // not a track row
    console.log(`${vid}  type=${type.padEnd(8)} dur=${durRun || 'NONE'}  ${runs[0]?.slice(0, 42)}`)
  }
}
