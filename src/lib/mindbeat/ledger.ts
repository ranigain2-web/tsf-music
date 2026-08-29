/**
 * MINDBEAT v2.0 — L1 Event Ledger engine (server).
 *
 * THE ONE DATA-FLOW RULE: surfaces never touch this file; they ask the
 * Decision Engine. Writes arrive ONLY through appendEvents() — batched and
 * SERIALIZED through a module-level promise chain, so concurrent route
 * calls can never interleave mid-session bookkeeping.
 *
 * Responsibilities:
 *   - append-only LedgerEvent writes (ULID ids, per-row dedupe on id)
 *   - ListenSession lifecycle (touch / stale-close after SESSION_GAP_MIN)
 *   - listen RECONSTRUCTION (heartbeat-true listenedMs → grade → skipBucket)
 *   - legacy mirror of COMPLETED/LATE listens into HistoryItem
 *   - retention (90d) + feature calibration on decisive listens
 *
 * SERVER-ONLY. Constitution lives in ./types — every constant comes from there.
 */

import { randomBytes } from 'crypto'
import type { LedgerEvent } from '@prisma/client'
import { db } from '@/lib/db'
import {
  EVENT_TYPES,
  SESSION_GAP_MIN,
  SESSION_WINDOW,
  SKIP_STORM_WINDOW,
  SOURCE_SURFACES,
  currentDaypart,
  type EventType,
  type LedgerEventIn,
  type ListenGrade,
  type ListenRecord,
  type DaypartBlock,
  type DayKind,
  type SourceSurface,
} from '@/lib/mindbeat/types'
import { calibrate, getFeatures } from '@/lib/mindbeat/features'

// ---------------------------------------------------------------------------
// ULID — Crockford base32, 48-bit ms timestamp + 80-bit crypto randomness
// ---------------------------------------------------------------------------

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // 32 chars, no I L O U

function ulidEncodeTime(now: number, len: number): string {
  let out = ''
  for (let i = len; i > 0; i--) {
    const mod = now % 32
    out = ULID_ALPHABET[mod] + out
    now = (now - mod) / 32
  }
  return out
}

function ulidEncodeRandom(len: number): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += ULID_ALPHABET[bytes[i] % 32] // 256 % 32 === 0 → unbiased
  return out
}

/** Monotonic-enough ULID (server fallback when the client didn't send one). */
export function ulid(): string {
  return ulidEncodeTime(Date.now(), 10) + ulidEncodeRandom(16)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
const VALID_GRADES: readonly string[] = ['INSTANT_REJECT', 'EARLY_SKIP', 'MID_SKIP', 'LATE_SKIP', 'COMPLETED']
const VALID_SURFACES: readonly string[] = SOURCE_SURFACES

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002'
}

function later(p: Promise<unknown>): void {
  p.catch(() => {})
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const j = JSON.parse(raw)
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Plan §5.2 thresholds: <5s INSTANT_REJECT, <30s EARLY_SKIP, ≥95% COMPLETED,
 * ≥75% LATE_SKIP, else MID_SKIP. Unknown duration but ≥30s listened → the
 * listen is trusted (only natural ends and long plays reach here).
 */
export function gradeOf(listenedMs: number, durationMs: number): ListenGrade {
  if (listenedMs < 5_000) return 'INSTANT_REJECT'
  if (listenedMs < 30_000) return 'EARLY_SKIP'
  if (durationMs > 0) {
    const ratio = listenedMs / durationMs
    if (ratio >= 0.95) return 'COMPLETED'
    if (ratio >= 0.75) return 'LATE_SKIP'
    return 'MID_SKIP'
  }
  return 'COMPLETED'
}

// ---------------------------------------------------------------------------
// Serialized write chain
// ---------------------------------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve()

function enqueueWrite<T>(job: () => Promise<T>): Promise<T> {
  const run = writeChain.then(job, job)
  writeChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Upsert the ListenSession row for an activity tick. The session's daypart
 * is FIXED at creation (start of session defines the L2 daypart cell);
 * endTs stays null while the session is open — endStaleSessions() closes it.
 */
export async function touchSession(sessionId: string, ts: Date): Promise<void> {
  const { block, dayKind } = currentDaypart(ts)
  await db.listenSession.upsert({
    where: { id: sessionId },
    update: {},
    create: {
      id: sessionId,
      startTs: ts,
      endTs: null,
      daypart: block,
      dayKind,
      trackCount: 0,
      totalListenMs: 0,
    },
  })
}

/**
 * Close sessions whose LAST ACTIVITY is older than SESSION_GAP_MIN minutes.
 * endTs is set to the actual last-activity instant (last ledger event ts),
 * which is what "no activity for the gap" means.
 */
export async function endStaleSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - SESSION_GAP_MIN * 60_000)
  const open = await db.listenSession
    .findMany({ where: { endTs: null, startTs: { lt: cutoff } }, take: 25, select: { id: true, startTs: true } })
    .catch(() => [])
  let closed = 0
  for (const s of open) {
    const last = await db.ledgerEvent
      .findFirst({ where: { sessionId: s.id }, orderBy: { ts: 'desc' }, select: { ts: true } })
      .catch(() => null)
    const lastTs = last?.ts ?? s.startTs
    if (lastTs.getTime() <= cutoff.getTime()) {
      await db.listenSession.update({ where: { id: s.id }, data: { endTs: lastTs } }).catch(() => {})
      closed++
    }
  }
  return closed
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Delete ledger events older than 90 days — the profile cache rebuilds from scratch. */
export async function compactOldEvents(): Promise<number> {
  const res = await db.ledgerEvent.deleteMany({ where: { ts: { lt: new Date(Date.now() - 90 * DAY_MS) } } })
  return res.count
}

// ---------------------------------------------------------------------------
// Legacy mirror
// ---------------------------------------------------------------------------

/**
 * Mirror a COMPLETED/LATE listen into HistoryItem (real msPlayed) so the
 * legacy surfaces (history list, AI prompt taste hints) benefit. Idempotent
 * per session+track: skipped when a row already exists in the session's
 * time window. Non-fatal by contract.
 */
export async function recordListenToHistory(listen: ListenRecord): Promise<void> {
  try {
    const session = await db.listenSession.findUnique({ where: { id: listen.sessionId } })
    const from = new Date((session?.startTs ?? new Date(listen.startedTs)).getTime() - 60_000)
    const to = new Date((session?.endTs ?? new Date(Date.now() + 60_000)).getTime() + 5 * 60_000)
    const existing = await db.historyItem.findFirst({
      where: { trackId: listen.trackId, playedAt: { gte: from, lte: to } },
      select: { id: true },
    })
    if (existing) return
    // HistoryItem.track is a required FK — stub the catalog row if unseen
    const track = await db.track.findUnique({ where: { id: listen.trackId }, select: { id: true } })
    if (!track) {
      await db.track
        .create({
          data: {
            id: listen.trackId,
            title: 'Unknown title',
            artistName: listen.artistName || 'Unknown artist',
            duration: Math.max(0, Math.round(listen.durationMs / 1000)),
          },
        })
        .catch(() => undefined)
    }
    const ms = Math.max(0, Math.min(Math.round(listen.listenedMs), 3600_000))
    if (ms <= 0) return
    const startMs = new Date(listen.startedTs).getTime()
    const playedAt = Number.isFinite(startMs) ? new Date(startMs + ms) : new Date()
    await db.historyItem.create({
      data: { trackId: listen.trackId, playedAt, msPlayed: ms },
    })
  } catch {
    // non-fatal by contract
  }
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

interface NormalizedEvent {
  id: string
  ts: Date
  type: string
  sessionId: string
  trackId?: string
  surface?: string
  payload: Record<string, unknown>
}

function normalizeEvent(raw: LedgerEventIn): NormalizedEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const sessionId = str(raw.sessionId)
  const tsMs = new Date(raw.ts ?? '').getTime()
  if (!sessionId || !Number.isFinite(tsMs)) return null
  const type = str(raw.type)
  if (!type || !(EVENT_TYPES as readonly string[]).includes(type)) return null
  const payload: Record<string, unknown> = { ...(raw.payload && typeof raw.payload === 'object' ? raw.payload : {}) }
  if (str(raw.artistId)) payload.artistId = raw.artistId
  if (str(raw.artistName)) payload.artistName = raw.artistName
  const surface = str(raw.surface) && (VALID_SURFACES as readonly string[]).includes(raw.surface as string) ? raw.surface : undefined
  const trackId = str(raw.trackId)
  return {
    id: str(raw.id) ?? ulid(),
    ts: new Date(tsMs),
    type,
    sessionId,
    trackId,
    surface,
    payload,
  }
}

// calibration context: last decisive track per session (its energy IS the
// context the next decisive listen succeeds/rejects in)
const sessionPrevTrack = new Map<string, string>()

/**
 * The ONLY write path into the ledger. Batched, validated, deduped by event
 * id (unique-constraint errors are caught per row), serialized through the
 * module-level write chain. Also opportunistically: ends stale sessions and
 * (1-in-50 appends) compacts the 90d retention window.
 */
export async function appendEvents(events: LedgerEventIn[]): Promise<{ inserted: number }> {
  const normalized = (Array.isArray(events) ? events : [])
    .map(normalizeEvent)
    .filter((e): e is NormalizedEvent => e !== null)
    .sort((a, b) => a.ts.getTime() - b.ts.getTime())
  if (!normalized.length) return { inserted: 0 }

  const result = await enqueueWrite(async () => {
    let inserted = 0
    for (const ev of normalized) {
      // session bookkeeping (upsert is idempotent, keeps the start daypart)
      await touchSession(ev.sessionId, ev.ts).catch(() => {})

      try {
        await db.ledgerEvent.create({
          data: {
            id: ev.id,
            ts: ev.ts,
            type: ev.type,
            sessionId: ev.sessionId,
            trackId: ev.trackId ?? null,
            surface: ev.surface ?? null,
            payload: JSON.stringify(ev.payload).slice(0, 8192),
          },
        })
        inserted++
      } catch (e) {
        if (!isUniqueViolation(e)) {
          // real failure (not a duplicate) — log so ops can see; never 500 the client batch
          console.error('[mindbeat] ledger create failed', e)
        }
        continue // duplicate event id — already recorded
      }

      // session counters
      if (ev.type === 'TRACK_START') {
        later(db.listenSession.update({ where: { id: ev.sessionId }, data: { trackCount: { increment: 1 } } }).catch(() => {}))
        if (ev.trackId) sessionPrevTrack.set(ev.sessionId, ev.trackId)
      }

      // close-events: grade, legacy mirror, behavioral calibration
      if (ev.type === 'TRACK_END' || ev.type === 'TRACK_SKIP') {
        const listenedMs = num(ev.payload.listenedMs) ?? 0
        if (listenedMs > 0) {
          later(
            db.listenSession
              .update({ where: { id: ev.sessionId }, data: { totalListenMs: { increment: Math.round(listenedMs) } } })
              .catch(() => {})
          )
        }
        const durationMs = num(ev.payload.durationMs) ?? 0
        const payloadGrade = str(ev.payload.grade)
        const grade: ListenGrade =
          payloadGrade && (VALID_GRADES as readonly string[]).includes(payloadGrade)
            ? (payloadGrade as ListenGrade)
            : gradeOf(listenedMs, durationMs)

        if (ev.trackId && (grade === 'COMPLETED' || grade === 'LATE_SKIP')) {
          later(
            recordListenToHistory({
              trackId: ev.trackId,
              artistId: str(ev.payload.artistId),
              artistName: str(ev.payload.artistName),
              sessionId: ev.sessionId,
              surface: ev.surface as SourceSurface | undefined,
              startedTs: ev.ts.toISOString(),
              listenedMs: Math.round(listenedMs),
              durationMs: Math.round(durationMs || listenedMs),
              completionRatio: durationMs > 0 ? Math.min(1, listenedMs / durationMs) : 1,
              grade,
              wasRecommended: ev.payload.wasRecommended === true,
            })
          )
        }

        if (ev.trackId && (grade === 'COMPLETED' || grade === 'INSTANT_REJECT')) {
          const contextTrack = sessionPrevTrack.get(ev.sessionId)
          const energySource = contextTrack && contextTrack !== ev.trackId ? contextTrack : ev.trackId
          later(
            (async () => {
              const feats = await getFeatures([energySource])
              const f = feats.get(energySource)
              const energyAt = f?.effEnergy ?? f?.energy
              if (energyAt !== null && energyAt !== undefined) {
                await calibrate(ev.trackId!, { completed: grade === 'COMPLETED', energyAt })
              }
            })()
          )
        }

        if (ev.trackId) sessionPrevTrack.set(ev.sessionId, ev.trackId)
      }
    }
    return inserted
  })

  // opportunistic housekeeping — fire-and-forget, never blocks the response
  later(endStaleSessions())
  if (Math.random() < 1 / 50) later(compactOldEvents())

  return { inserted: result }
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

interface OpenListen {
  trackId: string
  artistId?: string
  artistName?: string
  sessionId: string
  surface?: SourceSurface
  /** Home shelf that served this listen (TRACK_START payload.shelfId). */
  shelfId?: string
  startedTs: number
  durationMs: number
  wasRecommended: boolean
  lastElapsedMs: number | null
}

interface ClosedListen {
  trackId: string
  artistId?: string
  artistName?: string
  sessionId: string
  surface?: SourceSurface
  shelfId?: string
  startedTs: number
  durationMs: number
  listenedMs: number | null
  grade?: string
  wasRecommended: boolean
}

function closeFromOpen(
  cur: OpenListen,
  close: { listenedMs?: number | null; durationMs?: number; grade?: string }
): ClosedListen {
  // heartbeat elapsed is ground truth; payload.listenedMs is the audio
  // engine's accumulator — when both exist, the larger one is the truth
  const listened =
    cur.lastElapsedMs !== null && close.listenedMs !== undefined && close.listenedMs !== null
      ? Math.max(cur.lastElapsedMs, close.listenedMs)
      : (cur.lastElapsedMs ?? close.listenedMs ?? null)
  return {
    trackId: cur.trackId,
    artistId: cur.artistId,
    artistName: cur.artistName,
    sessionId: cur.sessionId,
    surface: cur.surface,
    shelfId: cur.shelfId,
    startedTs: cur.startedTs,
    durationMs: close.durationMs ?? cur.durationMs,
    listenedMs: listened,
    grade: close.grade,
    wasRecommended: cur.wasRecommended,
  }
}

/**
 * Rebuild graded ListenRecords from raw ledger events. Groups by
 * sessionId+trackId (deepest listen of a replayed track wins), applies the
 * plan's grade thresholds, computes the 1..10 skip bucket, and falls back to
 * HistoryItem msPlayed when the client died before any close event.
 */
export async function reconstructListens(events: LedgerEvent[]): Promise<ListenRecord[]> {
  const open = new Map<string, OpenListen>()
  const closed: ClosedListen[] = []

  for (const ev of events) {
    const payload = parsePayload(ev.payload)
    const trackId = ev.trackId ?? str(payload.trackId)
    if (!trackId) continue
    const key = `${ev.sessionId}|${trackId}`

    if (ev.type === 'TRACK_START') {
      const prev = open.get(key)
      if (prev) {
        closed.push(closeFromOpen(prev, { listenedMs: prev.lastElapsedMs }))
      }
      open.set(key, {
        trackId,
        artistId: str(payload.artistId),
        artistName: str(payload.artistName),
        sessionId: ev.sessionId,
        surface:
          (ev.surface && (VALID_SURFACES as readonly string[]).includes(ev.surface)
            ? (ev.surface as SourceSurface)
            : undefined) ??
          (str(payload.surface) && (VALID_SURFACES as readonly string[]).includes(str(payload.surface)!)
            ? (str(payload.surface) as SourceSurface)
            : undefined),
        shelfId: str(payload.shelfId),
        startedTs: ev.ts.getTime(),
        durationMs: num(payload.durationMs) ?? 0,
        wasRecommended: payload.wasRecommended === true,
        lastElapsedMs: null,
      })
      continue
    }

    const cur = open.get(key)
    if (!cur) continue

    if (ev.type === 'TRACK_HEARTBEAT') {
      const elapsed = num(payload.elapsedMs) ?? num(payload.positionMs)
      if (elapsed !== undefined) cur.lastElapsedMs = Math.max(cur.lastElapsedMs ?? 0, elapsed)
      continue
    }

    if (ev.type === 'TRACK_END' || ev.type === 'TRACK_SKIP') {
      closed.push(
        closeFromOpen(cur, {
          listenedMs: num(payload.listenedMs) ?? null,
          durationMs: num(payload.durationMs) ?? undefined,
          grade: str(payload.grade),
        })
      )
      open.delete(key)
    }
  }
  // drain still-open listens (app killed, window end) at last-heartbeat truth
  for (const cur of open.values()) closed.push(closeFromOpen(cur, { listenedMs: cur.lastElapsedMs }))

  // group by sessionId+trackId — deepest engagement wins
  const best = new Map<string, ClosedListen>()
  for (const c of closed) {
    const k = `${c.sessionId}|${c.trackId}`
    const prev = best.get(k)
    if (!prev || (c.listenedMs ?? 0) > (prev.listenedMs ?? 0)) best.set(k, c)
  }

  // HistoryItem fallback for zero-evidence listens
  const needFallback = [...best.values()].filter((c) => (c.listenedMs ?? 0) <= 0)
  if (needFallback.length) {
    const ids = [...new Set(needFallback.map((c) => c.trackId))]
    const items = await db.historyItem
      .findMany({
        where: { trackId: { in: ids }, msPlayed: { gt: 0 }, playedAt: { gte: new Date(Math.min(...needFallback.map((c) => c.startedTs)) - DAY_MS) } },
        orderBy: { playedAt: 'asc' },
        select: { trackId: true, playedAt: true, msPlayed: true },
      })
      .catch(() => [])
    for (const c of needFallback) {
      const near = items.filter(
        (i) => i.trackId === c.trackId && Math.abs(i.playedAt.getTime() - c.startedTs) <= 15 * 60_000
      )
      if (near.length) c.listenedMs = Math.max(...near.map((i) => i.msPlayed))
    }
  }

  // duration fallback from the catalog cache
  const needDuration = [...best.values()].filter((c) => !c.durationMs || c.durationMs <= 0)
  if (needDuration.length) {
    const ids = [...new Set(needDuration.map((c) => c.trackId))]
    const tracks = await db.track
      .findMany({ where: { id: { in: ids } }, select: { id: true, duration: true } })
      .catch(() => [])
    const dmap = new Map(tracks.map((t): [string, number] => [t.id, t.duration]))
    for (const c of needDuration) {
      const d = dmap.get(c.trackId)
      if (d && d > 0) c.durationMs = d * 1000
    }
  }

  const out: ListenRecord[] = [...best.values()].map((c) => {
    const listenedMs = Math.max(0, Math.round(c.listenedMs ?? 0))
    const durationMs = c.durationMs && c.durationMs > 0 ? c.durationMs : listenedMs
    const grade: ListenGrade =
      c.grade && (VALID_GRADES as readonly string[]).includes(c.grade)
        ? (c.grade as ListenGrade)
        : gradeOf(listenedMs, durationMs)
    const completionRatio = durationMs > 0 ? Math.min(1, listenedMs / durationMs) : 1
    const skipBucket = Math.max(1, Math.min(10, Math.floor(completionRatio * 10)))
    return {
      trackId: c.trackId,
      artistId: c.artistId,
      artistName: c.artistName,
      sessionId: c.sessionId,
      surface: c.surface,
      shelfId: c.shelfId,
      startedTs: new Date(c.startedTs).toISOString(),
      listenedMs,
      durationMs,
      completionRatio,
      grade,
      skipBucket,
      wasRecommended: c.wasRecommended,
    }
  })
  out.sort((a, b) => a.startedTs.localeCompare(b.startedTs))
  return out
}

/** Graded listens across the retention window (default 90 days). */
export async function getRecentListens(limitMs = 90 * DAY_MS): Promise<ListenRecord[]> {
  const since = new Date(Date.now() - limitMs)
  const events = await db.ledgerEvent
    .findMany({ where: { ts: { gte: since } }, orderBy: { ts: 'desc' }, take: 5000 })
    .catch(() => [])
  events.reverse()
  return reconstructListens(events)
}

// ---------------------------------------------------------------------------
// Raw typed reads (shelf-bandit + telemetry aggregators)
// ---------------------------------------------------------------------------

/** Minimal raw ledger row for event-type aggregations (read-only). */
export interface RawLedgerRow {
  id: string
  ts: Date
  sessionId: string
  trackId?: string
  surface?: SourceSurface
  payload: Record<string, unknown>
}

/**
 * Read raw ledger events of ONE type within a time window. Read-only —
 * used by aggregators (shelf bandit) that need fields reconstruction drops
 * (e.g. SHELF_EXPOSURE rows carry no trackId at all).
 */
export async function getRecentEventsByType(
  type: EventType,
  limitMs = 14 * DAY_MS,
  take = 2000
): Promise<RawLedgerRow[]> {
  const since = new Date(Date.now() - limitMs)
  const rows = await db.ledgerEvent
    .findMany({
      where: { type, ts: { gte: since } },
      orderBy: { ts: 'desc' },
      take,
      select: { id: true, ts: true, sessionId: true, trackId: true, surface: true, payload: true },
    })
    .catch(() => [])
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    sessionId: r.sessionId,
    trackId: r.trackId ?? undefined,
    surface: (r.surface ?? undefined) as SourceSurface | undefined,
    payload: parsePayload(r.payload),
  }))
}

// ---------------------------------------------------------------------------
// Current session context (the ONE read path for surfaces' vibe state)
// ---------------------------------------------------------------------------

export interface SessionVibeInputs {
  completionRate: number
  skipStormCount: number
  energyTrajectory: number
}

export interface SessionContext {
  sessionId: string | null
  daypart: DaypartBlock | null
  dayKind: DayKind
  sessionListens: ListenRecord[]
  vibeInputs: SessionVibeInputs
}

/**
 * Current session context for the Decision Engine: the most recent
 * ListenSession, its last SESSION_WINDOW graded listens (chronological),
 * and the derived vibe inputs (completion rate, skip-storm magnitude within
 * the storm window, energy trajectory of the last tracks).
 */
export async function getSessionContext(): Promise<SessionContext> {
  const now = currentDaypart(new Date())
  const session = await db.listenSession
    .findFirst({ orderBy: { startTs: 'desc' }, select: { id: true, daypart: true, dayKind: true } })
    .catch(() => null)
  if (!session) {
    return { sessionId: null, daypart: null, dayKind: now.dayKind, sessionListens: [], vibeInputs: { completionRate: 0, skipStormCount: 0, energyTrajectory: 0 } }
  }

  const events = await db.ledgerEvent
    .findMany({ where: { sessionId: session.id }, orderBy: { ts: 'asc' }, take: 500 })
    .catch(() => [])
  const listens = await reconstructListens(events)
  const recent = listens.slice(-SESSION_WINDOW)

  const positive = recent.filter((l) => l.grade === 'COMPLETED' || l.grade === 'LATE_SKIP').length
  const completionRate = recent.length ? positive / recent.length : 0
  const stormWindow = recent.slice(-SKIP_STORM_WINDOW)
  const skipStormCount = stormWindow.filter((l) => l.grade === 'INSTANT_REJECT').length

  // energy trajectory: mean of last 3 known energies minus mean of the 3 before
  const featureIds = [...new Set(recent.map((l) => l.trackId))].slice(0, 24)
  const feats = featureIds.length ? await getFeatures(featureIds) : new Map()
  const series = recent
    .map((l) => {
      const f = feats.get(l.trackId)
      const e = f?.effEnergy ?? f?.energy
      return e === null || e === undefined ? NaN : e
    })
    .filter((e) => !Number.isNaN(e))
  let energyTrajectory = 0
  if (series.length >= 2) {
    const tail = series.slice(-3)
    const head = series.slice(-6, -3)
    if (head.length) {
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
      energyTrajectory = mean(tail) - mean(head)
    }
  }

  return {
    sessionId: session.id,
    daypart: session.daypart as DaypartBlock,
    dayKind: session.dayKind as DayKind,
    sessionListens: recent,
    vibeInputs: { completionRate, skipStormCount, energyTrajectory },
  }
}
