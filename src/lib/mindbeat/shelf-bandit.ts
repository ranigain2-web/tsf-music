/**
 * MINDBEAT — THE SHELF BANDIT (plan §8.6, Deezer-style cascade for Home).
 *
 * What matters on a feed is not just WHICH tracks you recommend but WHICH
 * SHELF you put first: earlier shelves consume attention, so each shelf's
 * click/start/completion performance should EARN its position.
 *
 * SERVER-ONLY · READ-ONLY over the ledger (same trust boundary as the
 * profile compile — the ledger/profile are never sent to any LLM):
 *   - aggregates per-shelf exposure/starts/completes/saves/skip@3 for the
 *     past 14 days via 13-a's ledger read helpers (getRecentListens +
 *     getRecentEventsByType),
 *   - scores each shelf with Laplace-smoothed rates,
 *   - deterministically reorders the home shelves (ε-greedy cascade —
 *     ZERO Math.random; the same hash01 FNV-1a pattern as decision.ts).
 *
 * Ordering policy (deterministic per dayBucket):
 *   · "Your top artists" (position 0) is the identity shelf — never demoted.
 *   · The TOP SLOT among the bandit-managed personalized shelves
 *     (now-sound, on-the-rise, genre-*, more-like-*) goes to the current
 *     CHAMPION (proven: enough exposures, score above median).
 *   · Under-explored shelves get exploration slots: ONE position up, decided
 *     by hash01(dayBucket|shelfId) < EXPLORE_RATE, max 2 per build.
 *   · No shelf (except the champion) ever moves more than MAX_DISPLACEMENT
 *     positions vs the curated default — stability users can feel.
 *   · Cold start (no proven performer): curated default order, mode 'cold'.
 *
 * The champion choice is FROZEN for the current dayBucket so the order a
 * user learned in the morning is still there at night.
 */

import { getRecentListens, getRecentEventsByType } from './ledger'
import type { ListenRecord } from './types'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
const WINDOW_MS = 14 * DAY_MS      // the bandit's memory horizon
const READS_TTL_MS = 30_000        // in-memory aggregation cache (like the engine's reads)

const MIN_PROOF_EXPOSURES = 8      // Laplace window: below this, uncertainty is wide
const EXPLORE_RATE = 1 / 3         // ~every Nth build an under-explored shelf bumps one slot
const MAX_EXPLORE_SWAPS = 2        // sprinkled, never a shuffle
const MAX_DISPLACEMENT = 3         // non-champion shelves never drift further than this
const PINNED_SHELF_ID = 'top-artists'

// Score = startsPerExposure (lead term)
//       + 0.5 · completionRate
//       + 0.25 · saveRate
//       − 0.6 · skipRate (skip@3: ≤30% of the track heard)
const W_COMPLETION = 0.5
const W_SAVE = 0.25
const W_SKIP_PENALTY = 0.6

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShelfStats {
  shelfId: string
  /** SHELF_EXPOSURE events in the window (or proxy: sessions with starts). */
  exposures: number
  /** TRACK_STARTs stamped with this shelfId (payload.shelfId). */
  starts: number
  /** Of those starts, COMPLETED grade. */
  completes: number
  /** TRACK_LIKEs on tracks whose last shelf-start came from this shelf. */
  saves: number
  /** Starts abandoned early (skipBucket ≤ 3 ⇒ ≤30% heard, non-COMPLETED). */
  skipAt3: number
  /** Distinct sessions with a shelf start (exposure proxy + diagnostics). */
  sessions: number
}

export interface ShelfScore extends ShelfStats {
  score: number
  proven: boolean
}

export interface BanditState {
  mode: 'live' | 'cold'
  champion?: string
  dayBucket: number
  scoreById: Map<string, ShelfScore>
}

interface ShelfReorderMeta {
  mode: 'live' | 'cold'
  champion?: string
  dayBucket: number
}

// Managed = reorderable personalized shelves (champion candidates). Daily
// mixes are aggregated for telemetry but NOT candidates — their cards render
// in a fixed section outside the shelves[] band, so they can never be moved.
export function isBanditManagedShelf(shelfId: string): boolean {
  return (
    shelfId === 'now-sound' ||
    shelfId === 'on-the-rise' ||
    shelfId.startsWith('genre-') ||
    shelfId.startsWith('more-like-')
  )
}

// ---------------------------------------------------------------------------
// hash01 — same FNV-1a pattern as decision.ts (deterministic, no Math.random)
// ---------------------------------------------------------------------------

function hash01(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 0x100000000
}

// ---------------------------------------------------------------------------
// Aggregation (read-only over the ledger, 30s in-memory cache)
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function emptyStats(shelfId: string): ShelfStats {
  return { shelfId, exposures: 0, starts: 0, completes: 0, saves: 0, skipAt3: 0, sessions: 0 }
}

async function aggregateShelfStats(): Promise<Map<string, ShelfStats>> {
  const [listens, exposureRows, likeRows] = await Promise.all([
    getRecentListens(WINDOW_MS).catch(() => [] as ListenRecord[]),
    getRecentEventsByType('SHELF_EXPOSURE', WINDOW_MS).catch(() => []),
    getRecentEventsByType('TRACK_LIKE', WINDOW_MS).catch(() => []),
  ])

  const stats = new Map<string, ShelfStats>()

  // exposures: the denominator — one event per shelf per Home open
  for (const row of exposureRows) {
    const shelfId = str(row.payload.shelfId)
    if (!shelfId) continue
    const s = stats.get(shelfId) ?? emptyStats(shelfId)
    s.exposures++
    stats.set(shelfId, s)
  }

  // starts / completes / skip@3 + the last-shelf-per-track map
  const lastShelfByTrack = new Map<string, { shelfId: string; ts: number }>()
  for (const l of listens) {
    if (!l.shelfId) continue
    const s = stats.get(l.shelfId) ?? emptyStats(l.shelfId)
    s.starts++
    if (l.grade === 'COMPLETED') s.completes++
    else if ((l.skipBucket ?? 10) <= 3) s.skipAt3++
    stats.set(l.shelfId, s)

    const ts = Date.parse(l.startedTs) || 0
    const prev = lastShelfByTrack.get(l.trackId)
    if (!prev || prev.ts <= ts) lastShelfByTrack.set(l.trackId, { shelfId: l.shelfId, ts })
  }

  // saves: a like on a track this shelf recently served (attribution by
  // last shelf-start — no new client signal needed)
  for (const like of likeRows) {
    if (!like.trackId) continue
    const hit = lastShelfByTrack.get(like.trackId)
    if (!hit) continue
    const s = stats.get(hit.shelfId) ?? emptyStats(hit.shelfId)
    s.saves++
    stats.set(hit.shelfId, s)
  }

  // sessions are over-counted per listen above — rebuild from distinct ids
  const sessionIds = new Map<string, Set<string>>()
  for (const l of listens) {
    if (!l.shelfId) continue
    const set = sessionIds.get(l.shelfId) ?? new Set<string>()
    set.add(l.sessionId)
    sessionIds.set(l.shelfId, set)
  }
  for (const [shelfId, set] of sessionIds) {
    const s = stats.get(shelfId)
    if (s) s.sessions = set.size
  }

  // exposure proxy when SHELF_EXPOSURE telemetry hasn't arrived yet (the
  // event is new): sessions where the shelf demonstrably existed
  for (const s of stats.values()) {
    if (s.exposures === 0 && s.starts > 0) s.exposures = s.sessions
  }

  return stats
}

function scoreShelf(s: ShelfStats): number {
  // Laplace smoothing — a shelf with no data sits at the prior, not at 0/1
  const startsPerExposure = (s.starts + 1) / (s.exposures + 2)
  const completionRate = (s.completes + 1) / (s.starts + 2)
  const saveRate = (s.saves + 0.5) / (s.starts + 4) // saves are rare — stronger smoothing
  const skipRate = (s.skipAt3 + 1) / (s.starts + 2)
  return startsPerExposure + W_COMPLETION * completionRate + W_SAVE * saveRate - W_SKIP_PENALTY * skipRate
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ---------------------------------------------------------------------------
// State (30s cache) + champion freeze per dayBucket
// ---------------------------------------------------------------------------

let stateCache: { state: BanditState; at: number } | null = null
let championFreeze: { dayBucket: number; championId?: string } | null = null

function dayBucketOf(now = Date.now()): number {
  return Math.floor(now / DAY_MS)
}

export async function getShelfBanditState(): Promise<BanditState> {
  if (stateCache && Date.now() - stateCache.at < READS_TTL_MS) return stateCache.state

  const dayBucket = dayBucketOf()
  const stats = await aggregateShelfStats().catch(() => new Map<string, ShelfStats>())

  // score every shelf that has ANY evidence
  const scored: ShelfScore[] = []
  for (const s of stats.values()) {
    if (s.exposures <= 0 && s.starts <= 0) continue
    scored.push({ ...s, score: scoreShelf(s), proven: false })
  }

  const candidates = scored.filter((s) => isBanditManagedShelf(s.shelfId))
  const med = median(candidates.map((s) => s.score))
  for (const c of candidates) c.proven = c.exposures >= MIN_PROOF_EXPOSURES && c.score > med

  // champion: best proven candidate — (score desc, shelfId asc) tiebreak.
  // The choice is frozen for the whole dayBucket so the order users learn in
  // the morning holds at night; the freeze is released only when the frozen
  // champion genuinely loses proven status (data shift/reset), and a cold day
  // adopts its first champion as soon as one emerges.
  const frozen = championFreeze && championFreeze.dayBucket === dayBucket ? championFreeze : null
  let championId: string | undefined
  if (frozen?.championId) {
    const stillProven = candidates.some((c) => c.shelfId === frozen.championId && c.proven)
    championId = stillProven ? frozen.championId : undefined
  }
  if (!championId) {
    const proven = candidates
      .filter((c) => c.proven)
      .sort((a, b) => b.score - a.score || a.shelfId.localeCompare(b.shelfId))
    championId = proven[0]?.shelfId
    championFreeze = { dayBucket, championId }
  }

  const scoreById = new Map<string, ShelfScore>()
  for (const s of scored) scoreById.set(s.shelfId, s)

  const state: BanditState = {
    mode: championId ? 'live' : 'cold',
    champion: championId,
    dayBucket,
    scoreById,
  }
  stateCache = { state, at: Date.now() }
  return state
}

/** Top-level `bandit` field for the home response (transparency). */
export function banditMeta(state: BanditState | null, shelves: { id?: string }[]): ShelfReorderMeta {
  const dayBucket = state?.dayBucket ?? dayBucketOf()
  const champion = state?.champion
  const present = !!champion && shelves.some((s) => s.id === champion)
  return present
    ? { mode: 'live', champion, dayBucket }
    : { mode: 'cold', dayBucket }
}

// ---------------------------------------------------------------------------
// Reorder (deterministic cascade)
// ---------------------------------------------------------------------------

/**
 * Reorder the home shelves per the bandit's cascade policy. Existing shelves
 * NEVER disappear and never change content — order only. The champion moves
 * to the top bandit-managed slot; under-explored shelves may swap ONE
 * position up (hash-picked per dayBucket); everything else holds its
 * relative order within MAX_DISPLACEMENT of the curated default.
 */
export function reorderShelves<T extends { id?: string }>(shelves: T[], state: BanditState | null): T[] {
  if (!shelves.length) return shelves
  if (!state || state.mode !== 'live' || !state.champion) return [...shelves]

  const original = [...shelves]
  const out = [...shelves]
  const pinnedIdx = out.findIndex((s) => s.id === PINNED_SHELF_ID)

  // -- 1. champion promotion ------------------------------------------------
  // Top slot among the managed shelves = the lowest index a managed shelf
  // currently occupies. Every shelf between the champion's old and new spot
  // shifts down by exactly one.
  const champIdx = out.findIndex((s) => s.id === state.champion)
  const firstManagedIdx = out.findIndex((s) => s.id && isBanditManagedShelf(s.id))
  if (champIdx >= 0 && firstManagedIdx >= 0 && champIdx > firstManagedIdx) {
    const [champ] = out.splice(champIdx, 1)
    out.splice(firstManagedIdx, 0, champ)
  }

  // -- 2. exploration sprinkles --------------------------------------------
  // Under-explored shelves (wide uncertainty) get ONE position up, decided
  // stably by hash01(dayBucket|shelfId) — ~every Nth build per shelf, at most
  // MAX_EXPLORE_SWAPS per build, each guarded by the displacement cap.
  const displacement = (id?: string, currentIdx = -1): number => {
    if (!id) return 0
    const oldIdx = original.findIndex((s) => s.id === id)
    if (oldIdx < 0 || currentIdx < 0) return 0
    return Math.abs(currentIdx - oldIdx)
  }

  const explorers = [...state.scoreById.values()]
    .filter(
      (s) =>
        isBanditManagedShelf(s.shelfId) &&
        s.shelfId !== state.champion &&
        s.exposures < MIN_PROOF_EXPOSURES
    )
    .map((s) => ({ shelfId: s.shelfId, h: hash01(`${state.dayBucket}|${s.shelfId}`) }))
    .filter((e) => e.h < EXPLORE_RATE)
    .sort((a, b) => a.h - b.h || a.shelfId.localeCompare(b.shelfId))
    .slice(0, MAX_EXPLORE_SWAPS)

  for (const e of explorers) {
    const idx = out.findIndex((s) => s.id === e.shelfId)
    if (idx <= 0) continue
    const aboveIdx = idx - 1
    // never displace the pinned identity shelf or the champion's earned slot
    if (aboveIdx === pinnedIdx) continue
    if (out[aboveIdx]?.id === state.champion) continue
    // displacement guard for BOTH affected shelves
    const movedUp = out[idx]
    const movedDown = out[aboveIdx]
    if (displacement(movedUp.id, aboveIdx) > MAX_DISPLACEMENT) continue
    if (displacement(movedDown.id, idx) > MAX_DISPLACEMENT) continue
    out[aboveIdx] = movedUp
    out[idx] = movedDown
  }

  return out
}
