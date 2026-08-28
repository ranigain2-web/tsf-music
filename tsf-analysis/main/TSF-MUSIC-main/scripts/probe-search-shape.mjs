#!/usr/bin/env node
/**
 * Probe the raw InnerTube (WEB_REMIX) search response shape to find where
 * track durations live. Dumps the first musicResponsiveListItemRenderer's
 * flexColumns + fixedColumns, and the top-result card, as JSON.
 */
const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const query = process.argv[2] || 'Kesariya Arijit Singh'
const params = process.argv[3] || 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D' // songs filter

const body = {
  query,
  params,
  context: {
    clientName: 'WEB_REMIX',
    clientVersion: '1.20240403.01.00',
    hl: 'en',
    gl: 'US',
  },
}

const res = await fetch(`https://music.youtube.com/youtubei/v1/search?key=${KEY}&prettyPrint=false`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'X-Goog-Api-Format-Version': '2',
    Origin: 'https://music.youtube.com',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  body: JSON.stringify({ context: { client: body.context }, query: body.query, params: body.params }),
})

console.log('HTTP', res.status)
const json = await res.json()

// deep-walk to find the first N musicResponsiveListItemRenderer nodes
function* walk(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) yield* walk(item)
    return
  }
  yield node
  for (const value of Object.values(node)) yield* walk(value)
}

const rows = []
let card = null
for (const obj of walk(json)) {
  if (obj.musicResponsiveListItemRenderer && rows.length < 3) {
    rows.push(obj.musicResponsiveListItemRenderer)
  }
  if (obj.musicCardShelfRenderer && !card) {
    card = obj.musicCardShelfRenderer
  }
}

console.log('\n===== TOP-RESULT CARD (musicCardShelfRenderer) =====')
console.log(JSON.stringify(card, null, 2)?.slice(0, 3000))

for (const [i, r] of rows.entries()) {
  console.log(`\n===== ROW ${i} (musicResponsiveListItemRenderer) =====`)
  const slim = {
    flexColumns: r.flexColumns,
    fixedColumns: r.fixedColumns,
    badges: r.badges,
    hasThumbnail: !!r.thumbnail,
  }
  console.log(JSON.stringify(slim, null, 2))
}

if (!rows.length) {
  console.log('\nNO musicResponsiveListItemRenderer FOUND — dumping top-level keys and 4000 chars:')
  console.log(Object.keys(json))
  console.log(JSON.stringify(json).slice(0, 4000))
}
