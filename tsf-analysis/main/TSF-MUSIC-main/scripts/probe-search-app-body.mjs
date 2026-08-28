#!/usr/bin/env node
/**
 * Dump the raw InnerTube search response using the EXACT request the app makes
 * (no params field) and locate duration data for the first rows.
 */
const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

import { writeFileSync } from 'fs'
const query = process.argv[2] || 'Ed Sheeran Shape of You'

const res = await fetch(`https://music.youtube.com/youtubei/v1/search?key=${KEY}&prettyPrint=false`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'X-Goog-Api-Format-Version': '2',
    Origin: 'https://music.youtube.com',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  body: JSON.stringify({
    context: {
      client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' },
    },
    query,
  }),
})

console.log('HTTP', res.status)
const json = await res.json()
writeFileSync('/tmp/search-raw.json', JSON.stringify(json, null, 2))

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
  if (obj.musicResponsiveListItemRenderer && rows.length < 2) rows.push(obj.musicResponsiveListItemRenderer)
  if (obj.musicCardShelfRenderer && !card) card = obj.musicCardShelfRenderer
}

console.log('\n===== CARD present:', !!card)
if (card) {
  console.log('card keys:', Object.keys(card))
  const inner = card.contents?.[0]?.musicResponsiveListItemRenderer
  if (inner) {
    console.log('card inner row:', JSON.stringify(inner, null, 2).slice(0, 2500))
  } else {
    console.log('card title:', JSON.stringify(card.title))
    console.log('card subtitle:', JSON.stringify(card.subtitle))
    console.log('card contents[0] keys:', card.contents?.[0] ? Object.keys(card.contents[0]) : 'none')
    console.log('card full (4k):', JSON.stringify(card).slice(0, 4000))
  }
}

for (const [i, r] of rows.entries()) {
  console.log(`\n===== ROW ${i} =====`)
  console.log('flexColumns texts:', JSON.stringify((r.flexColumns || []).map((c) =>
    (c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []).map((x) => x.text)
  )))
  console.log('fixedColumns:', JSON.stringify(r.fixedColumns || null))
  console.log('accessibility[1]:', JSON.stringify(r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.accessibility || null))
}
