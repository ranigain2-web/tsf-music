/**
 * MINDBEAT v2.0 — L2 Taste Profile compiler.
 *
 * The ledger (L1) is the source of truth; this file compiles it into the
 * single JSON profile the Decision Engine reads. Rebuildable in <3s, cached
 * in TasteProfileRow (60s TTL) + module memory with stale-while-revalidate.
 *
 * Evidence pipeline (plan §6):
 *   graded listens  → GRADE_WEIGHTS × GRADE_BLAME_SPLIT → artist / track-mood
 *                     accounts, with COMPILE-TIME decay, popularity damping
 *                     (chart giants ÷3) and binge damping (8 listens/day cap)
 *   hearts          → +HEART weight, heart half-life
 *   onboarding      → artists/genres seeded at weight 3.0 (source 'onboarding')
 *   history backfill→ pre-ledger plays with msPlayed > 30s ("30-second rule")
 *   sessions        → daypart cells + coplay edges (the "plays this next to" graph)
 *
 * SERVER-ONLY.
 */

import { db } from '@/lib/db'
import {
  ACTION_WEIGHTS,
  BINGE_CAP_PER_DAY,
  EPSILON,
  GRADE_BLAME_SPLIT,
  GRADE_WEIGHTS,
  HALF_LIFE_DAYS,
  POPULARITY_DAMPING,
  currentDaypart,
  type DaypartBlock,
  type DayKind,
  type ListenRecord,
} from '@/lib/mindbeat/types'
import { getRecentListens } from '@/lib/mindbeat/ledger'
import { getFeatures } from '@/lib/mindbeat/features'

const DAY_MS = 24 * 60 * 60 * 1000
const LEDGER_WINDOW_MS = 90 * DAY_MS
const COMPILE_TTL_MS = 60_000
const CORRECTIONS_KEY = 'mindbeat.corrections'
const MAX_COPLAY_TRACK_EDGES = 5000
const MAX_COPLAY_ARTIST_EDGES = 2000
const POPULARITY_PLAY_THRESHOLD = 50
const FEATURE_LOOKUP_CAP = 300
const BACKFILL_CAP = 2000
/** Old history rows decay gently (they must still "count") — era-like half-life. */
const BACKFILL_HALF_LIFE_DAYS = 120

// ---------------------------------------------------------------------------
// Profile shape (serialized with plain objects — maps never leave this file)
// ---------------------------------------------------------------------------

export type EvidenceSource = 'onboarding' | 'heart' | 'listen'

export interface ArtistEvidence {
  w: number
  lastEventTs: string
  evidenceCount: number
  name: string
  source: EvidenceSource
}

export interface WeightedEvidence {
  w: number
  lastEventTs: string
  evidenceCount: number
  source?: string
}

export interface Pref {
  mean: number
  std: number
  n: number
}

export interface DaypartCell {
  artists: Record<string, number>
  genres: Record<string, number>
  energyMean: number | null
  energyStd: number | null
  valenceMean: number | null
  sessionCount: number
}

export interface Corrections {
  mutedArtists: string[]
  mutedTracks: string[]
  boosts: Record<string, number>
  wrongLabels: string[]
}

export interface TasteProfileData {
  artists: Record<string, ArtistEvidence>
  genres: Record<string, WeightedEvidence>
  languages: Record<string, WeightedEvidence>
  eras: Record<string, WeightedEvidence>
  /** Mood-tag space from TrackFeature — feeds the compact summary's topMoods. */
  moods: Record<string, WeightedEvidence>
  proxy: { energyPref: Pref; valencePref: Pref }
  daypart: Record<string, DaypartCell>
  skipProfiles: Record<string, { buckets: number[]; listens: number }>
  coplayTracks: Record<string, Record<string, number>>
  coplayArtists: Record<string, Record<string, number>>
  exploration: { epsilon: number; noveltyServed: number; noveltyConverted: number }
  corrections: Corrections
  sessionCount: number
  compiledAt: string
}

// ---------------------------------------------------------------------------
// Cache (row + memory, stale-while-revalidate)
// ---------------------------------------------------------------------------

let memCache: { data: TasteProfileData; at: number } | null = null
let rebuilding: Promise<TasteProfileData> | null = null

function emptyProfile(): TasteProfileData {
  return {
    artists: {},
    genres: {},
    languages: {},
    eras: {},
    moods: {},
    proxy: {
      energyPref: { mean: 0.5, std: 0, n: 0 },
      valencePref: { mean: 0.5, std: 0, n: 0 },
    },
    daypart: {},
    skipProfiles: {},
    coplayTracks: {},
    coplayArtists: {},
    exploration: { epsilon: EPSILON.coldStart, noveltyServed: 0, noveltyConverted: 0 },
    corrections: { mutedArtists: [], mutedTracks: [], boosts: {}, wrongLabels: [] },
    sessionCount: 0,
    compiledAt: new Date(0).toISOString(),
  }
}

function parseProfile(raw: string): TasteProfileData {
  try {
    const j = JSON.parse(raw) as Partial<TasteProfileData>
    return { ...emptyProfile(), ...j, corrections: { ...emptyProfile().corrections, ...(j.corrections ?? {}) } }
  } catch {
    return emptyProfile()
  }
}

async function rebuild(): Promise<TasteProfileData> {
  if (rebuilding) return rebuilding
  rebuilding = buildProfile()
    .then(async (data) => {
      const json = JSON.stringify(data)
      await db.tasteProfileRow
        .upsert({ where: { id: 'main' }, update: { data: json }, create: { id: 'main', data: json } })
        .catch(() => {})
      memCache = { data, at: Date.now() }
      return data
    })
    .finally(() => {
      rebuilding = null
    })
  return rebuilding
}

/**
 * Compile (or serve the cached) taste profile. Fresh within 60s → cached.
 * Stale but present in memory → served immediately while a rebuild runs in
 * the background (stale-while-revalidate). force=true always rebuilds.
 */
export async function compileProfile(force = false): Promise<TasteProfileData> {
  const nowMs = Date.now()
  if (!force && memCache && nowMs - memCache.at < COMPILE_TTL_MS) return memCache.data
  if (!force) {
    const row = await db.tasteProfileRow.findUnique({ where: { id: 'main' } }).catch(() => null)
    if (row && nowMs - row.updatedAt.getTime() < COMPILE_TTL_MS) {
      const data = parseProfile(row.data)
      memCache = { data, at: nowMs }
      return data
    }
    if (memCache) {
      void rebuild().catch(() => {}) // SWR: serve stale, refresh behind it
      return memCache.data
    }
  }
  return rebuild()
}

// ---------------------------------------------------------------------------
// Corrections (persisted in Setting so they survive rebuilds)
// ---------------------------------------------------------------------------

export async function loadCorrections(): Promise<Corrections> {
  const row = await db.setting.findUnique({ where: { key: CORRECTIONS_KEY } }).catch(() => null)
  if (!row) return { mutedArtists: [], mutedTracks: [], boosts: {}, wrongLabels: [] }
  try {
    const j = JSON.parse(row.value)
    return {
      mutedArtists: Array.isArray(j.mutedArtists) ? j.mutedArtists.map(String) : [],
      mutedTracks: Array.isArray(j.mutedTracks) ? j.mutedTracks.map(String) : [],
      boosts: j.boosts && typeof j.boosts === 'object' ? j.boosts : {},
      wrongLabels: Array.isArray(j.wrongLabels) ? j.wrongLabels.map(String) : [],
    }
  } catch {
    return { mutedArtists: [], mutedTracks: [], boosts: {}, wrongLabels: [] }
  }
}

async function saveCorrections(c: Corrections): Promise<void> {
  await db.setting
    .upsert({
      where: { key: CORRECTIONS_KEY },
      update: { value: JSON.stringify(c) },
      create: { key: CORRECTIONS_KEY, value: JSON.stringify(c) },
    })
    .catch(() => {})
}

export type CorrectionAction = 'mute' | 'boost' | 'wrong' | 'reset'

/** Apply a listener correction, then force-rebuild so the engine sees it. */
export async function applyCorrection(
  action: CorrectionAction,
  target?: string,
  kind?: 'artist' | 'track'
): Promise<Corrections> {
  const c = await loadCorrections()
  const pushUnique = (arr: string[], v: string) => {
    if (!arr.includes(v)) arr.push(v)
  }
  if (action === 'reset') {
    c.mutedArtists = []
    c.mutedTracks = []
    c.boosts = {}
    c.wrongLabels = []
  } else if (action === 'mute' && target) {
    if (kind === 'track') pushUnique(c.mutedTracks, target)
    else pushUnique(c.mutedArtists, target)
  } else if (action === 'boost' && target) {
    c.boosts[target] = (c.boosts[target] ?? 1) * 2
  } else if (action === 'wrong' && target) {
    pushUnique(c.wrongLabels, kind ? `${kind}:${target}` : target)
  }
  await saveCorrections(c)
  await compileProfile(true)
  return c
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

interface Acc {
  w: number
  lastTs: number
  count: number
  name?: string
  source: EvidenceSource
}

const SOURCE_RANK: Record<EvidenceSource, number> = { listen: 0, heart: 1, onboarding: 2 }

function acc(map: Map<string, Acc>, key: string, name?: string): Acc {
  let a = map.get(key)
  if (!a) {
    a = { w: 0, lastTs: 0, count: 0, name, source: 'listen' }
    map.set(key, a)
  }
  if (name && !a.name) a.name = name
  return a
}

function addEvidence(
  map: Map<string, Acc>,
  key: string,
  opts: { w: number; ts: number; name?: string; source?: EvidenceSource }
): void {
  if (!key) return
  const a = acc(map, key, opts.name)
  a.w += opts.w
  a.count += 1
  a.lastTs = Math.max(a.lastTs, opts.ts)
  if (opts.source && SOURCE_RANK[opts.source] > SOURCE_RANK[a.source]) a.source = opts.source
}

interface SampleAcc {
  n: number
  sum: number
  sumSq: number
}

function pushSample(s: SampleAcc, v: number): void {
  s.n += 1
  s.sum += v
  s.sumSq += v * v
}

function finalizeSample(s: SampleAcc): Pref {
  if (!s.n) return { mean: 0.5, std: 0, n: 0 }
  const mean = s.sum / s.n
  const variance = Math.max(0, s.sumSq / s.n - mean * mean)
  return { mean, std: Math.sqrt(variance), n: s.n }
}

function eraBucketOf(year: number): string | null {
  if (!year || year < 1900) return null
  if (year < 1980) return 'pre-80s'
  if (year < 1990) return '80s'
  if (year < 2000) return '90s'
  if (year < 2010) return '2000s'
  if (year < 2020) return '2010s'
  return 'current'
}

function decayed(weight: number, tsMs: number, nowMs: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, nowMs - tsMs) / DAY_MS
  return weight * Math.pow(0.5, ageDays / halfLifeDays)
}

/** Cap coplay graphs to their strongest N edges (contract caps). */
function capEdges(
  edges: Map<string, Map<string, number>>,
  cap: number
): Record<string, Record<string, number>> {
  const flat: { a: string; b: string; w: number }[] = []
  for (const [a, nbrs] of edges) for (const [b, w] of nbrs) flat.push({ a, b, w })
  flat.sort((x, y) => y.w - x.w)
  const out: Record<string, Record<string, number>> = {}
  for (const { a, b, w } of flat.slice(0, cap)) {
    ;(out[a] ??= {})[b] = Math.round(w * 1000) / 1000
  }
  return out
}

async function buildProfile(): Promise<TasteProfileData> {
  const nowMs = Date.now()
  const profile = emptyProfile()

  // ---- inputs -------------------------------------------------------------
  const listens = await getRecentListens(LEDGER_WINDOW_MS)
  const corrections = await loadCorrections()
  const mutedTracks = new Set(corrections.mutedTracks)
  const mutedArtists = new Set(corrections.mutedArtists)
  const effectiveListens = listens.filter((l) => !mutedTracks.has(l.trackId))

  const listenTrackIds = [...new Set(effectiveListens.map((l) => l.trackId))].slice(0, FEATURE_LOOKUP_CAP)
  const [trackRows, features, likes, onboardingArtists, onboardingGenres, backfill, sessionRows, sessionCount] =
    await Promise.all([
      listenTrackIds.length
        ? db.track
            .findMany({
              where: { id: { in: listenTrackIds } },
              select: { id: true, artistId: true, artistName: true, year: true },
            })
            .catch(() => [])
        : Promise.resolve([]),
      listenTrackIds.length ? getFeatures(listenTrackIds) : Promise.resolve(new Map()),
      db.like.findMany({ include: { track: { select: { id: true, artistId: true, artistName: true } } } }).catch(() => []),
      db.setting
        .findUnique({ where: { key: 'profile.artists' } })
        .then((r) => (r ? (JSON.parse(r.value) as { id: string; name: string }[]) : []))
        .catch(() => [] as { id: string; name: string }[]),
      db.setting
        .findUnique({ where: { key: 'profile.genres' } })
        .then((r) => (r ? (JSON.parse(r.value) as string[]) : []))
        .catch(() => [] as string[]),
      db.historyItem
        .findMany({
          where: { playedAt: { lt: new Date(nowMs - LEDGER_WINDOW_MS) }, msPlayed: { gt: 30_000 } },
          include: { track: { select: { id: true, artistId: true, artistName: true, year: true } } },
          orderBy: { playedAt: 'desc' },
          take: BACKFILL_CAP,
        })
        .catch(() => []),
      db.listenSession.findMany({ select: { id: true, daypart: true, dayKind: true } }).catch(() => []),
      db.listenSession.count().catch(() => 0),
    ])

  const trackById = new Map(trackRows.map((t): [string, { artistId: string | null; artistName: string; year: number | null }] => [t.id, t]))
  const sessionById = new Map(sessionRows.map((s): [string, { id: string; daypart: string; dayKind: string }] => [s.id, s]))

  // play counts for popularity damping (chart-giant proxy) and edge damping
  const playsByArtist = new Map<string, number>()
  const playsByTrack = new Map<string, number>()
  for (const l of effectiveListens) {
    playsByTrack.set(l.trackId, (playsByTrack.get(l.trackId) ?? 0) + 1)
    const key = artistKeyOf(l, trackById.get(l.trackId))
    if (key) playsByArtist.set(key, (playsByArtist.get(key) ?? 0) + 1)
  }

  // per-artist-per-day listen counts for binge damping
  const dayCounts = new Map<string, number>() // artist|YYYY-MM-DD → count
  for (const l of effectiveListens) {
    const key = artistKeyOf(l, trackById.get(l.trackId))
    if (!key) continue
    const day = new Date(l.startedTs).toISOString().slice(0, 10)
    const k = `${key}|${day}`
    dayCounts.set(k, (dayCounts.get(k) ?? 0) + 1)
  }

  // ---- evidence from graded listens --------------------------------------
  const artists = new Map<string, Acc>()
  const genres = new Map<string, Acc>()
  const languages = new Map<string, Acc>()
  const eras = new Map<string, Acc>()
  const moods = new Map<string, Acc>()

  const energySamples: SampleAcc = { n: 0, sum: 0, sumSq: 0 }
  const valenceSamples: SampleAcc = { n: 0, sum: 0, sumSq: 0 }

  interface CellAcc extends DaypartCell {
    energy: SampleAcc
    valence: SampleAcc
    sessions: Set<string>
  }
  const cells = new Map<string, CellAcc>()
  const cellOf = (key: string): CellAcc => {
    let c = cells.get(key)
    if (!c) {
      c = {
        artists: {}, genres: {}, energyMean: null, energyStd: null, valenceMean: null, sessionCount: 0,
        energy: { n: 0, sum: 0, sumSq: 0 }, valence: { n: 0, sum: 0, sumSq: 0 }, sessions: new Set(),
      }
      cells.set(key, c)
    }
    return c
  }

  // coplay graph accumulation
  const coplayTracks = new Map<string, Map<string, number>>()
  const coplayArtists = new Map<string, Map<string, number>>()

  for (const l of effectiveListens) {
    const track = trackById.get(l.trackId)
    const aKey = artistKeyOf(l, track)
    const feat = features.get(l.trackId)
    const startedMs = Date.parse(l.startedTs)
    const w = GRADE_WEIGHTS[l.grade]
    const split = GRADE_BLAME_SPLIT[l.grade]

    // binge damping: per-artist-per-day evidence capped at BINGE_CAP_PER_DAY listens' worth
    let bingeScale = 1
    if (aKey) {
      const day = new Date(l.startedTs).toISOString().slice(0, 10)
      const cnt = dayCounts.get(`${aKey}|${day}`) ?? 1
      if (cnt > BINGE_CAP_PER_DAY) bingeScale = BINGE_CAP_PER_DAY / cnt
    }

    // artist account
    if (aKey) {
      const artistW = decayed(w, startedMs, nowMs, HALF_LIFE_DAYS.artist) * split.artist * bingeScale
      addEvidence(artists, aKey, { w: artistW, ts: startedMs, name: artistNameOf(l, track), source: 'listen' })
    }

    // track-mood account → mood tags feed moods (and genre-space tags)
    const trackW = decayed(w, startedMs, nowMs, HALF_LIFE_DAYS.genre) * (split.track + split.mood)
    let moodTags: string[] = []
    try {
      moodTags = feat?.moodTags ? (JSON.parse(feat.moodTags) as string[]) : []
    } catch {
      moodTags = []
    }
    for (const tag of moodTags) {
      addEvidence(moods, tag, { w: trackW, ts: startedMs, source: 'listen' })
      addEvidence(genres, tag, { w: trackW, ts: startedMs, source: 'listen' })
    }

    // language + era accounts (track attributes — full-grade evidence)
    if (feat?.language && feat.language !== 'unknown') {
      addEvidence(languages, feat.language, {
        w: decayed(w, startedMs, nowMs, HALF_LIFE_DAYS.language),
        ts: startedMs,
        source: 'listen',
      })
    }
    const era = track?.year ? eraBucketOf(track.year) : null
    if (era) {
      addEvidence(eras, era, {
        w: decayed(w, startedMs, nowMs, HALF_LIFE_DAYS.era),
        ts: startedMs,
        source: 'listen',
      })
    }

    // proxy preference samples: successful listens describe what energy you want
    if (l.grade === 'COMPLETED' || l.grade === 'LATE_SKIP') {
      const e = feat?.effEnergy ?? feat?.energy
      const v = feat?.effValence ?? feat?.valence
      if (e !== null && e !== undefined) pushSample(energySamples, e)
      if (v !== null && v !== undefined) pushSample(valenceSamples, v)
    }

    // daypart cell
    const session = sessionById.get(l.sessionId)
    if (session) {
      const cellKey = `${session.daypart}|${session.dayKind}`
      const cell = cellOf(cellKey)
      cell.sessions.add(l.sessionId)
      if (aKey) {
        const cellW = decayed(w, startedMs, nowMs, HALF_LIFE_DAYS.daypartCell) * split.artist * bingeScale
        cell.artists[aKey] = (cell.artists[aKey] ?? 0) + cellW
      }
      for (const tag of moodTags) {
        cell.genres[tag] = (cell.genres[tag] ?? 0) + trackW
      }
      const e = feat?.effEnergy ?? feat?.energy
      const v = feat?.effValence ?? feat?.valence
      if (e !== null && e !== undefined) pushSample(cell.energy, e)
      if (v !== null && v !== undefined) pushSample(cell.valence, v)
    }
  }

  // exploration counters
  let noveltyServed = 0
  let noveltyConverted = 0
  for (const l of effectiveListens) {
    if (!l.wasRecommended) continue
    noveltyServed += 1
    if (l.grade === 'COMPLETED' || l.grade === 'LATE_SKIP') noveltyConverted += 1
  }

  // ---- coplay edges ("you keep playing this next to") ---------------------
  const bySession = new Map<string, ListenRecord[]>()
  for (const l of effectiveListens) {
    const arr = bySession.get(l.sessionId) ?? []
    arr.push(l)
    bySession.set(l.sessionId, arr)
  }
  for (const sessionListens of bySession.values()) {
    const ordered = [...sessionListens].sort((a, b) => a.startedTs.localeCompare(b.startedTs))
    for (let i = 0; i + 1 < ordered.length; i++) {
      const A = ordered[i]
      const B = ordered[i + 1]
      if (A.listenedMs < 60_000 || B.listenedMs < 60_000) continue
      const gap = Date.parse(B.startedTs) - (Date.parse(A.startedTs) + A.listenedMs)
      if (gap > 90_000 || gap < -5_000) continue
      addEdge(coplayTracks, A.trackId, B.trackId, 1)
      addEdge(coplayTracks, B.trackId, A.trackId, 1)
      const aA = artistKeyOf(A, trackById.get(A.trackId))
      const aB = artistKeyOf(B, trackById.get(B.trackId))
      if (aA && aB && aA !== aB) {
        addEdge(coplayArtists, aA, aB, 1)
        addEdge(coplayArtists, aB, aA, 1)
      }
    }
  }

  // popularity-damp edges: w / (1 + ln(playsA + playsB))
  dampEdges(coplayTracks, playsByTrack)
  dampEdges(coplayArtists, playsByArtist)

  // ---- hearts (likes) ------------------------------------------------------
  for (const like of likes) {
    const t = like.track
    if (!t || mutedTracks.has(t.id)) continue
    const key = t.artistId || t.artistName
    if (!key) continue
    const ts = like.createdAt.getTime()
    addEvidence(artists, key, {
      w: decayed(ACTION_WEIGHTS.HEART, ts, nowMs, HALF_LIFE_DAYS.heart),
      ts,
      name: t.artistName,
      source: 'heart',
    })
  }

  // ---- onboarding seeds ----------------------------------------------------
  for (const a of onboardingArtists) {
    if (!a?.id) continue
    addEvidence(artists, a.id, { w: 3.0, ts: nowMs, name: a.name, source: 'onboarding' })
  }
  for (const g of onboardingGenres) {
    if (!g) continue
    addEvidence(genres, g, { w: 3.0, ts: nowMs, source: 'onboarding' })
  }

  // ---- history backfill (the "30-second rule") ----------------------------
  for (const h of backfill) {
    const t = h.track
    if (!t || mutedTracks.has(t.id)) continue
    const key = t.artistId || t.artistName
    if (!key) continue
    const ts = h.playedAt.getTime()
    // COMPLETED artist share (2.0 × 0.6) decayed gently so old taste still counts
    addEvidence(artists, key, { w: decayed(1.2, ts, nowMs, BACKFILL_HALF_LIFE_DAYS), ts, name: t.artistName, source: 'listen' })
    const era = t.year ? eraBucketOf(t.year) : null
    if (era) addEvidence(eras, era, { w: decayed(1.0, ts, nowMs, BACKFILL_HALF_LIFE_DAYS), ts, source: 'listen' })
  }

  // ---- popularity damping (chart giants must earn 3× the evidence) --------
  for (const [key, a] of artists) {
    if ((playsByArtist.get(key) ?? 0) >= POPULARITY_PLAY_THRESHOLD) a.w /= POPULARITY_DAMPING
  }

  // ---- boosts & mutes from corrections ------------------------------------
  for (const [key, boost] of Object.entries(corrections.boosts)) {
    const a = artists.get(key)
    if (a) a.w *= boost
    const g = genres.get(key)
    if (g) g.w *= boost
  }
  for (const key of mutedArtists) {
    artists.delete(key)
  }

  // ---- merge name-keyed into browseId-keyed duplicates ---------------------
  // Onboarding seeds use browseIds ("UCPC0L1…"); ledger listens may key by
  // display name ("Taylor Swift"). Same artist must be ONE row — fold the
  // name-keyed evidence into its browseId twin (prefer the id row).
  {
    const byName = new Map<string, string[]>()
    for (const [key, a] of artists) {
      const norm = (a.name ?? key).trim().toLowerCase()
      if (!norm) continue
      const arr = byName.get(norm) ?? []
      arr.push(key)
      byName.set(norm, arr)
    }
    for (const keys of byName.values()) {
      if (keys.length < 2) continue
      const keeper =
        keys.find((k) => /^UC[a-zA-Z0-9_-]{10,}$/.test(k)) ?? keys[0]
      const keep = artists.get(keeper)!
      for (const k of keys) {
        if (k === keeper) continue
        const dup = artists.get(k)
        if (!dup) continue
        keep.w += dup.w
        keep.count += dup.count
        keep.lastTs = Math.max(keep.lastTs ?? 0, dup.lastTs ?? 0)
        if (!keep.name && dup.name) keep.name = dup.name
        artists.delete(k)
      }
    }
  }

  // ---- assemble serializable profile --------------------------------------
  for (const [key, a] of artists) {
    profile.artists[key] = {
      w: round(a.w),
      lastEventTs: new Date(a.lastTs || nowMs).toISOString(),
      evidenceCount: a.count,
      name: a.name ?? key,
      source: a.source,
    }
  }
  profile.genres = serializeAcc(genres, nowMs)
  profile.languages = serializeAcc(languages, nowMs)
  profile.eras = serializeAcc(eras, nowMs)
  profile.moods = serializeAcc(moods, nowMs)
  profile.proxy = { energyPref: finalizeSample(energySamples), valencePref: finalizeSample(valenceSamples) }

  for (const [key, c] of cells) {
    profile.daypart[key] = {
      artists: roundMap(c.artists),
      genres: roundMap(c.genres),
      energyMean: c.energy.n ? round(c.energy.sum / c.energy.n) : null,
      energyStd: c.energy.n ? round(Math.sqrt(Math.max(0, c.energy.sumSq / c.energy.n - (c.energy.sum / c.energy.n) ** 2))) : null,
      valenceMean: c.valence.n ? round(c.valence.sum / c.valence.n) : null,
      sessionCount: c.sessions.size,
    }
  }

  // skip profiles — position histogram of where the listener leaves each track
  for (const l of effectiveListens) {
    const sp = (profile.skipProfiles[l.trackId] ??= { buckets: new Array<number>(10).fill(0), listens: 0 })
    sp.buckets[Math.max(0, Math.min(9, (l.skipBucket ?? 10) - 1))] += 1
    sp.listens += 1
  }

  profile.coplayTracks = capEdges(coplayTracks, MAX_COPLAY_TRACK_EDGES)
  profile.coplayArtists = capEdges(coplayArtists, MAX_COPLAY_ARTIST_EDGES)

  profile.exploration = {
    epsilon: sessionCount <= EPSILON.coldStartSessions ? EPSILON.coldStart : EPSILON.established,
    noveltyServed,
    noveltyConverted,
  }
  profile.corrections = corrections
  profile.sessionCount = sessionCount
  profile.compiledAt = new Date().toISOString()

  return profile
}

// ---------------------------------------------------------------------------
// Compact summary (default profile-route payload)
// ---------------------------------------------------------------------------

export interface CompactProfile {
  topArtists: { id: string; name: string; weight: number }[]
  topGenres: { id: string; weight: number }[]
  topLanguages: { id: string; weight: number }[]
  topMoods: { id: string; weight: number }[]
  daypart: {
    block: DaypartBlock
    dayKind: DayKind
    topArtists: { id: string; name: string; weight: number }[]
    energyMean: number | null
  }
  sessionCount: number
  epsilon: number
  corrections: Corrections
}

export function compactSummary(p: TasteProfileData): CompactProfile {
  const topOf = <T>(entries: [string, T][], n: number) =>
    entries
      .filter(([, e]) => (e as { w: number }).w > 0)
      .sort((a, b) => (b[1] as { w: number }).w - (a[1] as { w: number }).w)
      .slice(0, n)

  const topArtists = topOf(Object.entries(p.artists), 10).map(([id, e]) => ({ id, name: e.name, weight: round(e.w) }))
  const topGenres = topOf(Object.entries(p.genres), 8).map(([id, e]) => ({ id, weight: round(e.w) }))
  const topLanguages = topOf(Object.entries(p.languages), 6).map(([id, e]) => ({ id, weight: round(e.w) }))
  const topMoods = topOf(Object.entries(p.moods), 6).map(([id, e]) => ({ id, weight: round(e.w) }))

  const now = currentDaypart(new Date())
  const cell = p.daypart[`${now.block}|${now.dayKind}`]
  const daypartTop = cell
    ? Object.entries(cell.artists)
        .filter(([, w]) => w > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, w]) => ({ id, name: p.artists[id]?.name ?? id, weight: round(w) }))
    : []

  return {
    topArtists,
    topGenres,
    topLanguages,
    topMoods,
    daypart: {
      block: now.block,
      dayKind: now.dayKind,
      topArtists: daypartTop,
      energyMean: cell?.energyMean ?? null,
    },
    sessionCount: p.sessionCount,
    epsilon: p.exploration.epsilon,
    corrections: p.corrections,
  }
}

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

function artistKeyOf(l: ListenRecord, track?: { artistId: string | null; artistName: string } | null): string | null {
  // stable id first (catalog), then ledger ids, then the richest NAME available —
  // the ledger payload beats a mirrored stub's "Unknown artist"
  return (track?.artistId || l.artistId || l.artistName || track?.artistName || null) ?? null
}

function artistNameOf(l: ListenRecord, track?: { artistName: string } | null): string | undefined {
  return l.artistName ?? track?.artistName
}

function addEdge(edges: Map<string, Map<string, number>>, a: string, b: string, w: number): void {
  if (!a || !b || a === b) return
  let nbrs = edges.get(a)
  if (!nbrs) {
    nbrs = new Map()
    edges.set(a, nbrs)
  }
  nbrs.set(b, (nbrs.get(b) ?? 0) + w)
}

function dampEdges(edges: Map<string, Map<string, number>>, plays: Map<string, number>): void {
  for (const [a, nbrs] of edges) {
    const pA = plays.get(a) ?? 0
    for (const [b, w] of nbrs) {
      const pB = plays.get(b) ?? 0
      nbrs.set(b, w / (1 + Math.log(pA + pB)))
    }
  }
}

function serializeAcc(map: Map<string, Acc>, nowMs: number): Record<string, WeightedEvidence> {
  const out: Record<string, WeightedEvidence> = {}
  for (const [key, a] of map) {
    out[key] = {
      w: round(a.w),
      lastEventTs: new Date(a.lastTs || nowMs).toISOString(),
      evidenceCount: a.count,
      ...(a.source !== 'listen' || a.name ? { source: a.source } : {}),
    }
  }
  return out
}

function roundMap(m: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(m)) out[k] = round(v)
  return out
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000
}
