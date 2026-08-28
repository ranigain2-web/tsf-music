// Run the app's own parseSearch on the cached videos-filtered response
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// transpile parse.ts quickly via esbuild? Simpler: replicate the extraction inline.
const j = JSON.parse(readFileSync('/tmp/app_cached_videos_soy.json', 'utf8'))
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

let count = 0
for (const sec of contents) {
  const shelf = sec.musicShelfRenderer
  if (!shelf) continue
  for (const item of shelf.contents || []) {
    const r = item.musicResponsiveListItemRenderer
    if (!r) continue
    count++
    const vid = extractVideoId(r)
    const runs = collectRuns(r).map(x => x.text).filter(Boolean)
    const durRun = runs.find(t => /^\d+(?::\d+)+$/.test(t))
    console.log(`${vid || 'NO-VID'}  dur=${durRun || 'NONE'}  ${runs[0]?.slice(0, 40)}`)
  }
}
console.log('total video rows:', count)
