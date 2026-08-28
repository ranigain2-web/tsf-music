import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { search as ytmSearch } from '@/lib/ytm'
import { readProfile } from '../../onboarding/route'
import { filterSafeTracks, isShelfTitleSafe } from '@/lib/safety'
import { aiChat } from '@/lib/ai/engine'
import { parseTolerantJson } from '@/lib/ai/partial'
import { sanitizeUserText } from '@/lib/ai/sanitize'
import { parseIntent, killByNegations, type Intent } from '@/lib/ai/intent'
import { getFeatures } from '@/lib/mindbeat/features'
import { ARTIST_CAP_PER_SEQUENCE, ENERGY_STEP_MAX, AI_PLAYLIST } from '@/lib/mindbeat/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * POST /api/ai/playlist-generator   (Server-Sent Events stream)
 *   body: { prompt: string, count?: number (default 25), regenerate?: boolean }
 *
 * MINDBEAT v2 FIVE-STAGE PIPELINE (replaces the v1 LLM-shard architecture):
 *
 *   S1 UNDERSTAND  — parseIntent(): LLM (≤1.5s, z-ai SDK, JSON mode) over a
 *                    heuristic base; negations are first-class ("no remixes"
 *                    kills remix/slowed/reverb/8d/nightcore/sped-up tracks).
 *   S2 HUNT        — deterministic ≤10 parallel ytm searches (per named
 *                    artist, mood×genre×language cell, era, activity,
 *                    candidateNameHints — searched, never trusted). Dedupe
 *                    (title|artist) → safety → negation filter → pool 60–120
 *                    (small counts: max(count*3, 40)) → instant TrackFeature
 *                    heuristics for the energy/valence arc (LLM enrichment
 *                    keeps firing in the background on its own).
 *   S3 CURATE      — THE ID-IN/ID-OUT CONTRACT: pool as compact JSON lines +
 *                    intent + target count → LLM returns an ORDERED id list
 *                    with per-slot reasons (≤8 words), name, description,
 *                    arcPlan. Hallucinated ids are dropped SILENTLY; below
 *                    floor → ONE strict re-ask ("choose only from the list")
 *                    → still short → deterministic energy-arc top-up. The
 *                    pipeline NEVER hard-fails.
 *   S4 POLISH      — deterministic: safety re-check → dedupe → artist cap
 *                    (ARTIST_CAP_PER_SEQUENCE) → no 3 consecutive same-artist
 *                    → energy-arc smoothing (adjacent step ≤ ENERGY_STEP_MAX,
 *                    activity presets: workout ramp 0.6→0.85 hold, sleep
 *                    descend, focus flat ±0.1) → duration fit. If anything
 *                    changed, `phase:polish` is emitted and the corrected
 *                    order is re-emitted.
 *   S5 NARRATE     — tiny LLM (≤1s, offline-safe): daylist-pattern name +
 *                    curator-voice description, era/genre-true to the ACTUAL
 *                    tracklist, honest basis, no social proof. Failure →
 *                    deterministic template name.
 *
 * SSE protocol (v1-compatible):
 *   {"type":"phase","phase":"understand|hunt|curate|polish|narrate|replayed"}
 *   {"type":"meta","title","description","intentConfidence"}
 *   {"type":"track","track":{...},"reason","index"}
 *   {"type":"done","playlistId","title","total","ms"}
 *   {"type":"error","message"}
 *
 * Regenerate: POST {prompt, regenerate:true} → temperature bump + excludes
 * 40% of the last variant's picks (kept in the payload cache entry) so the
 * variant differs in ≥40% tracks.
 *
 * Purity: every user-visible LLM string passes through sanitizeUserText;
 * provider/model identities never reach the client.
 */

const DEFAULT_COUNT = 25
const MAX_COUNT = 50
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const S3_TIMEOUT_MS = 7_500
const S3_REASK_TIMEOUT_MS = 6_000
const HUNT_TIMEOUT_MS = 4_500

interface PoolTrack {
  id: string
  title: string
  artist: string
  artistName: string // alias of artist (Trackish-compatible)
  artistId?: string
  albumName?: string
  year?: number
  language: string
  energy: number
  valence: number
  tempoClass: 'slow' | 'mid' | 'fast'
  duration: number
  thumbnail: string
  reason?: string
}

interface CuratedPick {
  id: string
  reason: string
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'with', 'song', 'songs', 'music', 'that',
  'like', 'feels', 'feel', 'my', 'me', 'some', 'please', 'want', 'give', 'play', 'playlist',
])

const TOPUP_REASONS = ['Fits the energy arc', 'Keeps the vibe going', 'Rounds out the journey']

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function hashKey(s: string): string {
  // djb2 — fast, no crypto dependency
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function poolToPlayer(t: PoolTrack) {
  return {
    videoId: t.id,
    title: t.title,
    artistName: t.artist,
    artistId: t.artistId,
    albumName: t.albumName,
    duration: t.duration,
    thumbnail: t.thumbnail,
  }
}

function normPair(title: string, artist: string): string {
  return `${title.toLowerCase().replace(/[^a-z0-9]/g, '')}|${artist.toLowerCase().replace(/[^a-z0-9]/g, '')}`
}

/** Deterministic backfill queries if the first hunt wave under-delivers. */
function backfillQueries(prompt: string): string[] {
  const core = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .slice(0, 5)
    .join(' ')
  return core ? [`${core} hits`, `${core} mix`] : [prompt].filter(Boolean)
}

// ---------------------------------------------------------------------------
// S2 HUNT
// ---------------------------------------------------------------------------

function buildQueries(intent: Intent, prompt: string): string[] {
  const qs: string[] = []
  const push = (q: string) => {
    const t = q.replace(/\s+/g, ' ').trim()
    if (t.length >= 3 && !qs.some((x) => x.toLowerCase() === t.toLowerCase())) qs.push(t)
  }
  const lang = intent.languages[0] ?? ''
  const genre = intent.genres[0] ?? ''
  const mood0 = intent.moods[0] ?? ''
  const mood1 = intent.moods[1] ?? mood0
  const era = intent.eras[0] ?? ''

  // per named artist
  for (const a of intent.artists.slice(0, 3)) push(`${a} ${genre || lang || ''} songs`)
  // mood × genre × language cells
  push([mood0, genre, lang, 'songs'].filter(Boolean).join(' '))
  if (intent.moods.length > 1 || genre) push([mood1, lang || genre, 'songs'].filter(Boolean).join(' '))
  // era
  if (era) push([era, lang || genre || mood0, 'hits'].filter(Boolean).join(' '))
  // activity
  if (intent.activities[0]) push([intent.activities[0], lang || genre || mood0, 'songs'].filter(Boolean).join(' '))
  // candidateNameHints — searched, never trusted
  for (const h of intent.candidateNameHints.slice(0, 2)) push(h)
  // prompt core fallback
  const core = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .slice(0, 6)
    .join(' ')
  if (core) push(core)
  return qs.slice(0, 10)
}

async function huntOne(query: string, perQuery: number): Promise<{ videoId: string; title: string; artistName: string; artistId?: string; albumName?: string; year?: number; duration: number; thumbnail: string }[]> {
  try {
    const raced = await Promise.race([
      ytmSearch(query, 'songs'),
      new Promise<null>((res) => setTimeout(() => res(null), HUNT_TIMEOUT_MS)),
    ])
    const tracks = (raced as { tracks?: unknown[] } | null)?.tracks ?? []
    return tracks
      .filter((t): t is NonNullable<typeof t> => !!t && typeof (t as { videoId?: unknown }).videoId === 'string')
      .slice(0, perQuery)
      .map((t) => {
        const tr = t as { videoId: string; title?: string; artistName?: string; artistId?: string; albumName?: string; year?: number; duration?: number; thumbnail?: string }
        return {
          videoId: tr.videoId,
          title: tr.title ?? '',
          artistName: tr.artistName ?? '',
          artistId: tr.artistId,
          albumName: tr.albumName,
          year: tr.year,
          duration: tr.duration ?? 0,
          thumbnail: tr.thumbnail ?? '',
        }
      })
  } catch {
    return []
  }
}

/** Deterministic, parallel hunt. Returns a filtered, feature-tagged pool. */
async function huntPool(
  queries: string[],
  intent: Intent,
  poolTarget: number,
  excludeIds: Set<string>,
  prompt: string
): Promise<PoolTrack[]> {
  const collect = async (qs: string[]): Promise<Map<string, PoolTrack>> => {
    const perQuery = Math.min(25, Math.ceil((poolTarget * 1.5) / Math.max(1, qs.length)))
    const settled = await Promise.allSettled(qs.map((q) => huntOne(q, perQuery)))
    const byId = new Map<string, PoolTrack>()
    const byPair = new Set<string>()
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue
      for (const t of s.value) {
        if (!t.videoId || byId.has(t.videoId)) continue
        const pair = normPair(t.title, t.artistName)
        if (byPair.has(pair)) continue
        byId.set(t.videoId, {
          id: t.videoId,
          title: t.title,
          artist: t.artistName,
          artistName: t.artistName,
          artistId: t.artistId,
          albumName: t.albumName,
          year: t.year,
          language: intent.languages[0] ?? 'unknown',
          energy: 0.5,
          valence: 0.5,
          tempoClass: 'mid',
          duration: t.duration,
          thumbnail: t.thumbnail,
        })
        byPair.add(pair)
      }
    }
    return byId
  }

  let map = await collect(queries)

  // deterministic backfill wave when the hunt under-delivers
  if (map.size < Math.min(poolTarget, 40)) {
    const extra = backfillQueries(prompt).filter((q) => !queries.includes(q))
    if (extra.length) {
      const extraMap = await collect(extra)
      for (const [id, t] of extraMap) if (!map.has(id)) map.set(id, t)
    }
  }

  // safety → negations → regenerate exclusions → pool cap
  let tracks = filterSafeTracks([...map.values()])
  tracks = killByNegations(tracks, intent.negations)
  if (excludeIds.size) tracks = tracks.filter((t) => !excludeIds.has(t.id))
  tracks = tracks.slice(0, poolTarget)

  // instant feature heuristics for the arc (LLM enrichment fires in background)
  if (!tracks.length) return []
  let features: Map<string, { effEnergy?: number | null; energy?: number | null; effValence?: number | null; valence?: number | null; tempoClass?: string | null; language?: string | null }> = new Map()
  try {
    features = await getFeatures(tracks.map((t) => t.id))
  } catch {
    // neutral features stay
  }
  for (const t of tracks) {
    const f = features.get(t.id)
    if (f) {
      t.energy = clamp01(f.effEnergy ?? f.energy ?? t.energy)
      t.valence = clamp01(f.effValence ?? f.valence ?? t.valence)
      if (f.tempoClass === 'slow' || f.tempoClass === 'mid' || f.tempoClass === 'fast') t.tempoClass = f.tempoClass
      if (f.language) t.language = f.language
    }
  }
  return tracks
}

/** Energy-diverse deterministic cap (keeps the arc playable when pool > 120). */
function capPool(pool: PoolTrack[], cap: number): PoolTrack[] {
  if (pool.length <= cap) return pool
  const sorted = [...pool].sort((a, b) => a.energy - b.energy || a.id.localeCompare(b.id))
  const step = sorted.length / cap
  const out: PoolTrack[] = []
  for (let i = 0; i < cap; i++) out.push(sorted[Math.floor(i * step)])
  return out
}

// ---------------------------------------------------------------------------
// S3 CURATE — the ID-IN/ID-OUT contract
// ---------------------------------------------------------------------------

function compactIntent(intent: Intent): Record<string, unknown> {
  return {
    moods: intent.moods,
    genres: intent.genres,
    languages: intent.languages,
    eras: intent.eras,
    artistsToEcho: intent.artists,
    activities: intent.activities,
    energyTarget: Math.round(intent.energyTarget * 100) / 100,
    valenceTarget: Math.round(intent.valenceTarget * 100) / 100,
    tempoClass: intent.tempoClass,
    hardNegations: intent.negations,
    curatorBrief: intent.curatorBrief,
  }
}

function extractPicks(j: unknown): CuratedPick[] {
  const out: CuratedPick[] = []
  const fromObj = (x: unknown): CuratedPick | null => {
    if (typeof x === 'string') return { id: x.trim(), reason: '' }
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>
      const id = o.id ?? o.trackId ?? o.videoId
      if (typeof id === 'string' && id.trim()) {
        return { id: id.trim(), reason: typeof o.reason === 'string' ? o.reason : '' }
      }
    }
    return null
  }
  let arr: unknown[] = []
  if (Array.isArray(j)) arr = j
  else if (j && typeof j === 'object') {
    const o = j as Record<string, unknown>
    for (const key of ['picks', 'tracks', 'songs', 'ids', 'items']) {
      if (Array.isArray(o[key])) {
        arr = o[key] as unknown[]
        break
      }
    }
  }
  for (const x of arr) {
    const p = fromObj(x)
    if (p) out.push(p)
  }
  return out
}

async function curateWithLLM(
  pool: PoolTrack[],
  intent: Intent,
  count: number,
  opts: { temperature: number; timeoutMs: number; strict: boolean; signal?: AbortSignal }
): Promise<{ picks: CuratedPick[]; name: string; description: string; arcPlan: string } | null> {
  const lines = capPool(pool, AI_PLAYLIST.poolMax)
    .map((t) =>
      JSON.stringify({
        id: t.id,
        title: t.title.slice(0, 60),
        artist: t.artist.slice(0, 40),
        year: t.year ?? null,
        language: t.language,
        energy: Math.round(t.energy * 100) / 100,
        valence: Math.round(t.valence * 100) / 100,
        tempoClass: t.tempoClass,
      })
    )
    .join('\n')

  const strict = opts.strict
    ? ' CRITICAL: choose only from the list — copy every id EXACTLY as given, never invent or alter an id.'
    : ''

  const system = `You are TSF Music's playlist curator. You get a pool of REAL tracks (JSON lines: id,title,artist,year,language,energy,valence,tempoClass) and an intent. Choose and ORDER ${count} tracks that follow the intent and a coherent energy arc.${strict}
Rules:
- pick ONLY ids from the pool — never invent an id; each track exactly once
- vary artists (max ${ARTIST_CAP_PER_SEQUENCE} per artist, never 3 in a row)
- respect hardNegations (e.g. no remixes means no "Remix"/"Slowed" versions)
- per-track "reason" ≤ 8 words: why THIS track fits THIS playlist
- "name": 2-5 evocative words; "description": 1-2 sentences, curator voice, honest (no social proof); "arcPlan": one short sentence on the energy journey
- output COMPACT JSON only: {"name":"...","description":"...","arcPlan":"...","picks":[{"id":"...","reason":"..."}]}`

  const user = `Intent: ${JSON.stringify(compactIntent(intent))}
Pool (${capPool(pool, AI_PLAYLIST.poolMax).length} tracks):
${lines}
Return ${count} picks in play order.`

  try {
    const r = await aiChat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: opts.temperature, maxTokens: 2200, json: true, timeoutMs: opts.timeoutMs, signal: opts.signal }
    )
    const j = parseTolerantJson<Record<string, unknown>>(r.text)
    if (!j) return null
    const picks = extractPicks(j.picks ?? j)
    return {
      picks,
      name: typeof j.name === 'string' ? sanitizeUserText(j.name, 80) : '',
      description: typeof j.description === 'string' ? sanitizeUserText(j.description, 200) : '',
      arcPlan: typeof j.arcPlan === 'string' ? sanitizeUserText(j.arcPlan, 120) : '',
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// S4 POLISH — deterministic corrections + energy-arc smoothing
// ---------------------------------------------------------------------------

function arcTargets(n: number, intent: Intent): number[] {
  const acts = new Set(intent.activities)
  const e = intent.energyTarget
  const arr = Array.from({ length: n }, (_, i) => 0.5)
  if (n === 0) return arr
  if (acts.has('sleep') || acts.has('sleeping') || acts.has('insomnia')) {
    // descend
    for (let i = 0; i < n; i++) arr[i] = clamp01(Math.max(0.12, 0.5 - (0.38 * i) / Math.max(1, n - 1)))
    return arr
  }
  if (acts.has('gym') || acts.has('workout') || acts.has('workouts') || acts.has('lifting') || acts.has('weights') || acts.has('running') || acts.has('party')) {
    // ramp 0.6 → 0.85 over the first third, then hold
    const rampEnd = Math.max(1, Math.ceil(n / 3))
    for (let i = 0; i < n; i++) arr[i] = i < rampEnd ? clamp01(0.6 + (0.25 * i) / rampEnd) : 0.85
    return arr
  }
  if (acts.has('study') || acts.has('studying') || acts.has('deep work') || acts.has('coding') || acts.has('reading') || acts.has('meditation') || acts.has('yoga')) {
    // flat ±0.1
    const base = Math.min(0.5, Math.max(0.25, e || 0.4))
    for (let i = 0; i < n; i++) arr[i] = clamp01(base + (((i % 4) - 1.5) * 0.05))
    return arr
  }
  // default: warm open → intent peak mid-list → settle
  const peak = clamp01(Math.max(e, 0.55) + 0.05)
  const open = clamp01(Math.max(0.4, e - 0.15))
  for (let i = 0; i < n; i++) {
    const x = n <= 1 ? 0.5 : i / (n - 1)
    const bell = Math.sin(Math.PI * x)
    arr[i] = clamp01(open + (peak - open) * bell * 0.9)
  }
  return arr
}

/** Greedy reorder: membership preserved, order follows the arc targets. */
function arcOrder(seq: PoolTrack[], targets: number[]): PoolTrack[] {
  const remaining = [...seq]
  const out: PoolTrack[] = []
  let lastE: number | null = null
  for (let i = 0; i < seq.length; i++) {
    const t = targets[i] ?? targets[targets.length - 1] ?? 0.5
    let bestIdx = 0
    let bestScore = Infinity
    for (let j = 0; j < remaining.length; j++) {
      const e = remaining[j].energy
      const step = lastE === null ? 0 : Math.abs(e - lastE)
      const score = Math.abs(e - t) + (step > ENERGY_STEP_MAX ? 0.75 : 0) + step * 0.25
      if (score < bestScore) {
        bestScore = score
        bestIdx = j
      }
    }
    const pick = remaining.splice(bestIdx, 1)[0]
    lastE = pick.energy
    out.push(pick)
  }
  return out
}

function breakTripleRuns(seq: PoolTrack[]): PoolTrack[] {
  const a = (t: PoolTrack) => t.artist.toLowerCase().trim()
  for (let i = 2; i < seq.length; i++) {
    if (a(seq[i]) === a(seq[i - 1]) && a(seq[i]) === a(seq[i - 2])) {
      for (let j = i + 1; j < seq.length; j++) {
        if (a(seq[j]) !== a(seq[i])) {
          const tmp = seq[i]
          seq[i] = seq[j]
          seq[j] = tmp
          break
        }
      }
    }
  }
  return seq
}

/** Deterministic top-up ordered by energy-arc fit. */
function topUpArc(
  current: PoolTrack[],
  pool: PoolTrack[],
  targetCount: number,
  targets: number[],
  artistCount: Map<string, number>
): PoolTrack[] {
  const used = new Set(current.map((t) => t.id))
  const candidates = pool.filter((t) => !used.has(t.id))
  const out = [...current]
  let topIdx = 0
  while (out.length < targetCount && candidates.length) {
    const slot = out.length
    const t = targets[slot] ?? targets[targets.length - 1] ?? 0.5
    let best = -1
    let bestScore = Infinity
    for (let j = 0; j < candidates.length; j++) {
      const c = candidates[j]
      const key = c.artist.toLowerCase().trim()
      let score = Math.abs(c.energy - t)
      if ((artistCount.get(key) ?? 0) >= ARTIST_CAP_PER_SEQUENCE) score += 10
      const lastTwo = out.slice(-2)
      if (lastTwo.length === 2 && lastTwo.every((x) => x.artist.toLowerCase().trim() === key)) score += 5
      if (score < bestScore) {
        bestScore = score
        best = j
      }
    }
    if (best < 0) break
    const [pick] = candidates.splice(best, 1)
    const key = pick.artist.toLowerCase().trim()
    artistCount.set(key, (artistCount.get(key) ?? 0) + 1)
    pick.reason = TOPUP_REASONS[topIdx % TOPUP_REASONS.length]
    topIdx++
    out.push(pick)
  }
  return out
}

function polishSequence(seq: PoolTrack[], intent: Intent, floor: number, pool: PoolTrack[]): PoolTrack[] {
  // 1. safety re-check
  let out = filterSafeTracks(seq)
  // 2. dedupe (id + title|artist)
  const seenIds = new Set<string>()
  const seenPairs = new Set<string>()
  out = out.filter((t) => {
    if (seenIds.has(t.id)) return false
    const pair = normPair(t.title, t.artist)
    if (seenPairs.has(pair)) return false
    seenIds.add(t.id)
    seenPairs.add(pair)
    return true
  })
  // 3. artist cap — later occurrences dropped when over ARTIST_CAP_PER_SEQUENCE
  const artistCount = new Map<string, number>()
  const capped: PoolTrack[] = []
  for (const t of out) {
    const key = t.artist.toLowerCase().trim()
    const count = artistCount.get(key) ?? 0
    if (count >= ARTIST_CAP_PER_SEQUENCE) continue
    artistCount.set(key, count + 1)
    capped.push(t)
  }
  out = capped
  // 4. floor top-up from the unused pool (deterministic arc fit)
  if (out.length < floor) {
    const targets = arcTargets(Math.max(out.length + 8, floor), intent)
    out = topUpArc(out, pool, floor, targets, artistCount)
  }
  // 5. energy-arc smoothing (adjacent-slot step ≤ ENERGY_STEP_MAX)
  out = arcOrder(out, arcTargets(out.length, intent))
  // 6. no 3 consecutive same-artist
  out = breakTripleRuns(out)
  // 7. duration fit
  if (intent.durationMin) {
    const budget = intent.durationMin * 60
    let total = out.reduce((s, t) => s + (t.duration || 0), 0)
    while (total > budget && out.length > 5) {
      const dropped = out.pop()
      total -= dropped?.duration || 0
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// S5 NARRATE — daylist-pattern name, curator voice, honest basis
// ---------------------------------------------------------------------------

const NAME_BANK_EXAMPLES =
  'midnight riyaz, monsoon ghazals, gym desi bass, Chandigarh drive, 3am tape, Bengaluru rain commute, shaam-e-ghazal, lofi dargah, Filter Coffee Focus'

async function narrate(
  seq: PoolTrack[],
  intent: Intent,
  llmName: string,
  llmDescription: string,
  signal?: AbortSignal
): Promise<{ name: string; description: string }> {
  const template = templateNarrative(seq, intent)
  try {
    const counts = new Map<string, number>()
    for (const t of seq) counts.set(t.artist, (counts.get(t.artist) ?? 0) + 1)
    const topArtists = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([a, c]) => `${a}×${c}`)
      .join(', ')
    const languages = [...new Set(seq.map((t) => t.language).filter((l) => l && l !== 'unknown'))].slice(0, 4).join('/') || 'unknown'
    const years = seq.map((t) => t.year).filter((y): y is number => typeof y === 'number' && y > 1900)
    const yearRange = years.length ? `${Math.min(...years)}–${Math.max(...years)}` : 'mixed eras'
    const meanE = seq.length ? seq.reduce((s, t) => s + t.energy, 0) / seq.length : 0.5
    const meanV = seq.length ? seq.reduce((s, t) => s + t.valence, 0) / seq.length : 0.5
    const tempoMix = ['slow', 'mid', 'fast']
      .map((tc) => `${tc}:${seq.filter((t) => t.tempoClass === tc).length}`)
      .join(' ')

    const system = `You name playlists in a daylist voice: short, evocative, era/genre-true, sometimes vernacular. Examples of the voice: ${NAME_BANK_EXAMPLES}. Name ONLY what is actually in the tracklist — no invented genres, no social proof, no "your favorites". Reply COMPACT JSON only: {"name":"2-5 words","description":"1-2 sentences, curator voice, honest basis"}.`
    const user = `Tracklist: ${seq.length} tracks. Artists: ${topArtists}. Languages: ${languages}. Years: ${yearRange}. Avg energy ${meanE.toFixed(2)}, valence ${meanV.toFixed(2)}. Tempo mix ${tempoMix}. Intent: ${intent.curatorBrief}. Moods: ${intent.moods.join('/') || '—'}. Activity: ${intent.activities[0] ?? '—'}.`

    const r = await aiChat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.8, maxTokens: 160, json: true, timeoutMs: 1_000, signal }
    )
    const j = parseTolerantJson<{ name?: string; description?: string }>(r.text)
    const name = sanitizeUserText(j?.name ?? '', 60)
    const description = sanitizeUserText(j?.description ?? '', 200)
    return {
      name: name || llmName || template.name,
      description: description || llmDescription || template.description,
    }
  } catch {
    // offline-safe: LLM curation name, else template
    return { name: llmName || template.name, description: llmDescription || template.description }
  }
}

function titleCase(s: string): string {
  return s
    .split(' ')
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

function templateNarrative(seq: PoolTrack[], intent: Intent): { name: string; description: string } {
  const facet = intent.moods[0] ?? intent.activities[0] ?? intent.genres[0] ?? ''
  const lang = intent.languages[0] ?? ''
  const era = intent.eras[0] ?? ''
  const suffixes = ['mix', 'tape', 'hours', 'chapter']
  const name = titleCase([facet, lang, era, suffixes[seq.length % suffixes.length]].filter(Boolean).join(' ')).slice(0, 60) || 'Fresh Mix'
  const first = seq[0]?.artist ?? ''
  const last = seq.length > 1 ? seq[seq.length - 1].artist : ''
  const description = seq.length
    ? `${seq.length} real tracks for ${facet || 'the mood'}${intent.activities[0] ? ` — built for ${intent.activities[0]}` : ''}${first ? `, flowing from ${first}` : ''}${last ? ` toward ${last}` : ''}.`
    : 'A fresh mix built from your description.'
  return { name, description }
}

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------

function sse(controller: ReadableStreamDefaultController, enc: TextEncoder, obj: unknown) {
  controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface CachedPayload {
  title: string
  description: string
  tracks: ReturnType<typeof poolToPlayer>[]
  reasons: Record<string, string>
  intentConfidence?: number
  lastVariantIds?: string[]
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const prompt: string = (body.prompt || '').trim()
  const count = Math.min(MAX_COUNT, Math.max(5, body.count ?? AI_PLAYLIST.defaultCount))
  const regenerate = body.regenerate === true

  if (!prompt) {
    return new Response(JSON.stringify({ error: 'Missing prompt' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (!isShelfTitleSafe(prompt)) {
    return new Response(JSON.stringify({ error: 'Prompt blocked by content safety filter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const profile = await readProfile()
  const profileSig = hashKey(
    profile.artists.slice(0, 5).map((a) => a.id || a.name).join(',') + '|' + profile.genres.slice(0, 5).join(',')
  )
  // cache-key scheme kept v1-compatible
  const cacheKey = `ai:plgen:v3:${hashKey(prompt.toLowerCase())}:${count}:${profileSig}`

  const enc = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const startedAt = Date.now()
      let closed = false
      const send = (o: unknown) => {
        if (!closed) {
          try { sse(controller, enc, o) } catch { closed = true }
        }
      }
      const abortAll = new AbortController()
      req.signal?.addEventListener('abort', () => abortAll.abort(), { once: true })

      try {
        // ------------------------------------------------------------------
        // 0. Payload cache — repeat generation replays in ~300ms; regenerate
        //    reads the last variant's ids from the same entry instead.
        // ------------------------------------------------------------------
        let cached: CachedPayload | null = null
        try {
          const row = await db.apiCache.findUnique({ where: { key: cacheKey } })
          if (row && row.expiresAt.getTime() > Date.now()) {
            cached = JSON.parse(row.payload) as CachedPayload
          }
        } catch { cached = null }

        if (cached && !regenerate) {
          // replay as a fresh playlist instance
          const playlist = await db.playlist.create({
            data: {
              name: cached.title,
              description: cached.description,
              coverUrl: cached.tracks[0]?.thumbnail || null,
              source: 'ai',
            },
          })
          await Promise.all(cached.tracks.map((t, i) =>
            db.playlistTrack.create({
              data: { playlistId: playlist.id, trackId: t.videoId, position: i },
            }).catch(() => {})
          ))
          send({ type: 'meta', title: cached.title, description: cached.description, intentConfidence: cached.intentConfidence })
          send({ type: 'phase', phase: 'replayed' })
          for (let i = 0; i < cached.tracks.length; i++) {
            send({ type: 'track', track: cached.tracks[i], reason: cached.reasons[cached.tracks[i].videoId] ?? '', index: i })
          }
          send({ type: 'done', playlistId: playlist.id, title: cached.title, total: cached.tracks.length, cached: true, ms: Date.now() - startedAt })
          closed = true
          controller.close()
          return
        }

        // regenerate: exclude 40% of the last variant so the variant differs ≥40%
        const excludeIds = new Set<string>()
        if (regenerate && cached?.lastVariantIds?.length) {
          const ids = cached.lastVariantIds
          for (const id of ids.slice(0, Math.ceil(ids.length * AI_PLAYLIST.regenerateMinDiff))) excludeIds.add(id)
        }

        // pool sizing: 60–120 default; small counts don't over-search
        const poolTarget = count <= 15
          ? Math.max(count * 3, 40)
          : Math.min(AI_PLAYLIST.poolMax, Math.max(AI_PLAYLIST.poolMin, count * 4))
        // floor never exceeds the requested count
        const floor = Math.min(count, AI_PLAYLIST.minCount)

        // ------------------------------------------------------------------
        // S1 UNDERSTAND
        // ------------------------------------------------------------------
        send({ type: 'phase', phase: 'understand' })
        const intent = await parseIntent(prompt, {
          profileArtists: profile.artists.slice(0, 5).map((a) => a.name),
          profileGenres: profile.genres.slice(0, 5),
        })

        // ------------------------------------------------------------------
        // S2 HUNT (deterministic, parallel)
        // ------------------------------------------------------------------
        send({ type: 'phase', phase: 'hunt' })
        const queries = buildQueries(intent, prompt)
        const pool = await huntPool(queries.length ? queries : [prompt], intent, poolTarget, excludeIds, prompt)

        if (!pool.length) {
          send({ type: 'error', message: 'Could not resolve any songs for this prompt. Try a different description.' })
          closed = true
          controller.close()
          return
        }

        // ------------------------------------------------------------------
        // S3 CURATE (LLM, ID-IN/ID-OUT)
        // ------------------------------------------------------------------
        send({ type: 'phase', phase: 'curate' })
        const temperature = regenerate ? 0.92 : 0.75
        let curated = await curateWithLLM(pool, intent, count, {
          temperature, timeoutMs: S3_TIMEOUT_MS, strict: false, signal: abortAll.signal,
        })

        const poolById = new Map(pool.map((t) => [t.id, t]))
        let ordered: PoolTrack[] = []

        const resolvePicks = (picks: CuratedPick[]): PoolTrack[] => {
          const out: PoolTrack[] = []
          const seenLocal = new Set<string>()
          for (const p of picks) {
            const t = poolById.get(p.id) // hallucinated ids dropped SILENTLY
            if (!t || seenLocal.has(t.id)) continue
            seenLocal.add(t.id)
            out.push({ ...t, reason: sanitizeUserText(p.reason, 70) || 'Fits the vibe' })
          }
          return out
        }

        if (curated && curated.picks.length) {
          ordered = resolvePicks(curated.picks)
          // below floor → ONE strict re-ask
          if (ordered.length < floor) {
            const re = await curateWithLLM(pool, intent, count, {
              temperature: 0.5, timeoutMs: S3_REASK_TIMEOUT_MS, strict: true, signal: abortAll.signal,
            })
            if (re && re.picks.length && resolvePicks(re.picks).length > ordered.length) {
              curated = { ...re, name: curated.name || re.name, description: curated.description || re.description }
              ordered = resolvePicks(re.picks)
            }
          }
        } else {
          curated = null
        }
        // still short → deterministic energy-arc top-up (never hard-fail)
        if (ordered.length < count) {
          const targets = arcTargets(count, intent)
          const artistCount = new Map<string, number>()
          for (const t of ordered) {
            const key = t.artist.toLowerCase().trim()
            artistCount.set(key, (artistCount.get(key) ?? 0) + 1)
          }
          ordered = topUpArc(ordered, pool, count, targets, artistCount)
        }

        if (!ordered.length) {
          send({ type: 'error', message: 'Could not resolve any songs for this prompt. Try a different description.' })
          closed = true
          controller.close()
          return
        }

        // ordered emission with per-slot reasons
        const emitList = (list: PoolTrack[]) => {
          for (let i = 0; i < list.length; i++) {
            send({ type: 'track', track: poolToPlayer(list[i]), reason: sanitizeUserText(list[i].reason ?? '', 70), index: i })
          }
        }
        emitList(ordered)

        // ------------------------------------------------------------------
        // S4 POLISH (deterministic) — re-emit the corrected order if changed
        // ------------------------------------------------------------------
        const polished = polishSequence(ordered, intent, floor, pool)
        if (polished.length && polished.some((t, i) => t.id !== ordered[i]?.id)) {
          send({ type: 'phase', phase: 'polish' })
          ordered = polished
          emitList(ordered)
        }

        // ------------------------------------------------------------------
        // S5 NARRATE (tiny LLM, offline-safe)
        // ------------------------------------------------------------------
        send({ type: 'phase', phase: 'narrate' })
        const narration = await narrate(ordered, intent, curated?.name ?? '', curated?.description ?? '', abortAll.signal)
        let title = narration.name
        let description = narration.description
        if (!title) {
          title = titleCase(
            sanitizeUserText(prompt, 60).split(' ').filter(Boolean).slice(0, 5).join(' ')
          ) || 'New Playlist'
        }
        send({ type: 'meta', title, description, intentConfidence: intent.intentConfidence })

        // ------------------------------------------------------------------
        // Persist + cache
        // ------------------------------------------------------------------
        const playlist = await db.playlist.create({
          data: { name: title, description, coverUrl: ordered[0]?.thumbnail || null, source: 'ai' },
        }).catch(() => null)

        if (playlist) {
          await Promise.all(ordered.map((t) =>
            db.track.upsert({
              where: { id: t.id },
              update: { title: t.title, artistName: t.artist, albumName: t.albumName, duration: t.duration, thumbnail: t.thumbnail },
              create: { id: t.id, title: t.title || 'Unknown', artistName: t.artist || 'Unknown artist', duration: t.duration || 0, thumbnail: t.thumbnail, albumName: t.albumName },
            }).catch(() => {})
          ))
          await Promise.all(ordered.map((t, i) =>
            db.playlistTrack.create({
              data: { playlistId: playlist.id, trackId: t.id, position: i },
            }).catch(() => {})
          ))
          const aiPlaylist = await db.aiPlaylist.create({
            data: { prompt, playlistId: playlist.id, model: 'tsf-engine' },
          }).catch(() => null)
          if (aiPlaylist) {
            await Promise.all(ordered.map((t) =>
              db.aiSeedTrack.create({
                data: { aiPlaylistId: aiPlaylist.id, trackId: t.id, reason: sanitizeUserText(t.reason ?? '', 70) },
              }).catch(() => {})
            ))
          }
        }

        try {
          const reasons: Record<string, string> = {}
          for (const t of ordered) reasons[t.id] = sanitizeUserText(t.reason ?? '', 70)
          const payload = JSON.stringify({
            title,
            description,
            tracks: ordered.map(poolToPlayer),
            reasons,
            intentConfidence: intent.intentConfidence,
            lastVariantIds: ordered.map((t) => t.id),
          } satisfies CachedPayload)
          await db.apiCache.upsert({
            where: { key: cacheKey },
            update: { payload, expiresAt: new Date(Date.now() + CACHE_TTL_MS) },
            create: { key: cacheKey, payload, expiresAt: new Date(Date.now() + CACHE_TTL_MS) },
          })
        } catch { /* non-fatal */ }

        send({
          type: 'done',
          playlistId: playlist?.id ?? '',
          title,
          total: ordered.length,
          ms: Date.now() - startedAt,
        })
        closed = true
        controller.close()
      } catch {
        try {
          send({ type: 'error', message: 'Generation failed. Try again.' })
          closed = true
          controller.close()
        } catch { /* stream already closed */ }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
