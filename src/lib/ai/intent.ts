/**
 * TSF Music — S1 INTENT (MINDBEAT five-stage pipeline, stage 1: UNDERSTAND).
 *
 * ONE brain, two doors: both the AI Playlist Generator and Vibe Search parse
 * free-text requests through this module. The prompt may be English, Hinglish
 * (romanized Hindi + English code-mix), Devanagari Hindi, or any mix — the
 * LLM is instructed to handle transliteration; the heuristic door covers
 * offline / timeout / dead-gateway paths so the pipeline NEVER hard-fails.
 *
 * Negations are FIRST-CLASS: "no remixes" is a hard constraint, not a vibe.
 * The 'remixes' family catches remix/slowed/reverb/8d/nightcore/sped-up/lofi
 * remix variants — both in the prompt and in track titles at hunt time.
 *
 * SERVER-ONLY: z-ai-web-dev-sdk is imported lazily here (backend only).
 * Every LLM string passes through sanitizeUserText before leaving this file.
 */

import { aiChatJson } from './engine'
import { sanitizeUserText } from './sanitize'

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type NegationFamily =
  | 'remixes'
  | 'covers'
  | 'live'
  | 'karaoke'
  | 'instrumentals'
  | 'explicit'

export type TempoClass = 'slow' | 'mid' | 'fast' | 'any'

export interface Intent {
  artists: string[]
  moods: string[]
  genres: string[]
  languages: string[]
  eras: string[]
  activities: string[]
  energyTarget: number // 0–1
  valenceTarget: number // 0–1
  tempoClass: TempoClass
  negations: NegationFamily[]
  durationMin?: number
  mystery: number // 0–1 — how much the user wants the unknown
  intentConfidence: number // 0–1
  detectedLanguage: string
  curatorBrief: string
  candidateNameHints: string[] // specific names mentioned — searched later, never trusted
  source: 'llm' | 'heuristic' | 'merged'
}

export interface ParseIntentOptions {
  /** Total LLM budget in ms (default 1500 — the stage contract). */
  timeoutMs?: number
  /** Profile taste hints (helps the LLM read vague prompts). */
  profileArtists?: string[]
  profileGenres?: string[]
}

// ---------------------------------------------------------------------------
// Negation machinery (first-class)
// ---------------------------------------------------------------------------

/** Cue words that mark the following family keyword as a NEGATION. */
const NEGATION_CUE =
  /\b(?:no|not|non|without|except|avoid|avoiding|excluding|exclude|minus|zero|dont|don't|do not|never|nahi|nahin|nhi|mat|bina|विना|नहीं|मत)\b/i

/** Family keyword detectors (word-boundary safe — "discover" ≠ "cover"). */
const FAMILY_KEYWORDS: Record<NegationFamily, RegExp> = {
  remixes:
    /\bremix(?:es|ed)?\b|\bslowed\b|\breverb\b|\b8d\b|\b8\s*dimension\b|\bnightcore\b|\bsped\s*(?:up|version)\b|\bspeed\s*up\b|\blo-?fi\s*(?:remix|flip|edit|version)\b|\bchopped\b|\bscrewed\b|\bbass\s*boosted?\b|\bedit\b/i,
  covers: /\bcover(?:s|ed|ing)?\b|\btribute\b/i,
  live: /\blive\s+(?:version|session|performance|recording|at|from|in)\b|\bunplugged\b|\bconcert\b/i,
  karaoke: /\bkaraoke\b/i,
  instrumentals: /\binstrumental(?:s)?\b/i,
  explicit: /\bexplicit\b|\bgaalian?\b|\bvulgar\b/i,
}

/** Title-level kill patterns per family — applied to pool + final tracks. */
export const NEGATION_TITLE_PATTERNS: Record<NegationFamily, RegExp> = {
  remixes:
    /\bremix(?:es|ed)?\b|\bslowed(?:\s*\+\s*(?:and|&|n)?\s*reverb)?\b|\breverb\b|\b8d\s*(?:audio|version)?\b|\beight\s*d(?:imension)?s?\b|\bnightcore\b|\bsped\s*up\b|\bsuper\s*sped\b|\bspeed\s*up\b|\blo-?fi\s*(?:remix|flip|version|edit)\b|\blofi\s*remix\b|\bchopped(?:\s*(?:and|&|n)\s*screwed)?\b|\bbass\s*boosted?\b|\bslammed\b|\bvaporwave\s*remix\b/i,
  covers: /\bcover(?:s|ed|ing)?\b|\btribute\b/i,
  live: /\blive\s+(?:version|session|performance|recording|at|from|in)\b|\bunplugged\b|\bconcert\b/i,
  karaoke: /\bkaraoke\b/i,
  instrumentals: /\binstrumental(?:s)?\b/i,
  explicit: /\bexplicit\b/i,
}

function detectNegations(prompt: string): NegationFamily[] {
  const out = new Set<NegationFamily>()
  // Split into segments on punctuation + contrastive conjunctions so
  // "sad but hopeful" doesn't leak across clauses, while "no remixes, only
  // originals" negates in its own clause.
  const segments = prompt.split(/[,.;!?•|/]|\b(?:but|lekin|par|magar|though|except)\b/i)
  for (const seg of segments) {
    for (const family of Object.keys(FAMILY_KEYWORDS) as NegationFamily[]) {
      if (FAMILY_KEYWORDS[family].test(seg) && NEGATION_CUE.test(seg)) out.add(family)
    }
  }
  // Direct multi-word dictionary forms that straddle the segment split.
  const p = prompt.toLowerCase()
  if (/\b(?:no|without|zero|nahi|nahin|bina)\s+(?:remix|remixes|slowed|reverb|8d|nightcore|sped)/.test(p)) out.add('remixes')
  if (/\boriginals?\s+only\b|\bonly\s+originals?\b|\boriginal\s+versions?\s+only\b/.test(p)) out.add('remixes')
  if (/\b(?:no|without)\s+covers?\b/.test(p)) out.add('covers')
  return [...out]
}

/** Drop pool tracks whose title/album match any negated family. */
export function killByNegations<T extends { title?: string; albumName?: string; artistName?: string }>(
  tracks: T[],
  negations: NegationFamily[] | string[]
): T[] {
  const families = negations.filter((n): n is NegationFamily => n in NEGATION_TITLE_PATTERNS)
  if (!families.length) return tracks
  return tracks.filter((t) => {
    const text = `${t.title ?? ''} ${t.albumName ?? ''}`
    for (const f of families) {
      if (NEGATION_TITLE_PATTERNS[f].test(text)) return false
    }
    return true
  })
}

// ---------------------------------------------------------------------------
// Heuristic door (instant, offline-safe)
// ---------------------------------------------------------------------------

const MOOD_WORDS: Record<string, [number, number]> = {
  // word → [energy, valence] nudges
  sad: [0.25, 0.18], heartbreak: [0.2, 0.12], broken: [0.2, 0.15], melancholy: [0.28, 0.25],
  melancholic: [0.28, 0.25], gloomy: [0.3, 0.25], dark: [0.45, 0.3], dukh: [0.22, 0.15],
  dard: [0.22, 0.15], judai: [0.22, 0.15], bewafa: [0.25, 0.15], tanhai: [0.25, 0.2],
  tanha: [0.25, 0.2], gham: [0.22, 0.15], lonely: [0.25, 0.2],
  hopeful: [0.55, 0.65], uplifting: [0.6, 0.75], happy: [0.65, 0.8], khushi: [0.6, 0.75],
  'feel good': [0.6, 0.75], feelgood: [0.6, 0.75], joyful: [0.65, 0.8],
  romantic: [0.45, 0.6], love: [0.5, 0.65], pyaar: [0.45, 0.65], ishq: [0.45, 0.55],
  mohabbat: [0.4, 0.6], 'romantic evening': [0.4, 0.6],
  chill: [0.3, 0.5], relaxed: [0.3, 0.55], calm: [0.25, 0.5], peaceful: [0.25, 0.55],
  soothing: [0.25, 0.55], mellow: [0.3, 0.45], dreamy: [0.35, 0.5], lofi: [0.3, 0.45],
  nostalgic: [0.45, 0.45], retro: [0.5, 0.55], purane: [0.45, 0.5],
  energetic: [0.8, 0.7], hype: [0.85, 0.7], pumped: [0.85, 0.7], bangers: [0.85, 0.7],
  banger: [0.85, 0.7], powerful: [0.75, 0.6], aggressive: [0.85, 0.4], intense: [0.8, 0.45],
  motivational: [0.7, 0.7], inspiring: [0.6, 0.75], focus: [0.35, 0.4], concentrated: [0.3, 0.4],
  devotional: [0.3, 0.7], spiritual: [0.3, 0.7], bhakti: [0.3, 0.7], sufi: [0.5, 0.6],
  monsoon: [0.4, 0.4], rainy: [0.4, 0.4], baarish: [0.4, 0.4], barish: [0.4, 0.4],
  'late night': [0.35, 0.4], midnight: [0.35, 0.4], morning: [0.5, 0.6], sunshine: [0.6, 0.75],
  summer: [0.65, 0.75], dance: [0.8, 0.75], groovy: [0.75, 0.7], soulful: [0.4, 0.5],
  acoustic: [0.3, 0.5], emotional: [0.35, 0.35], epic: [0.75, 0.55], cinematic: [0.55, 0.5],
}

const ACTIVITY_ENERGY: Record<string, number> = {
  gym: 0.9, workout: 0.88, workouts: 0.88, lifting: 0.9, weights: 0.9, exercise: 0.8,
  running: 0.85, run: 0.8, jogging: 0.75, cycling: 0.8, swimming: 0.65,
  party: 0.85, club: 0.85, clubbing: 0.85, dancing: 0.8, dance: 0.8, shaadi: 0.8, sangeet: 0.75,
  drive: 0.6, driving: 0.6, 'road trip': 0.65, roadtrip: 0.65, 'long drive': 0.6, highway: 0.65,
  commute: 0.5, travel: 0.6, travelling: 0.6, flying: 0.5,
  study: 0.3, studying: 0.3, 'deep work': 0.3, coding: 0.4, programming: 0.4, work: 0.4, writing: 0.35,
  sleep: 0.12, sleeping: 0.12, insomnia: 0.15, lullaby: 0.1, meditation: 0.15, yoga: 0.3,
  cooking: 0.45, chai: 0.35, cleaning: 0.55, chores: 0.5, cricket: 0.7, football: 0.75,
  walk: 0.45, reading: 0.3, painting: 0.35, shower: 0.5, beach: 0.6,
}

const GENRE_WORDS = [
  'synthwave', 'retrowave', 'vaporwave', 'lofi', 'lo-fi', 'hip hop', 'hip-hop', 'rap', 'trap', 'drill',
  'r&b', 'rnb', 'soul', 'funk', 'disco', 'rock', 'metal', 'punk', 'grunge', 'indie', 'alternative',
  'pop', 'bollywood', 'punjabi', 'bhangra', 'ghazal', 'sufi', 'qawwali', 'classical', 'hindustani',
  'carnatic', 'bhajan', 'mantra', 'shabad', 'edm', 'house', 'techno', 'trance', 'dubstep', 'jungle',
  'drum and bass', 'dnb', 'ambient', 'jazz', 'blues', 'country', 'folk', 'reggae', 'afrobeat',
  'amapiano', 'k-pop', 'kpop', 'city pop', 'bossa nova', 'flamenco', 'bluegrass', 'gospel',
  'orchestral', 'soundtrack', 'chiptune', 'garage', 'breakbeat',
]

const LANGUAGE_WORDS = [
  'hindi', 'english', 'punjabi', 'urdu', 'tamil', 'telugu', 'kannada', 'malayalam', 'bengali',
  'marathi', 'gujarati', 'bhojpuri', 'rajasthani', 'haryanvi', 'assamese', 'odia', 'kashmiri',
  'sanskrit', 'nepali', 'sinhala', 'spanish', 'espanol', 'portuguese', 'french', 'german', 'italian',
  'arabic', 'hebrew', 'turkish', 'russian', 'korean', 'japanese', 'mandarin', 'chinese', 'cantonese',
  'indonesian', 'malay', 'thai', 'vietnamese', 'swahili', 'yoruba', 'afrikaans', 'persian', 'farsi',
]

const DECADE_WORDS: Record<string, string> = {
  fifties: '50s', sixties: '60s', seventies: '70s', eighties: '80s', nineties: '90s',
  '50s': '50s', '60s': '60s', '70s': '70s', '80s': '80s', '90s': '90s', '00s': '2000s',
  '2000s': '2000s', '2010s': '2010s', '2020s': 'current', 'early 2000s': '2000s',
  'late 90s': '90s', 'early 90s': '90s', 'mid 2000s': '2000s',
}

const HINGLISH_CUES = [
  'yaar', 'bhai', 'gaane', 'gana', 'chahiye', 'nahi', 'nahin', 'wale', 'wala', 'jaise', 'accha',
  'masti', 'bindaas', 'josh', 'bawaal', 'kuch', 'sunne', 'suno', 'baja', 'dil', 'dil se', 'zara',
]

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'with', 'song', 'songs', 'music', 'that',
  'like', 'feels', 'feel', 'my', 'me', 'some', 'please', 'want', 'give', 'play', 'playlist', 'gaane',
])

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Escape regex specials, then make spaces/hyphens flexible ("feel-good" ≈ "feel good"). */
function flexRe(phrase: string): RegExp {
  const pat = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]?')
  return new RegExp(`\\b${pat}\\b`, 'i')
}

function heuristicIntent(prompt: string, opts?: ParseIntentOptions): Intent {
  const text = normalizeText(prompt)

  // --- negations (first-class) ---
  const negations = detectNegations(prompt)

  // --- mood facets + energy/valence nudges ---
  const moods: string[] = []
  let energySum = 0
  let energyHits = 0
  let valenceSum = 0
  let valenceHits = 0
  for (const [phrase, [e, v]] of Object.entries(MOOD_WORDS)) {
    if (flexRe(phrase).test(text)) {
      moods.push(phrase)
      energySum += e; energyHits++
      valenceSum += v; valenceHits++
    }
  }

  // --- activities ---
  const activities: string[] = []
  for (const phrase of Object.keys(ACTIVITY_ENERGY)) {
    if (flexRe(phrase).test(text)) activities.push(phrase)
  }
  if (activities.length) {
    // the most specific (longest) activity anchors the energy target
    const anchor = activities.reduce((a, b) => (b.length > a.length ? b : a))
    energySum += ACTIVITY_ENERGY[anchor] ?? 0.5; energyHits++
  }

  // --- genres / languages ---
  const genres = GENRE_WORDS.filter((g) => new RegExp(`\\b${g.replace(/[-\s]/g, '[-\\s]?')}\\b`, 'i').test(text))
  const languages = LANGUAGE_WORDS.filter((l) => new RegExp(`\\b${l}\\b`, 'i').test(text))

  // --- eras ---
  const eras = new Set<string>()
  for (const [w, era] of Object.entries(DECADE_WORDS)) {
    if (new RegExp(`\\b${w}\\b`).test(text)) eras.add(era)
  }
  const yearMatch = text.match(/\b(19[5-9]\d|20[0-2]\d)s?\b/)
  if (yearMatch) {
    const decade = Math.floor(Number(yearMatch[1]) / 10) * 10
    eras.add(decade >= 2020 ? 'current' : decade >= 2000 ? `${decade}s` : `${String(decade).slice(2)}s`)
  }
  const eraList = [...eras].filter((e) => e !== 'current' || eras.size === 1)

  // --- candidateNameHints: quoted spans + "like X" patterns (searched, never trusted) ---
  const hints = new Set<string>()
  for (const m of prompt.matchAll(/["'“”‘’]([^"'“”‘’]{2,48})["'“”‘’]/g)) {
    hints.add(m[1].trim())
  }
  for (const m of prompt.matchAll(/\b(?:like|jaise|similar to)\s+((?:[\w\u0900-\u097F]+\s+){0,3}[\w\u0900-\u097F]+)/gi)) {
    const cleaned = m[1]
      .split(/\s+/)
      .filter((w) => !STOP.has(w.toLowerCase()) && !/^(?:the|gaane|songs|wale|wala)$/i.test(w))
      .join(' ')
      .trim()
    if (cleaned.length >= 2) hints.add(cleaned)
  }

  // --- artists: capitalized multi-word proper nouns are risky; rely on the LLM
  // door when available, plus two heuristic nets here:
  //   (a) explicit cues: "by X" / "artist X" / "singer X"
  //   (b) Proper-Noun runs: ≥2 consecutive Capitalized tokens mid-sentence
  //       that aren't mood/genre/language/era vocabulary ("melancholy Arijit
  //       Singh for a drive" → "Arijit Singh"). Searched later, never trusted.
  const artists: string[] = []
  for (const m of prompt.matchAll(/\b(?:by|artist|singer|band)\s+((?:[A-Z][\w'&.-]+\s?){1,3})/g)) {
    const name = m[1].trim()
    if (name) artists.push(name)
  }
  const COMMON_CAPS = new Set([
    ...GENRE_WORDS.flatMap((g) => g.split(/[\s-]/).map((w) => w[0].toUpperCase() + w.slice(1))),
    ...LANGUAGE_WORDS.map((w) => w[0].toUpperCase() + w.slice(1)),
    ...Object.keys(DECADE_WORDS).map((w) => (w.length > 2 && /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)),
    ...Object.keys(MOOD_WORDS).flatMap((m) => m.split(' ').map((w) => w[0].toUpperCase() + w.slice(1))),
    ...Object.keys(ACTIVITY_ENERGY).flatMap((m) => m.split(' ').map((w) => w[0].toUpperCase() + w.slice(1))),
    'I', 'Ii', 'Monsoon', 'Hindi', 'Urdu',
  ])
  const tokens = prompt.split(/\s+/).map((w) => w.replace(/[^\w'&.-\u0900-\u097F]/g, ''))
  let run: string[] = []
  const flushRun = () => {
    if (run.length >= 2) {
      const name = run.join(' ')
      if (!artists.some((a) => a.toLowerCase() === name.toLowerCase())) artists.push(name)
    }
    run = []
  }
  tokens.forEach((w, i) => {
    const isCap = /^[A-Z][a-zA-Z'&.-]*$/.test(w) && !COMMON_CAPS.has(w)
    if (isCap) {
      run.push(w)
    } else {
      // a capitalized word at position 0 often starts the sentence — only
      // count runs from position ≥1 onward
      if (i === 0 && run.length === 1) run = []
      flushRun()
    }
  })
  flushRun()
  const artistList = artists
    .filter((a) => a.split(/\s+/).length <= 4)
    .slice(0, 6)

  // --- duration ---
  let durationMin: number | undefined
  const durMatch = text.match(/\b(\d{1,3})\s*(?:min|mins|minute|minutes)\b/)
  if (durMatch) durationMin = Number(durMatch[1])
  else if (/\bhalf\s+an?\s+hour\b/.test(text)) durationMin = 30
  else if (/\ban\s+hour\b|\b1\s*hour\b/.test(text)) durationMin = 60
  else if (/\b(\d)\s*hours?\b/.test(text)) durationMin = Number(text.match(/\b(\d)\s*hours?\b/)![1]) * 60
  if (durationMin !== undefined) durationMin = Math.max(5, Math.min(240, durationMin))

  // --- mystery ---
  let mystery = 0.2
  if (/\b(surprise|random|anything|kuch bhi|discover|hidden gems?|new music|unheard|offbeat)\b/i.test(text)) mystery = 0.7

  // --- detected language ---
  let detectedLanguage = 'en'
  if (/[\u0900-\u097F]/.test(prompt)) detectedLanguage = 'hi'
  else if (/[\u0A00-\u0A7F]/.test(prompt)) detectedLanguage = 'pa'
  else if (/[\u0600-\u06FF]/.test(prompt)) detectedLanguage = 'ur'
  else if (HINGLISH_CUES.some((c) => new RegExp(`\\b${c}\\b`, 'i').test(text))) detectedLanguage = 'hi-latn'

  // --- energy / valence / tempo targets ---
  const energyTarget = clamp01(energyHits ? energySum / energyHits : 0.5)
  const valenceTarget = clamp01(valenceHits ? valenceSum / valenceHits : 0.5)
  const tempoClass: TempoClass = energyTarget >= 0.7 ? 'fast' : energyTarget <= 0.3 ? 'slow' : 'mid'

  // --- confidence: how many facet families lit up ---
  const facets = [moods.length, genres.length, languages.length, eraList.length, activities.length, artists.length]
  const lit = facets.filter((n) => n > 0).length
  const intentConfidence = clamp01(0.3 + lit * 0.11)

  const briefParts = [
    moods.slice(0, 2).join(' '),
    eraList[0],
    languages[0],
    genres[0],
    activities[0] ? `for ${activities[0]}` : '',
  ].filter(Boolean)
  const curatorBrief = briefParts.join(' ') || prompt.slice(0, 80)

  // profile hints are folded in as artists-of-record for the hunt stage only
  // when the prompt itself named nobody (kept separate from prompt artists)
  void opts

  return {
    artists: artistList,
    moods: moods.slice(0, 6),
    genres: genres.slice(0, 6),
    languages: languages.slice(0, 4),
    eras: eraList.slice(0, 3),
    activities: activities.slice(0, 3),
    energyTarget,
    valenceTarget,
    tempoClass,
    negations,
    durationMin,
    mystery,
    intentConfidence,
    detectedLanguage,
    curatorBrief,
    candidateNameHints: [...hints].slice(0, 4),
    source: 'heuristic',
  }
}

// ---------------------------------------------------------------------------
// LLM door (z-ai SDK → house engine fallback, hard ≤1.5s budget)
// ---------------------------------------------------------------------------

const INTENT_SYSTEM = `You are TSF Music's intent parser. Read the user's music request — it may be English, Hinglish (romanized Hindi mixed with English), Hindi (Devanagari), or any code-mixed/transliterated form. Normalize across scripts and transliteration before matching.
Reply with COMPACT JSON only — no markdown, no prose. Schema:
{"artists":["names of specific artists mentioned"],"moods":["sad","hopeful"],"genres":[],"languages":[],"eras":["90s"],"activities":["drive"],"energyTarget":0-1,"valenceTarget":0-1,"tempoClass":"slow"|"mid"|"fast"|"any","negations":[],"durationMin":null,"mystery":0-1,"intentConfidence":0-1,"detectedLanguage":"en","curatorBrief":"one sentence, the playlist's soul","candidateNameHints":["song or artist names the user mentioned"]}
Rules:
- negations are HARD constraints: "no remixes" → negations:["remixes"]; also catch slowed/reverb/8d/nightcore/sped up variants under that family; "no covers", "no live", "no explicit" similarly.
- energyTarget/valenceTarget are your read of the desired intensity and mood brightness, 0-1.
- candidateNameHints: quoted names or names after "like"/"jaise" — list them verbatim; they will be SEARCHED, never assumed.
- Handle Hinglish and transliteration: "duk bhare gaane" = sad songs; "90s wale" = 90s era.
- If a facet is absent, return an empty array. Keep every string short.`

interface RawIntentJson {
  artists?: unknown
  moods?: unknown
  genres?: unknown
  languages?: unknown
  eras?: unknown
  activities?: unknown
  energyTarget?: unknown
  valenceTarget?: unknown
  tempoClass?: unknown
  negations?: unknown
  durationMin?: unknown
  mystery?: unknown
  intentConfidence?: unknown
  detectedLanguage?: unknown
  curatorBrief?: unknown
  candidateNameHints?: unknown
}

function strArray(v: unknown, maxWords = 4, cap = 6): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => sanitizeUserText(s, 40))
    .filter((s) => s && s.split(/\s+/).length <= maxWords)
    .slice(0, cap)
}

function num01(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? clamp01(n) : fallback
}

function mergeIntent(base: Intent, raw: RawIntentJson): Intent {
  const fams = new Set<NegationFamily>(base.negations)
  for (const n of strArray(raw.negations, 3, 8)) {
    const key = n.toLowerCase().replace(/[^a-z]/g, '')
    if (key.startsWith('remix') || key.includes('slow') || key.includes('reverb') || key.includes('8d') || key.includes('nightcore') || key.includes('sped') || key.includes('edit')) fams.add('remixes')
    else if (key.includes('cover') || key.includes('tribute')) fams.add('covers')
    else if (key.includes('live') || key.includes('concert') || key.includes('unplugged')) fams.add('live')
    else if (key.includes('karaoke')) fams.add('karaoke')
    else if (key.includes('instrumental')) fams.add('instrumentals')
    else if (key.includes('explicit') || key.includes('gaali') || key.includes('vulgar')) fams.add('explicit')
  }

  const llmTempo = typeof raw.tempoClass === 'string' && ['slow', 'mid', 'fast', 'any'].includes(raw.tempoClass)
    ? (raw.tempoClass as TempoClass)
    : base.tempoClass

  let durationMin = base.durationMin
  const d = typeof raw.durationMin === 'string' ? parseFloat(raw.durationMin) : raw.durationMin
  if (typeof d === 'number' && Number.isFinite(d) && d >= 5 && d <= 240) durationMin = Math.round(d)

  const curatorBrief = sanitizeUserText(typeof raw.curatorBrief === 'string' ? raw.curatorBrief : '', 160) || base.curatorBrief

  const energyTarget = num01(raw.energyTarget, base.energyTarget)
  const valenceTarget = num01(raw.valenceTarget, base.valenceTarget)

  return {
    artists: [...new Set([...strArray(raw.artists, 4, 6), ...base.artists])].slice(0, 6),
    moods: [...new Set([...strArray(raw.moods), ...base.moods])].slice(0, 6),
    genres: [...new Set([...strArray(raw.genres), ...base.genres])].slice(0, 6),
    languages: [...new Set([...strArray(raw.languages, 3, 4), ...base.languages])].slice(0, 4),
    eras: [...new Set([...strArray(raw.eras, 2, 3), ...base.eras])].slice(0, 3),
    activities: [...new Set([...strArray(raw.activities, 3, 3), ...base.activities])].slice(0, 3),
    energyTarget,
    valenceTarget,
    tempoClass: llmTempo !== 'any' ? llmTempo : energyTarget >= 0.7 ? 'fast' : energyTarget <= 0.3 ? 'slow' : 'mid',
    negations: [...fams],
    durationMin,
    mystery: num01(raw.mystery, base.mystery),
    intentConfidence: Math.max(base.intentConfidence, num01(raw.intentConfidence, 0) * 0.9 + 0.1),
    detectedLanguage: sanitizeUserText(typeof raw.detectedLanguage === 'string' ? raw.detectedLanguage : '', 12) || base.detectedLanguage,
    curatorBrief,
    candidateNameHints: [...new Set([...strArray(raw.candidateNameHints, 6, 4), ...base.candidateNameHints])].slice(0, 4),
    source: 'merged',
  }
}

async function llmIntent(
  prompt: string,
  budgetMs: number,
  profileArtists?: string[],
  profileGenres?: string[]
): Promise<RawIntentJson | null> {
  const deadline = Date.now() + budgetMs
  const profileHint =
    profileArtists?.length || profileGenres?.length
      ? ` Listener's saved taste (context only): artists ${profileArtists?.slice(0, 5).join(', ') || '—'}; genres ${profileGenres?.slice(0, 5).join(', ') || '—'}.`
      : ''
  const messages = [
    { role: 'system' as const, content: INTENT_SYSTEM },
    { role: 'user' as const, content: `Request: "${prompt.slice(0, 280)}"${profileHint}` },
  ]

  const withRemaining = async <T,>(fn: (ms: number) => Promise<T>): Promise<T | null> => {
    const remaining = deadline - Date.now()
    if (remaining < 150) return null
    try {
      return await Promise.race([
        fn(remaining),
        new Promise<null>((_res) => setTimeout(() => null, remaining)),
      ])
    } catch {
      return null
    }
  }

  // Door 1: z-ai SDK (backend only — thinking disabled, JSON mode)
  const sdkResult = await withRemaining(async (ms) => {
    const { default: ZAI } = await import('z-ai-web-dev-sdk')
    const zai = await ZAI.create()
    const completion = (await Promise.race([
      zai.chat.completions.create({
        messages,
        thinking: { type: 'disabled' },
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
      new Promise((_res, rej) => setTimeout(() => rej(new Error('intent sdk timeout')), ms),
      ),
    ])) as { choices?: { message?: { content?: string } }[] }
    const text = completion?.choices?.[0]?.message?.content
    return text ? parseLooseJson(text) : null
  })
  if (sdkResult) return sdkResult

  // Door 2: house engine (fast local gateway → keyless fallback), remaining budget
  const engineResult = await withRemaining(async (ms) => {
    const text = await aiChatJson<string>(
      [
        { role: 'system', content: INTENT_SYSTEM },
        { role: 'user', content: messages[1].content },
      ],
      { temperature: 0.3, maxTokens: 500, json: true, timeoutMs: ms }
    )
    return text ? parseLooseJson(text) : null
  })
  return engineResult ?? null
}

function parseLooseJson(raw: string): RawIntentJson | null {
  try {
    const j = JSON.parse(raw.replace(/^```[a-z]*\s*/i, '').replace(/\s*```\s*$/i, ''))
    return j && typeof j === 'object' ? (j as RawIntentJson) : null
  } catch {
    const a = raw.indexOf('{')
    const b = raw.lastIndexOf('}')
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(raw.slice(a, b + 1)) as RawIntentJson
      } catch {
        return null
      }
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a free-text music request into a structured Intent.
 * Heuristic door runs instantly; the LLM door has a hard ≤1.5s budget
 * (stage contract). LLM output merges over the heuristic base, and every
 * LLM string is sanitized before it leaves this function.
 */
export async function parseIntent(prompt: string, opts?: ParseIntentOptions): Promise<Intent> {
  const base = heuristicIntent(prompt, opts)
  const budget = Math.max(400, Math.min(3000, opts?.timeoutMs ?? 1500))
  try {
    const raw = await llmIntent(prompt, budget, opts?.profileArtists, opts?.profileGenres)
    if (raw) return mergeIntent(base, raw)
  } catch {
    // never hard-fail — heuristic intent stands
  }
  return base
}
