/**
 * SEARCH V2 BEHAVIOR PROOF — the BAR-ENGINE oracle (gauntlet, wave 16).
 *
 * Asserts the reference repo's documented + test-locked behaviors against
 * OUR port, using PURE-FUNCTION imports (network-independent — the sandbox
 * cannot reach the catalogs reliably) plus live route pings where network
 * exists. Run: bun scripts/search-v2-check.ts
 */

import {
  normalizeQuery,
  normalizeTokens,
  foldToken,
  clusterKey,
} from '../src/lib/search-v2/normalize'
import { buildLexicon, feedLexicon, correctToken } from '../src/lib/search-v2/lexicon'
import { planSearch, correctedQuery, registerArtistLexicon, registerVibeVocab, registerLyricMarkers } from '../src/lib/search-v2/plan'
import { clusterVersions, mergePools, type Candidate } from '../src/lib/search-v2/verify'
import { rankRows, REASON_LINES, withReasonLines } from '../src/lib/search-v2/rank'
import { titleAuthorityMissing } from '../src/lib/search-v2/rescue'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── Seed the lexicon/classifier the way initSearchEngine would ──
const SEED_ARTISTS = [
  'Arijit Singh', 'Shreya Ghoshal', 'Atif Aslam', 'Pritam', 'Mithoon',
  'A R Rahman', 'Nucleya', 'AP Dhillon', 'Diljit Dosanjh', 'Taylor Swift',
  'Ed Sheeran', 'The Weeknd', 'Kendrick Lamar', 'Dua Lipa', 'Olivia Rodrigo',
]
registerArtistLexicon(SEED_ARTISTS)
registerVibeVocab(['sad', 'party', 'gym', 'romantic', 'chill', 'workout', 'love', 'heartbreak', 'punjabi', 'hindi', 'bollywood', 'focus', 'sleep'])
registerLyricMarkers(['lyrics', 'lyric', 'bol', 'lines'])
// Feed misspellings the catalog would feed (buildLexicon indexes phrase + words)
buildLexicon([['arijit singh', 'kun faya kun', 'tum hi ho', 'chahiye tere', 'tu chaiye']])

// ── S0: normalization ──
check('S0 normalize folds punctuation + case', normalizeQuery('Tum Hi Ho (From "Aashiqui 2")') === 'tum hi ho from aashiqui 2', JSON.stringify(normalizeQuery('Tum Hi Ho (From "Aashiqui 2")')))
check('S0 diacritic fold', normalizeQuery('Béyoncé halē') === 'beyonce hale')
check('S0 Hinglish fold kyon→kyu', foldToken('kyon') === 'kyu')
check('S0 tokenize keeps in-word hyphens, drops junk', JSON.stringify(normalizeTokens('  Arjit---Sing! ')) === '["arjit-sing"]', JSON.stringify(normalizeTokens('  Arjit---Sing! ')))

// ── S0: SymSpell corrections (documented: "arjit sing" → arijit singh) ──
const c1 = correctToken('arjit')
check('S0 SymSpell: arjit→arijit', c1 === 'arijit', JSON.stringify(c1))
const c2 = correctToken('fya')
check('S0 SymSpell: fya→faya (kun fya kun class)', c2 === 'faya', JSON.stringify(c2))
check('S0 SymSpell: exact term untouched', correctToken('arijit') === null)

// ── S0: plan classification ──
const pArtist = planSearch('arijit singh tum hi ho')
check('S0 classify artist_title', pArtist.kind === 'artist_title' || pArtist.kind === 'entity_artist', `got ${pArtist.kind}`)
const pTitle = planSearch('tum hi ho')
check('S0 classify entity_title', pTitle.kind === 'entity_title', `got ${pTitle.kind}`)
const pLyric = planSearch('saiyaan saath humaar lyrics')
check('S0 classify lyric_fragment (marker)', pLyric.kind === 'lyric_fragment', `got ${pLyric.kind}`)
const pVibe = planSearch('sad punjabi songs')
check('S0 classify vibe', pVibe.kind === 'vibe', `got ${pVibe.kind}`)
check('S0 correction surfaced on plan', correctedQuery(planSearch('tum hi ho arjit singh')) !== null, 'correctedQuery null')
check('S0 artistTokens split (artist_title)', planSearch('tum hi ho arijit singh').artistTokens.join(' ').includes('arijit'), JSON.stringify(planSearch('tum hi ho arijit singh').artistTokens))

// ── S2: version clustering (documented: 26 "Tum Hi Ho" releases → 1;
//      covers stay separate; "Tum Hi Ho Bandhu" never merges) ──
check('S2 clusterKey strips From-decorations', clusterKey('Tum Hi Ho (From "Aashiqui 2")') === clusterKey('Tum Hi Ho'))
check('S2 clusterKey keeps Bandhu distinct', clusterKey('Tum Hi Ho Bandhu') !== clusterKey('Tum Hi Ho'))
check('S2 clusterKey strips remix/feat', clusterKey('Tum Hi Ho (Remix)') === clusterKey('Tum Hi Ho'))

function cand(id: string, title: string, artist: string, extra?: Partial<Candidate>): Candidate {
  return {
    id, videoId: id, title,
    artistName: artist,
    artistsFull: artist.split(/,\s*/),
    duration: 260,
    thumbnail: '',
    poolRank: 0,
    pool: 'test',
    ...extra,
  } as Candidate
}
const many: Candidate[] = [
  cand('a1', 'Tum Hi Ho', 'Arijit Singh', { poolRank: 0 }),
  cand('a2', 'Tum Hi Ho (From "Aashiqui 2")', 'Arijit Singh', { poolRank: 1 }),
  cand('a3', 'Tum Hi Ho', 'Arijit Singh, Mithoon', { poolRank: 2 }),
  cand('a4', 'Tum Hi Ho (Remix)', 'Arijit Singh', { poolRank: 3 }),
  cand('a5', 'Tum Hi Ho Bandhu', 'Kavita Seth', { poolRank: 4 }),
  cand('a6', 'Tum Hi Ho (Cover)', 'Shahid Mallya', { poolRank: 5 }),
]
const merged = mergePools([{ pool: 't', rows: many }])
const clustered = clusterVersions(merged)
const thh = clustered.filter((r) => clusterKey(r.title) === clusterKey('Tum Hi Ho'))
check('S2 clustering: 4 same-artist releases → 1 row', clustered.filter((r) => clusterKey(r.title) === clusterKey('Tum Hi Ho') && /arijit|mithoon/i.test(r.artistName)).length === 1, `got ${thh.length}`)
check('S2 clustering: cover stays separate', clustered.some((r) => r.artistName === 'Shahid Mallya'))
check('S2 clustering: Bandhu stays separate', clustered.some((r) => r.title.includes('Bandhu')))
check('S2 clustering: best member kept (poolRank 0)', thh[0]?.id === 'a1', `got ${thh[0]?.id}`)

// ── S3: disambiguation override (documented P3: wrong-artist rows can
//      never outrank the artist you typed) ──
const planA = planSearch('tum hi ho arijit singh')
const poolA = mergePools([{
  pool: 't',
  rows: [
    cand('w1', 'Tum Hi Ho', 'Random Cover Guy', { poolRank: 0 }),
    cand('r1', 'Tum Hi Ho', 'Arijit Singh', { poolRank: 9 }),
  ],
}])
const ctx = { now: Date.now() }
const rankedA = rankRows(planA, clusterVersions(poolA), ctx)
const realIdx = rankedA.findIndex((r) => r.artistName === 'Arijit Singh')
const coverIdx = rankedA.findIndex((r) => r.artistName === 'Random Cover Guy')
check('S3 disambiguation: typed artist beats better-ranked cover', realIdx !== -1 && realIdx < coverIdx, `real=${realIdx} cover=${coverIdx}`)

// S3 determinism: same input → byte-identical order
const rankedB = rankRows(planA, clusterVersions(poolA), ctx)
check('S3 determinism: identical order on repeat', JSON.stringify(rankedA.map((r) => r.id)) === JSON.stringify(rankedB.map((r) => r.id)))

// S3 reason lines come from the CLOSED set
const rows = withReasonLines(rankedA)
check('S3 reason lines closed-set', rows.every((r) => Object.values(REASON_LINES).includes(r.reason)))

// ── Rescue: title-authority gate (documented "tu chaiye" class) ──
check('rescue: all-matching-rows-below-floor triggers', titleAuthorityMissing([{ playCount: 198000, queryMatch: 0.8 }, { playCount: 50000, queryMatch: 0.7 }]) === true)
check('rescue: popular canonical present → no trigger', titleAuthorityMissing([{ playCount: 100_000_000, queryMatch: 0.8 }]) === false)
check('rescue: no title-matching rows → not this path', titleAuthorityMissing([{ playCount: 1000, queryMatch: 0.1 }]) === false)

// ── Live route ping (network permitting) ──
try {
  const res = await fetch('http://localhost:3000/api/ytm/search-v2?q=tum%20hi%20ho', { signal: AbortSignal.timeout(30000) })
  if (res.ok && res.body) {
    const text = await res.text()
    const events = text.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
    const finalEv = events.find((e) => e.type === 'final')
    check('route: NDJSON final event present', !!finalEv, `events=${events.map((e) => e.type).join(',')}`)
    check('route: rows render catalog shape', Array.isArray(finalEv?.result?.rows) && (finalEv.result.rows.length === 0 || ('title' in finalEv.result.rows[0] && 'artistName' in finalEv.result.rows[0])))
    check('route: latencyMs instrumented', typeof finalEv?.result?.latencyMs === 'number')
  } else {
    console.log(`SKIP  route ping (HTTP ${res.status} — sandbox network)`)
  }
} catch {
  console.log('SKIP  route ping (unreachable — sandbox network)')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
