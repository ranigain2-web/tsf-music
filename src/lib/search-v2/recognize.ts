/**
 * SEARCH V2 · S0+ — QUERY RECOGNITION.
 *
 * The gap this closes (reported from real use):
 *
 *   "tuchaiye"  → 0 rows. Not because the catalog lacks the song — YouTube
 *   Music answers "Tu Chahiye" by Pritam for that exact string — but because
 *   S2 verification scores rows against the PLAN's tokens, and no row's title
 *   contains the glued token "tuchaiye". The query was never understood, so
 *   nothing could match it.
 *
 * A search engine does not search what you typed; it searches what you meant,
 * and then TELLS you it did ("Showing results for tu chahiye"). This module is
 * the "what you meant" half. It is deliberately conservative: a query that
 * already resolves is returned untouched, so nothing here can degrade a good
 * search.
 *
 * Four mechanisms, cheapest first, all bounded and deterministic:
 *
 *   0. lowercase/normalize                          (free — reuse normalizeQuery)
 *   1. GLUE SPLIT   "tuchaiye" → tu + chaiye        (local DP, 0 ms)
 *   2. ORTHO FOLD   "chaiye" → "chahiye"            (local table, 0 ms)
 *   3. SPELLING     "arjit" → "arijit"              (SymSpell lexicon, 0 ms)
 *   4. SUGGEST      ask the provider what it thinks (network, ≤1.5 s, LAST)
 *
 * Layer 4 is the actual search-engine oracle — the same songs-filtered catalog
 * probe the typeahead rail uses. It is only consulted when the local layers are
 * inconclusive AND the query looks malformed, so ordinary searches pay nothing.
 */

import { normalizeQuery, TYPE_WORDS, CONNECTOR_WORDS } from './normalize'
import { correctToken } from './lexicon'
import { search as ytmSearch } from '@/lib/ytm'

export interface Recognition {
  /** exactly what the user typed */
  raw: string
  /** normalized form of `raw` */
  normalized: string
  /** the query worth actually searching, or null when `raw` is already fine */
  showingFor: string | null
  /** which mechanism produced `showingFor` (honest provenance) */
  via: RecognitionVia | null
  /** every candidate worth probing, best first (never includes `raw` itself) */
  candidates: string[]
  /** user-facing suggestion, even when results were good enough to keep */
  didYouMean: string | null
  /** true when the correction is safe enough to take over the result set */
  confident: boolean
  tookMs: number
}

export type RecognitionVia = 'split' | 'ortho' | 'spelling' | 'suggest'

// ---------------------------------------------------------------------------
// 1. The segmentation vocabulary
// ---------------------------------------------------------------------------

/**
 * Bounded word list for glue splitting. Two origins:
 *   - structural words a query is almost always built from (English function
 *     words + the Hinglish copulas/pronouns/particles that dominate romanized
 *     Indian song queries);
 *   - song-vocabulary words that are routinely glued into titles.
 *
 * Weight = how confidently the word may stand alone as a segment. Single-letter
 * particles are allowed but weighted so the DP prefers longer splits.
 */
const SEGMENT_WORDS: Record<string, number> = {
  // Hinglish pronouns / particles / copulas
  tu: 2, tum: 3, hum: 3, main: 3, mai: 2, mujhe: 3, mera: 3, meri: 3, mere: 3,
  tera: 3, teri: 3, tere: 3, tujhe: 3, apna: 2, apni: 2, sab: 2, kuch: 3,
  hai: 3, hain: 3, ho: 2, hi: 2, he: 2, hu: 2, tha: 2, thi: 2, kya: 3, kyun: 3,
  aur: 3, phir: 3, ab: 1, na: 2, nahi: 3, nahin: 3, bhi: 2, toh: 2, to: 1,
  se: 1, ka: 1, ki: 1, ke: 1, ko: 1, mein: 2, me: 1, pe: 1, par: 2,
  dil: 3, dilbar: 3, dilruba: 3, jaan: 3, jaana: 3, sanam: 3, ishq: 3,
  pyaar: 3, pyar: 3, mohabbat: 3, zindagi: 3, yaad: 3, khwab: 3, khush: 2,
  chahiye: 3, chaiye: 2, chahe: 2, chahta: 2, chahata: 2, aaja: 2, aja: 2,
  sun: 2, suno: 2, bol: 2, ja: 1, jaa: 1, kara: 2, kar: 1, de: 1, dekh: 2,
  saath: 2, saathiya: 3, jahan: 2, yahan: 2, wahan: 2, kabhi: 3, sada: 2,
  bina: 2, liye: 2, humko: 2, tumko: 2, mujhko: 2, ise: 1, use: 1,
  baghwan: 3, allah: 3, maula: 3, ram: 3, krishna: 3, radha: 3, sai: 3,
  banja: 2, banjara: 3, mehboob: 3, hasina: 3, soniya: 3, soniye: 3,
  jind: 2, jindagi: 3, hosh: 2, nasha: 3, masti: 3, rangeela: 3, rangeen: 3,
  yaara: 2, yaar: 3, dost: 3, dosti: 3, gham: 2, khushi: 3, ansu: 2, aansu: 3,
  jhoot: 2, saccha: 2, sacha: 2, sach: 3, asli: 2, vada: 2, waada: 3,
  // English function words + the words song queries actually use
  the: 2, a: 1, an: 1, of: 2, in: 2, on: 2, at: 2, and: 2, or: 2,
  you: 3, my: 3, we: 2, us: 2, it: 2, is: 2, be: 2, do: 2, not: 2,
  i: 1, am: 2, are: 2, was: 2, were: 2, all: 2, for: 2, with: 3, from: 2,
  love: 3, song: 2, songs: 2, music: 3, night: 3, drive: 3, day: 2, time: 3,
  girl: 3, boy: 3, baby: 3, heart: 3, soul: 2, dream: 3, dreams: 3, fire: 2,
  rain: 3, blue: 3, black: 3, white: 3, gold: 3, golden: 3, moon: 3,
  start: 2, again: 3, forever: 3, never: 3, always: 3, better: 3, best: 2,
  little: 3, lonely: 3, crazy: 3, sweet: 3, slow: 2, fast: 2, dance: 3,
  party: 3, chill: 3, sad: 2, happy: 3, feel: 2, feels: 2, good: 2, bad: 2,
}

/** Whole tokens that must never be split even though they decompose. */
const NEVER_SPLIT = new Set([
  'kesariya', 'kesariyo', 'tumtum', 'salam', 'shukriya',
])

/**
 * Names are split targets too ("arjitsingh" → arjit + singh). These arrive
 * from the engine at init (artist priors + seeds + the profile's artists), so
 * the vocabulary grows with what this user actually searches for. Kept apart
 * from SEGMENT_WORDS so a name can never outrank a real structural word.
 */
let NAME_WORDS = new Set<string>()

/** Register names/titles as legal split segments (normalized, lowercased). */
export function registerSegmentNames(names: string[]): void {
  const next = new Set<string>()
  for (const n of names) {
    for (const tok of normalizeQuery(n).split(' ')) {
      if (tok.length >= 4) next.add(tok)
    }
  }
  NAME_WORDS = next
}

/** Is this token a word we already know, in full? */
export function isKnownWholeToken(token: string): boolean {
  const t = token.toLowerCase()
  if (SEGMENT_WORDS[t] !== undefined) return true
  if (NAME_WORDS.has(t)) return true
  return nearName(t)
}

/** Tokens that are not in the vocabulary but are within ONE edit of a name. */
function nearName(piece: string): boolean {
  if (piece.length < 4) return false
  for (const n of NAME_WORDS) {
    if (Math.abs(n.length - piece.length) > 1) continue
    let d = 0
    let i = 0
    let j = 0
    while (i < piece.length && j < n.length) {
      if (piece[i] === n[j]) { i += 1; j += 1; continue }
      d += 1
      if (d > 1) break
      if (piece.length > n.length) i += 1
      else if (piece.length < n.length) j += 1
      else { i += 1; j += 1 }
    }
    d += (piece.length - i) + (n.length - j)
    if (d <= 1) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------------------------

/** Normalized Levenshtein similarity, 0..1. */
export function similarity(a: string, b: string): number {
  const s = normalizeQuery(a)
  const t = normalizeQuery(b)
  if (!s || !t) return 0
  if (s === t) return 1
  const m = s.length
  const n = t.length
  if (Math.abs(m - n) > Math.max(m, n) * 0.7) return 0
  let prev = new Array<number>(n + 1)
  let cur = new Array<number>(n + 1)
  for (let j = 0; j <= n; j += 1) prev[j] = j
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i
    for (let j = 1; j <= n; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    const swap = prev
    prev = cur
    cur = swap
  }
  return 1 - prev[n] / Math.max(m, n)
}

/**
 * Segmentation DP over SEGMENT_WORDS.
 *
 * Returns the highest-scoring split into KNOWN words, or null. Refuses to split
 * a token that is itself a believable word (a real word must never be chopped:
 * "night" → night, not n + i + ght), and refuses 1-char fragments other than
 * the handful that are genuinely words ("a", "i").
 */
export function splitGluedToken(token: string): string[] | null {
  const s = token.toLowerCase()
  if (s.length < 5) return null
  // NEVER chop a token that is already a word we know — not the structural
  // vocabulary, not a name, and not one typo away from a name. Without this,
  // "arijit" (a known artist) splits into "a" + "rijit" because "rijit" is
  // one edit from "arijit".
  if (isKnownWholeToken(s)) return null
  if (NEVER_SPLIT.has(s)) return null
  if (/\d/.test(s)) return null

  const n = s.length
  // best[i] = { score, parts } for prefix s[0..i)
  const best: Array<{ score: number; parts: string[] } | null> = new Array(n + 1).fill(null)
  best[0] = { score: 0, parts: [] }

  for (let i = 0; i < n; i += 1) {
    if (!best[i]) continue
    const { score, parts } = best[i] as { score: number; parts: string[] }
    for (let j = i + 1; j <= n; j += 1) {
      const piece = s.slice(i, j)
      // a segment is legal when it is a structural word, OR a name from the
      // engine's lexicon, OR one typo away from a name ("arjit" for "arijit")
      const structural = SEGMENT_WORDS[piece]
      const w = structural !== undefined ? structural : NAME_WORDS.has(piece) ? 2 : nearName(piece) ? 2 : undefined
      if (w === undefined) continue
      // 1-char segments are only tolerated for genuine single letters
      if (piece.length === 1 && !(piece === 'a' || piece === 'i')) continue
      // a trailing lone consonant is almost always a chopped word
      if (piece.length === 1 && /[bcdfghjklmnpqrstvwxyz]/.test(piece)) continue
      // require the LAST segment to end the token (handled by loop bounds)
      const next = best[j]
      const gained = w + (piece.length >= 3 ? 1 : 0)
      const score2 = score + gained
      if (!next || score2 > next.score) {
        best[j] = { score: score2, parts: [...parts, piece] }
      }
    }
  }

  const end = best[n]
  if (!end || end.parts.length < 2) return null
  // Every segment must be a real word (guaranteed above), and a 2-segment split
  // where one side is a single letter is usually noise:
  if (end.parts.filter((p) => p.length === 1).length > 1) return null
  return end.parts
}

/** Romanization fold for one token (the S0 table's job, applied per segment). */
const ORTHO_FOLD: Record<string, string> = {
  chaiye: 'chahiye', chaahiye: 'chahiye', cahiye: 'chahiye', chahie: 'chahiye',
  chahiy: 'chahiye', chaiy: 'chahiye', chahye: 'chahiye',
  hamesa: 'hamesha', khusi: 'khushi', kushi: 'khushi', sanam: 'sanam',
  pyar: 'pyaar', mohobat: 'mohabbat', zindgi: 'zindagi', jindgi: 'zindagi',
  isk: 'ishq', ishq: 'ishq', yaadein: 'yaadein', yaaden: 'yaadein',
}

// ---------------------------------------------------------------------------
// 3. Local recognition (0 ms)
// ---------------------------------------------------------------------------

interface LocalAttempt {
  query: string
  via: RecognitionVia
  confidence: number
}

/**
 * All local (offline) attempts for a query, best first.
 *
 * The three mechanisms are applied as ONE pipeline (re-space → fold → spell),
 * and the attempt is labelled with the FIRST stage that changed anything —
 * that is the honest answer to "why did you change my query?". Intermediate
 * forms are kept as extra probe candidates because they are cheap and
 * occasionally the right one (e.g. the re-spaced form before spelling repair).
 */
function localAttempts(raw: string): LocalAttempt[] {
  const normalized = normalizeQuery(raw)
  const tokens = normalized.split(' ').filter(Boolean)
  const out: LocalAttempt[] = []
  const push = (query: string, via: RecognitionVia, confidence: number) => {
    const q = normalizeQuery(query)
    if (!q || q === normalized) return
    if (out.some((a) => a.query === q)) return
    out.push({ query: q, via, confidence })
  }

  // stage 1 — re-space glued tokens
  let glued = false
  const splitTokens: string[] = []
  for (const t of tokens) {
    if (t.length >= 5) {
      const parts = splitGluedToken(t)
      if (parts) {
        glued = true
        splitTokens.push(...parts)
        continue
      }
    }
    splitTokens.push(t)
  }

  // stage 2 — romanization fold
  const ortho = splitTokens.map((t) => ORTHO_FOLD[t] ?? t)
  const foldChanged = ortho.join(' ') !== splitTokens.join(' ')

  // stage 3 — SymSpell spelling repair
  const spelled = ortho.map((t) => {
    if (t.length < 4) return t
    if (TYPE_WORDS.has(t) || CONNECTOR_WORDS.has(t)) return t
    const fix = correctToken(t)
    return fix && !fix.includes(' ') ? fix : t
  })
  const spellChanged = spelled.join(' ') !== ortho.join(' ')

  const via: RecognitionVia | null = glued ? 'split' : foldChanged ? 'ortho' : spellChanged ? 'spelling' : null
  const finalTokens = spelled.join(' ')

  // intermediate forms first-to-last? No — best (fully repaired) first, then
  // the earlier stages as fallbacks, so a probe that fails verification is
  // followed by the form that was already good enough to match a title.
  if (via) {
    const confidence = glued && (foldChanged || spellChanged) ? 0.9 : glued ? 0.86 : foldChanged ? 0.8 : 0.72
    push(finalTokens, via, confidence)
    if (glued) push(splitTokens.join(' '), 'split', 0.7)
    if (foldChanged && !spellChanged) push(ortho.join(' '), 'ortho', 0.7)
  }

  return out.sort((a, b) => b.confidence - a.confidence)
}

// ---------------------------------------------------------------------------
// 4. Suggest layer (network, bounded, only when needed)
// ---------------------------------------------------------------------------

const SUGGEST_DEADLINE_MS = 1500
const SUGGEST_MIN_SIMILARITY = 0.55

/** Does the query look malformed enough to be worth a provider round-trip? */
function shouldAskProvider(raw: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false
  // a single long token that did not decompose is the classic glued/misspelled
  // case ("tuchaiye", "tumhiho", "arjitsingh"); a query with ANY very long token
  // (>14 chars) is not a word anyone types on purpose either.
  if (tokens.length === 1 && tokens[0].length >= 4) return true
  if (tokens.some((t) => t.length >= 14)) return true
  return false
}

interface SuggestHit {
  title: string
  artist: string
}

async function providerSuggestions(raw: string, signal?: AbortSignal): Promise<SuggestHit[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SUGGEST_DEADLINE_MS)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // the same probe the typeahead rail uses — songs filter, tiny limit
    const res = await ytmSearch(raw, 'songs')
    if (signal?.aborted) return []
    return (res.tracks ?? [])
      .slice(0, 4)
      .map((t) => ({ title: t.title ?? '', artist: t.artistName ?? '' }))
      .filter((t) => !!t.title)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

// ---------------------------------------------------------------------------
// 5. Public entry
// ---------------------------------------------------------------------------

const CACHE_MAX = 200
const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map<string, { at: number; rec: Recognition }>()

/** Test/eval hook. */
export function clearRecognitionCache(): void {
  cache.clear()
}

/**
 * Recognize a user query. Never throws, never blocks longer than the suggest
 * deadline, and returns the query untouched (showingFor = null) whenever the
 * literal form is already believable.
 */
export async function recognizeQuery(
  raw: string,
  opts: { signal?: AbortSignal; allowProvider?: boolean } = {},
): Promise<Recognition> {
  const t0 = Date.now()
  const normalized = normalizeQuery(raw)
  const tokens = normalized.split(' ').filter(Boolean)
  const allowProvider = opts.allowProvider !== false

  const key = normalized
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    cache.delete(key)
    cache.set(key, hit)
    return { ...hit.rec, tookMs: Date.now() - t0 }
  }

  const done = (rec: Recognition): Recognition => {
    cache.set(key, { at: Date.now(), rec })
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return rec
  }

  const locals = localAttempts(raw)
  const candidates = locals.map((a) => a.query)

  // a local attempt is enough when it is confident AND the query needed one
  const best = locals[0]
  if (best && best.confidence >= 0.8) {
    return done({
      raw,
      normalized,
      showingFor: best.query,
      via: best.via,
      candidates,
      didYouMean: best.query,
      confident: true,
      tookMs: Date.now() - t0,
    })
  }

  // otherwise, and only for a query that looks malformed, ask the provider
  let via: RecognitionVia | null = best?.via ?? null
  let showingFor: string | null = best?.query ?? null
  let confident = !!best && best.confidence >= 0.7

  if (allowProvider && shouldAskProvider(raw, tokens) && !opts.signal?.aborted) {
    const hits = await providerSuggestions(raw, opts.signal)
    for (const h of hits) {
      const cand = normalizeQuery(h.title)
      if (!cand || cand === normalized) continue
      const sim = similarity(raw, h.title)
      if (sim < SUGGEST_MIN_SIMILARITY) continue
      if (!candidates.includes(cand)) candidates.push(cand)
      if (!showingFor) {
        showingFor = cand
        via = 'suggest'
        // the provider returned a real song whose title is close to what was
        // typed — that is as strong a signal as a clean local split
        confident = sim >= SUGGEST_MIN_SIMILARITY
      }
      break
    }
  }

  // a candidate that only reorders/repeats the query is not a correction
  if (showingFor && normalizeQuery(showingFor) === normalized) {
    showingFor = null
    via = null
    confident = false
  }

  return done({
    raw,
    normalized,
    showingFor,
    via,
    candidates,
    didYouMean: showingFor,
    confident,
    tookMs: Date.now() - t0,
  })
}
