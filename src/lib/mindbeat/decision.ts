/**
 * MINDBEAT v2.0 — L4 DECISION ENGINE.
 *
 * THE single authority for "what should we play next". Surfaces never read
 * the raw ledger — they call this engine (directly server-side or through
 * /api/mindbeat/* routes). This engine READS memory (profile, session,
 * ledger reads) and NEVER writes it.
 *
 * Score = w1·ProfileAffinity + w2·SessionFit + w3·DaypartFit + w4·Freshness
 *         + w5·SourceTrust + δ(explore) − Penalties
 * with SCORE_WEIGHTS from the constitution (w2 1.2 > w1 1.0 by design:
 * reading the room beats knowing the person).
 *
 * Determinism: same (profile, session, block, seed) → same order. Ties break
 * by (score desc, videoId asc); exploration uses a stable hash of
 * sessionId+slot as jitter — never Math.random().
 *
 * Reason codes follow the §8.5 truth-condition table: a line is attached
 * ONLY when its condition is actually true. Social proof is banned forever.
 *
 * SERVER-ONLY (reads the ledger through 13-a's exported helpers).
 */

import {
  EPSILON,
  HALF_LIFE_DAYS,
  REASON_CODES,
  currentDaypart,
  SAME_ARTIST_PER_6_SLOTS,
  SCORE_WEIGHTS,
  SESSION_ENERGY_TOLERANCE,
  SKIP_STORM_THRESHOLD,
  type DayKind,
  type DaypartBlock,
  type EnginePick,
  type ListenRecord,
  type ReasonCode,
  type SourceSurface,
  type VibeState,
} from '@/lib/mindbeat/types'
import type { TasteProfileData } from '@/lib/mindbeat/profile'
import { getRecentListens, type SessionContext } from '@/lib/mindbeat/ledger'

// ---------------------------------------------------------------------------
// Tunables (documented here — constitution values always win when present)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
const FRESH_WINDOW_MS = 7 * DAY_MS
const READS_TTL_MS = 30_000

// ProfileAffinity blending
const GENRE_BLEND = 0.6      // genre affinity enters at 0.6× (constitution §8.3)
const GENRE_SHARE = 0.3      // …inside a 30% share of the affinity component
const MOOD_SHARE = 0.25      // proxy mood-proximity share of the affinity component

// SessionFit
const SAME_ARTIST_EXTRA_PENALTY = 0.8   // per appearance beyond SAME_ARTIST_PER_6_SLOTS
const MOOD_CELL_BONUS = 0.3             // constitution §8.3 mood-cell match bonus
const STORM_NEIGHBOR_BONUS = 0.2        // SKIP_STORM: prefer last-completed neighbors

// DaypartFit
const BLOCK_ARTIST_BONUS = 0.2
const DAYPART_DATA_MIN_SESSIONS = 3     // cell needs ≥3 sessions to be trusted

// Freshness
const NEVER_PLAYED_BONUS = 0.4          // novelty
const SERVED_TWICE_7D_PENALTY = 0.9
const RECENT_PLAY_PENALTY_PER = 0.3
const RECENT_PLAY_PENALTY_MAX = 0.6
const PLAYED_TODAY_PENALTY = 0.2
const PLAYED_THIS_WEEK_PENALTY = 0.1

// Exploration
const EXPLORE_BONUS = 0.3               // δ(explore)
const DIVISIVE_OPEN_BUCKET_DENSITY = 0.5 // bucket-1 density above which a track may not open
const PREVIEW_PENALTY = 0.8

// Trust mapping: candidate pool → the surface whose completion history we read
const POOL_SURFACE: Record<PoolKind, SourceSurface> = {
  affinity: 'daily_mix',
  neighborhood: 'radio',
  daypart: 'daylist',
  cultural: 'ai_playlist',
  discovery: 'discovery',
}

const POOL_PRIORITY: Record<PoolKind, number> = {
  affinity: 0,
  neighborhood: 1,
  daypart: 2,
  cultural: 3,
  discovery: 4,
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type PoolKind = 'affinity' | 'neighborhood' | 'daypart' | 'cultural' | 'discovery'

export interface CandidateFeatures {
  energy: number
  valence: number
  tempoClass?: string
  moodTags?: string[]
  language?: string
}

export interface CandidatePool {
  videoId: string
  title: string
  artistName: string
  artistId?: string
  duration?: number
  thumbnail?: string
  pool: PoolKind
  features?: CandidateFeatures
}

/** Ledger-derived read state the engine scores against (never mutated). */
export interface EngineReads {
  nowMs: number
  lastListenByTrack: Map<string, number>
  plays7dByTrack: Map<string, number>
  replays7d: Set<string> // ≥2 plays within 7d → BACK_FOR_MORE truth
  /** exponentially-weighted completion rate per surface (half-life 21d) */
  trustBySurface: Map<string, number>
}

export interface NeighborAnchor {
  videoId: string
  title?: string
}

export interface DecideExtraOpts {
  surface?: SourceSurface
  /** stable jitter seed (defaults to sessionId ?? 'tsf') — determinism contract */
  seed?: string
  exclude?: Iterable<string>
  /** known preview-only tracks → −0.8 (optional StreamCache knowledge) */
  previewOnly?: Iterable<string>
  /** known-unplayable tracks → hard block */
  unplayable?: Iterable<string>
  reads?: EngineReads
  /** mean energy of the current session window (from client payload or ledger) */
  sessionEnergy?: number
  /** recent session energies, oldest → newest (feeds computeVibe) */
  energies?: number[]
  /** seed tracks with titles — anchors for truth-conditioned NEIGHBOR lines */
  neighborAnchors?: NeighborAnchor[]
  /** kill switch (plan §10.4): exploration disabled → ε forced to 0, no
   *  FRESH_FIND/explore slots anywhere. Everything else behaves identically. */
  exploreOff?: boolean
}

export interface DecideOpts {
  pool: CandidatePool[]
  session: SessionContext
  profile: TasteProfileData
  block: { block: DaypartBlock; dayKind: DayKind }
  count: number
  opts?: DecideExtraOpts
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** FNV-1a → [0,1). Deterministic jitter for exploration slot selection. */
function hash01(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 0x100000000
}

function ageDays(iso: string, nowMs: number): number {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, (nowMs - t) / DAY_MS)
}

/** Read-time decay (constitution §Decay): effective = w · 0.5^(age/halfLife). */
function decayed(w: number, tsMs: number, nowMs: number, halfLifeDays: number): number {
  return w * Math.pow(0.5, Math.max(0, nowMs - tsMs) / DAY_MS / halfLifeDays)
}

function bandOf(energy: number): 'calm' | 'mid' | 'energetic' {
  if (energy < 0.35) return 'calm'
  if (energy <= 0.65) return 'mid'
  return 'energetic'
}

function artistKeyOfListen(l: ListenRecord): string | null {
  return l.artistId || l.artistName || null
}

function renderReason(code: ReasonCode, vars: { artist?: string; track?: string; block?: string }): string {
  const tpl = REASON_CODES[code]
  return tpl
    .replace('{artist}', vars.artist ?? 'this artist')
    .replace('{track}', vars.track ?? 'a recent track')
    .replace('{block}', vars.block ?? 'daypart')
}

function emptyReads(): EngineReads {
  return {
    nowMs: Date.now(),
    lastListenByTrack: new Map(),
    plays7dByTrack: new Map(),
    replays7d: new Set(),
    trustBySurface: new Map(),
  }
}

// ---------------------------------------------------------------------------
// Engine reads — the ONLY ledger access, cached 30s, read-only
// ---------------------------------------------------------------------------

let readsCache: { reads: EngineReads; at: number } | null = null

/**
 * Derive per-track freshness + per-surface trust from the ledger.
 * Cached for 30s (the engine never writes; this is a pure read view).
 */
export async function getEngineReads(): Promise<EngineReads> {
  if (readsCache && Date.now() - readsCache.at < READS_TTL_MS) return readsCache.reads
  let listens: ListenRecord[] = []
  try {
    listens = await getRecentListens()
  } catch {
    listens = []
  }

  const nowMs = Date.now()
  const reads = emptyReads()
  reads.nowMs = nowMs

  // trust accumulators: weighted successes / weighted total per surface
  const trust = new Map<string, { succ: number; total: number }>()

  for (const l of listens) {
    const tsMs = Date.parse(l.startedTs)
    if (!Number.isFinite(tsMs)) continue
    // freshness
    const prev = reads.lastListenByTrack.get(l.trackId)
    if (prev === undefined || tsMs > prev) reads.lastListenByTrack.set(l.trackId, tsMs)
    if (nowMs - tsMs <= FRESH_WINDOW_MS) {
      reads.plays7dByTrack.set(l.trackId, (reads.plays7dByTrack.get(l.trackId) ?? 0) + 1)
    }
    // trust (surface may be absent for user-initiated plays — still tracked)
    if (l.surface) {
      const w = decayed(1, tsMs, nowMs, HALF_LIFE_DAYS.sourceTrust)
      const acc = trust.get(l.surface) ?? { succ: 0, total: 0 }
      acc.total += w
      if (l.grade === 'COMPLETED' || l.grade === 'LATE_SKIP') acc.succ += w
      trust.set(l.surface, acc)
    }
  }
  reads.plays7dByTrack.forEach((n, id) => {
    if (n >= 2) reads.replays7d.add(id)
  })
  trust.forEach((acc, surface) => {
    reads.trustBySurface.set(surface, acc.total > 0 ? clamp01(acc.succ / acc.total) : 0.5)
  })

  readsCache = { reads, at: Date.now() }
  return reads
}

// ---------------------------------------------------------------------------
// Vibe state (constitution §7.2)
// ---------------------------------------------------------------------------

export interface VibeOpts {
  /** recent session energies, oldest → newest */
  energies?: number[]
  surface?: SourceSurface
  now?: Date
}

/**
 * §7.2 vibe machine:
 *   SKIP_STORM  ≥3 INSTANT_REJECT in the last 6 listens
 *   PEAK        energy ≥0.8 sustained 3, inside FLOW
 *   FLOW        completionRate ≥0.7 over the last 4 graded listens
 *   WIND_DOWN   energy declining 3+ or the lateNight block
 *   EXPLORING   the surface is discovery
 *   WARMUP      default
 */
export function computeVibe(session: SessionContext, opts?: VibeOpts): VibeState {
  if (session.vibeInputs.skipStormCount >= SKIP_STORM_THRESHOLD) return 'SKIP_STORM'

  const energies = (opts?.energies ?? []).filter((e) => Number.isFinite(e))
  const last3 = energies.slice(-3)

  const last4 = session.sessionListens.slice(-4)
  const rate =
    last4.length >= 2
      ? last4.filter((l) => l.grade === 'COMPLETED' || l.grade === 'LATE_SKIP').length / last4.length
      : session.vibeInputs.completionRate
  const flow = rate >= 0.7 && (last4.length >= 2 || session.sessionListens.length > 0)

  if (flow && last3.length >= 3 && last3.every((e) => e >= 0.8)) return 'PEAK'
  if (flow) return 'FLOW'

  const declining3 = last3.length >= 3 && last3[2] < last3[1] && last3[1] < last3[0]
  const trajectoryDown = session.vibeInputs.energyTrajectory <= -0.12
  const lateNight = currentDaypart(opts?.now ?? new Date()).block === 'lateNight'
  if (declining3 || trajectoryDown || lateNight) return 'WIND_DOWN'

  if (opts?.surface === 'discovery') return 'EXPLORING'
  return 'WARMUP'
}

// ---------------------------------------------------------------------------
// The decide() engine
// ---------------------------------------------------------------------------

interface ScoredCandidate {
  c: CandidatePool
  score: number
  profileAff: number
  sessionFit: number
  daypartFit: number
  freshness: number
  sourceTrust: number
  energyDelta: number
  moodMatch: boolean
  artistAff: number
  divisive: boolean
}

/**
 * The single authority. Pools are ≥3× the requested output (callers ensure).
 * Deterministic: (score desc, videoId asc) with stable hash jitter for
 * exploration slots.
 */
export function decide(opts: DecideOpts): EnginePick[] {
  const extra = opts.opts ?? {}
  const profile = opts.profile
  const session = opts.session
  const count = Math.max(1, Math.min(60, Math.floor(opts.count || 1)))
  const nowMs = Date.now()
  const reads = extra.reads ?? emptyReads()

  const vibe = computeVibe(session, { energies: extra.energies, surface: extra.surface })
  // SKIP_STORM → ε=0 (EPSILON.storm): no experiments during a fire
  // exploreOff (kill switch 'tsf-mindbeat-noexplore') → ε=0: exploration is
  // user-disabled, so hash01 < 0 never fires and explore slots vanish.
  const epsilon = extra.exploreOff
    ? 0
    : vibe === 'SKIP_STORM'
      ? EPSILON.storm
      : (profile.exploration.epsilon ?? EPSILON.established)

  // ---- pre-filter + dedupe -------------------------------------------------
  const mutedArtists = new Set(profile.corrections.mutedArtists)
  const mutedTracks = new Set(profile.corrections.mutedTracks)
  const exclude = new Set(extra.exclude ?? [])
  const previewOnly = new Set(extra.previewOnly ?? [])
  const unplayable = new Set(extra.unplayable ?? [])

  interface CandAcc {
    c: CandidatePool
    bestPriority: number
  }
  const byId = new Map<string, CandAcc>()
  for (const raw of opts.pool) {
    if (!raw?.videoId || !raw.title) continue
    if (mutedTracks.has(raw.videoId)) continue // NOT_FOR_ME hard-block (track)
    const aKey = raw.artistId || raw.artistName
    if (aKey && mutedArtists.has(aKey)) continue // NOT_FOR_ME hard-block (artist)
    if (exclude.has(raw.videoId)) continue
    if (unplayable.has(raw.videoId)) continue // unplayable hard-block
    const priority = POOL_PRIORITY[raw.pool] ?? 4
    const prev = byId.get(raw.videoId)
    if (!prev) {
      byId.set(raw.videoId, { c: raw, bestPriority: priority })
    } else if (priority < prev.bestPriority) {
      // same track surfaced by several pools — keep the strongest pool tag
      byId.set(raw.videoId, { c: { ...raw, features: prev.c.features ?? raw.features }, bestPriority: priority })
    }
  }
  const candidates = [...byId.values()].map((a) => a.c)
  if (!candidates.length) return []

  // ---- artist affinity normalization (read-time decay, log-squashed) -------
  const artistEff = new Map<string, number>()
  let refW = 0
  for (const [key, e] of Object.entries(profile.artists)) {
    const wEff = decayed(e.w, Date.parse(e.lastEventTs) || nowMs, nowMs, HALF_LIFE_DAYS.artist)
    if (wEff > 0) artistEff.set(key, wEff)
    if (wEff > refW) refW = wEff
  }
  const refDenom = Math.log1p(Math.max(refW, 1e-9))
  const top10Artists = new Set(
    [...artistEff.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k)
  )
  const heartedArtists = new Set(
    Object.entries(profile.artists)
      .filter(([, e]) => e.source === 'heart')
      .map(([k]) => k)
  )

  // genre reference (for genre-affinity normalization)
  let genreRef = 0
  const genreEff = new Map<string, number>()
  for (const [key, g] of Object.entries(profile.genres)) {
    const wEff = decayed(g.w, Date.parse(g.lastEventTs) || nowMs, nowMs, HALF_LIFE_DAYS.genre)
    genreEff.set(key, wEff)
    if (wEff > genreRef) genreRef = wEff
  }
  const genreDenom = Math.log1p(Math.max(genreRef, 1e-9))

  // daypart cell
  const cellKey = `${opts.block.block}|${opts.block.dayKind}`
  const cell = profile.daypart[cellKey]
  const cellHasData = !!cell && cell.sessionCount >= DAYPART_DATA_MIN_SESSIONS && cell.energyMean !== null && cell.energyMean !== undefined

  // session state
  const recent6 = session.sessionListens.slice(-6)
  const sessionEnergy =
    extra.sessionEnergy ??
    (profile.proxy.energyPref.n > 0 ? profile.proxy.energyPref.mean : 0.5)
  const sessionBand = bandOf(sessionEnergy)

  // SKIP_STORM: prefer last completed track's coplay neighbors
  const stormNeighborIds = new Set<string>()
  if (vibe === 'SKIP_STORM') {
    const lastCompleted = [...session.sessionListens].reverse().find((l) => l.grade === 'COMPLETED')
    if (lastCompleted) {
      const nbrs = profile.coplayTracks[lastCompleted.trackId]
      if (nbrs) Object.keys(nbrs).forEach((id) => stormNeighborIds.add(id))
    }
  }

  const anchors: NeighborAnchor[] = extra.neighborAnchors ?? []
  const anchorById = new Map(anchors.map((a) => [a.videoId, a.title ?? a.videoId]))
  const recentTrackIds = session.sessionListens.map((l) => l.trackId)

  // mood-cell top genres for the match bonus
  const cellGenres = new Set(
    cell ? Object.entries(cell.genres).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([g]) => g) : []
  )
  const cellArtists = new Set(cell ? Object.keys(cell.artists) : [])

  const proxyE = profile.proxy.energyPref
  const proxyV = profile.proxy.valencePref

  // ---- score every candidate ----------------------------------------------
  const scored: ScoredCandidate[] = candidates.map((c) => {
    const f = c.features
    const energy = f?.energy ?? 0.5
    const valence = f?.valence ?? 0.5
    const moodTags = f?.moodTags ?? []

    // -- ProfileAffinity -----------------------------------------------------
    const aKey = c.artistId || c.artistName
    const artistWEff = (aKey && artistEff.get(aKey)) || artistEff.get(c.artistName ?? '') || 0
    const artistAff = artistWEff > 0 ? clamp01(Math.log1p(artistWEff) / refDenom) : 0

    let genreAff: number | null = null
    for (const tag of moodTags) {
      const w = genreEff.get(tag) ?? 0
      if (w > 0) {
        const g = clamp01(Math.log1p(w) / genreDenom)
        if (genreAff === null || g > genreAff) genreAff = g
      }
    }

    let moodProx: number | null = null
    if (proxyE.n > 0 || proxyV.n > 0) {
      const dE = proxyE.n > 0 ? Math.abs(energy - proxyE.mean) : 0
      const dV = proxyV.n > 0 ? Math.abs(valence - proxyV.mean) : 0
      moodProx = clamp01(1 - (dE + dV) / 2)
    }

    let profileAff = artistAff
    if (genreAff !== null) profileAff = clamp01(profileAff * (1 - GENRE_SHARE) + genreAff * GENRE_BLEND * GENRE_SHARE)
    if (moodProx !== null) profileAff = clamp01(profileAff * (1 - MOOD_SHARE) + moodProx * MOOD_SHARE)

    // -- SessionFit ----------------------------------------------------------
    const energyDelta = Math.abs(energy - sessionEnergy)
    const quadPenalty = Math.pow(Math.max(0, energyDelta - SESSION_ENERGY_TOLERANCE), 2) * 4
    const candArtistKey = c.artistId || c.artistName
    const sameArtistCount = recent6.filter((l) => {
      const lk = artistKeyOfListen(l)
      return lk !== null && lk === candArtistKey
    }).length
    const extraArtist = Math.max(0, sameArtistCount - SAME_ARTIST_PER_6_SLOTS)
    const moodMatch =
      cellGenres.size > 0 && moodTags.some((t) => cellGenres.has(t))
    const stormNeighbor = stormNeighborIds.has(c.videoId)
    const sessionFit = Math.max(
      -2,
      Math.min(1, 1 - quadPenalty - SAME_ARTIST_EXTRA_PENALTY * extraArtist + (moodMatch ? MOOD_CELL_BONUS : 0) + (stormNeighbor ? STORM_NEIGHBOR_BONUS : 0))
    )

    // -- DaypartFit ----------------------------------------------------------
    let daypartFit = 0.5
    if (cellHasData && cell) {
      const cellMean = cell.energyMean
      if (cellMean !== null && cellMean !== undefined) {
        daypartFit = clamp01(1 - Math.abs(energy - cellMean))
      }
    }
    if (candArtistKey && cellArtists.has(candArtistKey)) {
      daypartFit = Math.min(1, daypartFit + BLOCK_ARTIST_BONUS)
    }

    // -- Freshness -----------------------------------------------------------
    const lastMs = reads.lastListenByTrack.get(c.videoId)
    const plays7d = reads.plays7dByTrack.get(c.videoId) ?? 0
    let freshness: number
    if (lastMs === undefined) {
      freshness = NEVER_PLAYED_BONUS
    } else {
      freshness = 0
      if (plays7d >= 2) freshness -= SERVED_TWICE_7D_PENALTY // served twice within 7d
      freshness -= Math.min(RECENT_PLAY_PENALTY_MAX, plays7d * RECENT_PLAY_PENALTY_PER)
      const daysSince = (nowMs - lastMs) / DAY_MS
      if (daysSince < 1) freshness -= PLAYED_TODAY_PENALTY
      else if (daysSince < 3) freshness -= PLAYED_THIS_WEEK_PENALTY
      freshness = Math.max(-1, Math.min(1, freshness))
    }

    // -- SourceTrust ---------------------------------------------------------
    const poolSurface = POOL_SURFACE[c.pool] ?? 'user_queue'
    const poolTrust = reads.trustBySurface.get(poolSurface)
    const surfaceTrust = extra.surface ? reads.trustBySurface.get(extra.surface) : undefined
    const sourceTrust =
      poolTrust === undefined && surfaceTrust === undefined
        ? 0.5
        : clamp01(((poolTrust ?? 0.5) + (surfaceTrust ?? 0.5)) / 2)

    // -- assemble ------------------------------------------------------------
    let score =
      SCORE_WEIGHTS.profileAffinity * profileAff +
      SCORE_WEIGHTS.sessionFit * sessionFit +
      SCORE_WEIGHTS.daypartFit * daypartFit +
      SCORE_WEIGHTS.freshness * freshness +
      SCORE_WEIGHTS.sourceTrust * sourceTrust
    if (previewOnly.has(c.videoId)) score -= PREVIEW_PENALTY

    const sp = profile.skipProfiles[c.videoId]
    const divisive =
      !!sp && sp.listens > 0 && sp.buckets[0] / sp.listens > DIVISIVE_OPEN_BUCKET_DENSITY

    return {
      c,
      score,
      profileAff,
      sessionFit,
      daypartFit,
      freshness,
      sourceTrust,
      energyDelta,
      moodMatch,
      artistAff: artistWEff,
      divisive,
    }
  })

  // ---- deterministic order -------------------------------------------------
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.c.videoId < b.c.videoId ? -1 : a.c.videoId > b.c.videoId ? 1 : 0
  })

  const explorationPools = new Set<PoolKind>(['discovery', 'cultural'])
  const seedStr = extra.seed ?? session.sessionId ?? 'tsf'
  const used = new Set<string>()
  const picks: EnginePick[] = []
  // output-horizon artist rotation (SAME_ARTIST_PER_6_SLOTS): an artist fills
  // at most 2 slots of the output sequence when alternatives exist — score
  // ties would otherwise queue one artist N times in a row.
  const outputArtistCount = new Map<string, number>()
  const capOk = (s: ScoredCandidate): boolean => {
    const ak = s.c.artistId || s.c.artistName
    if (!ak) return true
    return (outputArtistCount.get(ak) ?? 0) < SAME_ARTIST_PER_6_SLOTS
  }

  for (let slot = 0; slot < count; slot++) {
    const isExploreSlot = hash01(`${seedStr}|${slot}`) < epsilon
    const eligible = (s: ScoredCandidate): boolean =>
      !used.has(s.c.videoId) && !(slot === 0 && s.divisive) // divisive-openers ban on slot 1
    let chosen: ScoredCandidate | undefined
    let explored = false

    if (isExploreSlot) {
      chosen =
        scored.find((s) => eligible(s) && explorationPools.has(s.c.pool) && capOk(s)) ??
        scored.find((s) => eligible(s) && explorationPools.has(s.c.pool))
      if (chosen) explored = true
    }
    if (!chosen) {
      chosen =
        scored.find((s) => eligible(s) && capOk(s)) ??
        scored.find((s) => eligible(s))
    }
    if (!chosen) break

    used.add(chosen.c.videoId)
    const chosenArtistKey = chosen.c.artistId || chosen.c.artistName
    if (chosenArtistKey) outputArtistCount.set(chosenArtistKey, (outputArtistCount.get(chosenArtistKey) ?? 0) + 1)
    const c = chosen.c
    const aKey = c.artistId || c.artistName
    const artistName = profile.artists[aKey ?? '']?.name ?? c.artistName

    // ---- reason code (§8.5 truth-condition chain) -------------------------
    let reasonCode: ReasonCode
    const neighborAnchorTitle = findNeighborAnchor(c.videoId, profile, anchors, anchorById, recentTrackIds)
    if (explored) {
      reasonCode = 'FRESH_FIND'
    } else if (aKey && heartedArtists.has(aKey)) {
      reasonCode = 'BECAUSE_HEARTED'
    } else if (reads.replays7d.has(c.videoId)) {
      reasonCode = 'BACK_FOR_MORE'
    } else if (neighborAnchorTitle) {
      reasonCode = 'NEIGHBOR'
    } else if (
      session.sessionListens.length > 0 &&
      chosen.energyDelta <= SESSION_ENERGY_TOLERANCE &&
      bandOf(c.features?.energy ?? 0.5) === sessionBand
    ) {
      // SESSION_CONTINUITY truth: there IS a live session to continue
      reasonCode = 'SESSION_CONTINUITY'
    } else if (cellHasData) {
      reasonCode = 'FITS_BLOCK'
    } else if (top10Artists.has(aKey ?? '')) {
      reasonCode = 'BECAUSE_PLAYED'
    } else if (chosen.artistAff > 0 || c.pool === 'affinity') {
      // documented cold-corner fallback: the candidate came from the user's own
      // affinity evidence — the relaxed "played" line is the honest floor.
      reasonCode = 'BECAUSE_PLAYED'
    } else {
      reasonCode = 'BECAUSE_PLAYED'
    }

    const reasonLine = renderReason(reasonCode, {
      artist: artistName,
      track: reasonCode === 'NEIGHBOR' ? neighborAnchorTitle ?? undefined : undefined,
      block: opts.block.block,
    })

    picks.push({
      track: {
        videoId: c.videoId,
        title: c.title,
        artistName: c.artistName,
        ...(c.artistId ? { artistId: c.artistId } : {}),
        ...(c.duration !== undefined ? { duration: c.duration } : {}),
        ...(c.thumbnail ? { thumbnail: c.thumbnail } : {}),
      },
      score: Math.round((chosen.score + (explored ? EXPLORE_BONUS : 0)) * 1000) / 1000,
      reasonCode,
      reasonLine,
      explored,
      pool: c.pool,
    })
  }

  return picks
}

/**
 * NEIGHBOR truth condition: a REAL coplay edge must exist between the
 * candidate and a known anchor (seed tracks with titles, or the session's
 * recent listens). Returns the anchor title when the edge is real, else null.
 */
function findNeighborAnchor(
  videoId: string,
  profile: TasteProfileData,
  anchors: NeighborAnchor[],
  anchorById: Map<string, string>,
  recentTrackIds: string[]
): string | null {
  const edgesFromCandidate = profile.coplayTracks[videoId]
  // seed anchors first (they carry titles)
  for (const a of anchors) {
    const w = profile.coplayTracks[a.videoId]?.[videoId] ?? edgesFromCandidate?.[a.videoId]
    if (w && w > 0) return anchorById.get(a.videoId) ?? a.videoId
  }
  // session anchors (real listens — title unknown, so use the generic truth)
  for (const t of recentTrackIds) {
    const w = profile.coplayTracks[t]?.[videoId] ?? edgesFromCandidate?.[t]
    if (w && w > 0) return 'a recent track'
  }
  return null
}
