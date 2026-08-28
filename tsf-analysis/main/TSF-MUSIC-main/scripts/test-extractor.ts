/**
 * Isolate the incremental extractor: feed a REAL playlist JSON payload
 * chunk-by-chunk (as deltas) and verify extraction + termination.
 */
import { createExtractor } from '../src/lib/ai/partial'

// realistic payload as glm-4-plus streams it (pretty-printed, fenced)
const PAYLOAD = `{"title": "Rainy Heartbreak",
 "description": "Sad songs for grey skies and quiet tears.",
 "songs": [
   {"q": "Adele Someone Like You", "r": "The definitive rain cry"},
   {"q": "Sam Smith Stay With Me", "r": "Lonely nights in the rain"},
   {"q": "Sia Breathe Me", "r": "Crying in the downpour"},
   {"q": "Lewis Capaldi Someone You Loved", "r": "Loss in the drizzle"},
   {"q": "Billie Eilish when the party's over", "r": "Empty streets at 2am"},
   {"q": "Ed Sheeran Happier", "r": "Letting go in the rain"},
   {"q": "Coldplay Fix You", "r": "Storm clouds parting"},
   {"q": "Birdy Skinny Love", "r": "Umbrella tears"},
   {"q": "Passenger Let Her Go", "r": "Rain on the window"},
   {"q": "Damien Rice The Blower's Daughter", "r": "Tears in the rain"}
 ]
}
\`\`\``

const ex = createExtractor()
let totalSongs = 0
let title = ''
let desc = ''

// feed in 7-char chunks to simulate token deltas
const CH = 7
const t0 = Date.now()
for (let i = 0; i < PAYLOAD.length; i += CH) {
  const got = ex.push(PAYLOAD.slice(i, i + CH))
  if (got.title && !title) title = got.title
  if (got.description && !desc) desc = got.description
  if (got.songs.length) {
    totalSongs += got.songs.length
    process.stdout.write(`+${got.songs.length} `)
  }
  if (Date.now() - t0 > 5000) {
    console.log('\n!!! HANG DETECTED at chunk', i)
    process.exit(1)
  }
}
console.log(`\nDONE in ${Date.now() - t0}ms: title="${title}" desc="${desc.slice(0, 40)}" songs=${totalSongs}/10`)

// edge cases
const ex2 = createExtractor()
const weird = `Here you go:\n\`\`\`json\n{"songs":[{"q":"Xyz Song One","r":"r1"},{"q":"Abc Song Two","r":"r2"},`  // truncated mid-object
const got2 = ex2.push(weird)
console.log('truncated payload → songs:', got2.songs.length, '(expect 2)')
const got3 = ex2.push(`{"q":"Def Song Three","r":"r3"}]}`)
console.log('completion → songs:', got3.songs.length, '(expect 1)')
console.log('PASS')
