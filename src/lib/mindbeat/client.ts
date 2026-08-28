/**
 * MINDBEAT v2.0 — Client-side event instrumentation
 *
 * The browser-side half of the ledger pipeline (constitution:
 * src/lib/mindbeat/types.ts — read-only contract). This module:
 *
 *   1. manages the listen session (30-min gap rule, SESSION_GAP_MIN),
 *   2. batches LedgerEventIn objects and POSTs them to /api/mindbeat/ledger
 *      (route owned by agent 13-a — this file only sends),
 *   3. exposes typed event constructors for every EventType,
 *   4. grades listens (gradeOf) and buckets skips (skipBucketOf),
 *   5. resolves the SURFACE a track came from (queue-source stamps +
 *      playback context), so TRACK_START/TRACK_END carry wasRecommended
 *      without any component having to pass it down.
 *
 * DESIGN RULES:
 *   - Kill switch: localStorage 'tsf-mindbeat-off' === 'on' disables ALL
 *     capture (checked per-event, not just at init).
 *   - Never throws, never blocks playback: every storage/network call is
 *     guarded; failures degrade to "event dropped".
 *   - Network is relative-path fetch with keepalive so events survive
 *     pagehide; the module self-initializes on first import in a client
 *     component (AudioEngine) — no provider, no AppShell wiring needed.
 */

import {
  HEARTBEAT_SEC,
  SESSION_GAP_MIN,
  currentDaypart,
  type EventType,
  type LedgerEventIn,
  type ListenGrade,
  type ReasonCode,
  type SourceSurface,
} from './types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KILL_KEY = 'tsf-mindbeat-off'
const SESSION_KEY = 'tsf-mb-session'
const LEDGER_PATH = '/api/mindbeat/ledger'
const FLUSH_MS = 5_000            // trailing batch window
const MAX_QUEUE = 100             // hard cap on unsent events (drop oldest)
const SKIP_FLAG_TTL_MS = 5_000    // notifyUserSkip() window (covers React flush latency)
const SEEK_THROTTLE_MS = 2_000    // max 1 TRACK_SEEK per 2s
const SEARCH_DEDUP_MS = 1_500     // identical query re-emit guard
const QS_TTL_MS = 24 * 60 * 60 * 1000 // queue-source stamp TTL
const QS_CAP = 500                // queue-source stamp cap

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

/** MindBeat capture runs unless the user/ops flipped the kill switch on. */
export function isEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(KILL_KEY) !== 'on'
  } catch {
    return true // storage unavailable → default to capture-on; emits still guard themselves
  }
}

// ---------------------------------------------------------------------------
// ULID (tiny monotonic implementation — Crockford base32)
// ---------------------------------------------------------------------------

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let lastUlidTs = 0

function randChars(count: number): string {
  let s = ''
  try {
    const bytes = new Uint8Array(count)
    crypto.getRandomValues(bytes)
    for (let i = 0; i < count; i++) s += ULID_ALPHABET[bytes[i] % 32]
    return s
  } catch {
    for (let i = 0; i < count; i++) s += ULID_ALPHABET[Math.floor(Math.random() * 32)]
    return s
  }
}

/** 26-char ULID: 10-char monotonic timestamp + 16 chars (80 bits) randomness. */
export function ulid(): string {
  const now = Date.now()
  // monotonic within this document: never reuse (or go backwards on) the ms
  const t = now <= lastUlidTs ? lastUlidTs + 1 : now
  lastUlidTs = t
  let timePart = ''
  let n = t
  for (let i = 0; i < 10; i++) {
    timePart = ULID_ALPHABET[n % 32] + timePart
    n = Math.floor(n / 32)
  }
  return timePart + randChars(16)
}

// ---------------------------------------------------------------------------
// Session manager (30-min gap rule from the constitution)
// ---------------------------------------------------------------------------

let sessionId: string | null = null

function persistSession(): void {
  if (!sessionId) return
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ id: sessionId, lastTs: Date.now() }))
  } catch { /* private mode — session lives in memory only */ }
}

/**
 * Returns the active session id, creating one (and emitting SESSION_START)
 * when there is none or the previous one gapped out > SESSION_GAP_MIN.
 */
function ensureSession(): string {
  if (sessionId) return sessionId
  // try to adopt a recent session
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (raw) {
      const s = JSON.parse(raw) as { id?: string; lastTs?: number }
      if (s && typeof s.id === 'string' && typeof s.lastTs === 'number') {
        if (Date.now() - s.lastTs <= SESSION_GAP_MIN * 60_000) {
          sessionId = s.id
          return sessionId
        }
      }
    }
  } catch { /* fall through to a fresh session */ }
  // fresh session — daypart is computed client-side (constitution §6.3)
  sessionId = ulid()
  const { block, dayKind } = currentDaypart()
  enqueue(buildEvent('SESSION_START', { payload: { daypart: block, dayKind } }))
  persistSession()
  return sessionId
}

/** Session id for the current browsing context ('ssr' on the server). */
export function getSessionId(): string {
  if (typeof window === 'undefined') return 'ssr'
  try {
    return ensureSession()
  } catch {
    return 'unknown'
  }
}

function touchSession(): void {
  persistSession() // lastTs moves on every event → the 30-min gap measures activity
}

// ---------------------------------------------------------------------------
// Batch queue → POST /api/mindbeat/ledger
// ---------------------------------------------------------------------------

const pending: LedgerEventIn[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushInFlight = false

function capQueue(): void {
  if (pending.length > MAX_QUEUE) pending.splice(0, pending.length - MAX_QUEUE)
}

function scheduleFlush(): void {
  if (flushTimer != null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, FLUSH_MS)
}

/**
 * Sends the current batch. Clears exactly the sent events on success; on
 * failure KEEPS everything (capped at MAX_QUEUE, oldest dropped first).
 * keepalive lets the POST survive pagehide/unload.
 */
export function flush(): void {
  if (flushInFlight || pending.length === 0) return
  if (typeof fetch !== 'function') return
  const batch = pending.slice(0, MAX_QUEUE)
  flushInFlight = true
  try {
    fetch(LEDGER_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    })
      .then((r) => {
        if (r.ok) pending.splice(0, batch.length)
        else capQueue()
      })
      .catch(() => capQueue())
      .finally(() => {
        flushInFlight = false
      })
  } catch {
    flushInFlight = false
    capQueue()
  }
}

// ---------------------------------------------------------------------------
// Event builder + enqueue
// ---------------------------------------------------------------------------

type EventFields = Omit<LedgerEventIn, 'id' | 'ts' | 'type' | 'sessionId'>

function buildEvent(type: EventType, fields: EventFields = {}): LedgerEventIn {
  return {
    id: ulid(),
    ts: new Date().toISOString(),
    type,
    sessionId: getSessionId(),
    ...fields,
  }
}

/**
 * Pushes an event onto the batch queue and schedules the flush.
 * `skip` marks an event that was throttled/deduped (returned to the caller
 * for typing but intentionally NOT enqueued). All capture no-ops when the
 * kill switch is on.
 */
function enqueue(ev: LedgerEventIn, skip = false): LedgerEventIn {
  if (!skip && isEnabled()) {
    pending.push(ev)
    if (pending.length >= MAX_QUEUE) flush()
    else scheduleFlush()
    touchSession()
  }
  return ev
}

// ---------------------------------------------------------------------------
// Current playback context + queue-source stamps (surface resolution)
// ---------------------------------------------------------------------------

export interface PlaybackContext {
  surface: SourceSurface
  wasRecommended: boolean
  reasonCode?: ReasonCode
}

let playCtx: PlaybackContext = { surface: 'user_queue', wasRecommended: false }

/** Stamp the module-level context used for tracks whose source isn't known better. */
export function setPlaybackContext(ctx: Partial<PlaybackContext>): void {
  playCtx = {
    surface: ctx.surface ?? playCtx.surface,
    wasRecommended: ctx.wasRecommended ?? playCtx.wasRecommended,
    reasonCode: ctx.reasonCode ?? playCtx.reasonCode,
  }
}

export function getPlaybackContext(): PlaybackContext {
  return { ...playCtx }
}

// queue-source stamps: videoId → the rec surface this track was served from
interface QueueSourceStamp {
  surface: SourceSurface
  reasonCode?: ReasonCode
  ts: number
}
const queueSources = new Map<string, QueueSourceStamp>()

function freshQueueSource(videoId: string): QueueSourceStamp | null {
  const s = queueSources.get(videoId)
  if (!s) return null
  if (Date.now() - s.ts > QS_TTL_MS) {
    queueSources.delete(videoId)
    return null
  }
  return s
}

/**
 * Marks tracks as having been EXPOSED by a recommendation surface
 * (AI playlist open, Smart Shuffle application, …). trackStart resolves
 * these stamps so TRACK_START/TRACK_END carry surface + wasRecommended +
 * reasonCode without threading props. TTL 24h, cap 500 (oldest evicted).
 */
export function markQueueSource(
  tracks: Array<{ videoId?: string } | null | undefined>,
  surface: SourceSurface,
  reasonCode?: ReasonCode
): void {
  if (typeof window === 'undefined') return
  const now = Date.now()
  for (const t of tracks) {
    if (!t || !t.videoId) continue
    queueSources.set(t.videoId, { surface, reasonCode, ts: now })
  }
  while (queueSources.size > QS_CAP) {
    const oldest = queueSources.keys().next().value
    if (oldest === undefined) break
    queueSources.delete(oldest)
  }
}

/**
 * Resolves the surface context for a track about to START:
 *   queue-source stamp (rec surfaces win) > module playback context.
 */
export function resolveTrackContext(videoId: string): PlaybackContext {
  const qs = freshQueueSource(videoId)
  if (qs) return { surface: qs.surface, wasRecommended: true, reasonCode: qs.reasonCode }
  return { ...playCtx }
}

/** Maps the nav view a component is rendered in to a SourceSurface. */
export function surfaceForNavView(view: { type: string }): SourceSurface {
  switch (view.type) {
    case 'search':
      return 'search'
    case 'liked':
      return 'liked'
    case 'playlist':
      return 'user_playlist'
    case 'album':
      return 'album'
    case 'artist':
      return 'artist'
    case 'ai-generated':
    case 'mood':
      return 'ai_playlist'
    default:
      return 'user_queue'
  }
}

// ---------------------------------------------------------------------------
// User-skip flag (set by the player store BEFORE the track change lands,
// consumed by the next trackEnd → emitted as TRACK_SKIP instead of TRACK_END)
// ---------------------------------------------------------------------------

let userSkipUntil = 0

/** Called by player.next()/prev() for user-initiated advances. */
export function notifyUserSkip(): void {
  if (typeof window === 'undefined') return
  userSkipUntil = Date.now() + SKIP_FLAG_TTL_MS
}

// ---------------------------------------------------------------------------
// Listen grading (constitution §5.2 — thresholds are plan Appendix C values)
// ---------------------------------------------------------------------------

/**
 * Grade a listen from real listened-ms. Without a usable duration the grade
 * rides on listened time alone (<5s INSTANT_REJECT, <30s EARLY_SKIP, else
 * MID_SKIP); with a duration, completion ≥95% is COMPLETED, ≥75% LATE_SKIP.
 */
export function gradeOf(listenedMs: number, durationMs?: number): ListenGrade {
  const listened = Math.max(0, Math.round(listenedMs || 0))
  const durMs = durationMs && durationMs > 0 ? Math.round(durationMs) : 0
  if (listened < 5_000) return 'INSTANT_REJECT'
  if (durMs > 0) {
    const ratio = listened / durMs
    if (ratio >= 0.95) return 'COMPLETED'
    if (listened < 30_000) return 'EARLY_SKIP'
    if (ratio >= 0.75) return 'LATE_SKIP'
    return 'MID_SKIP'
  }
  if (listened < 30_000) return 'EARLY_SKIP'
  return 'MID_SKIP'
}

/** Decile bucket of completion (1..10) for the per-track skip profile. */
export function skipBucketOf(ratio: number): number {
  const r = isFinite(ratio) && ratio > 0 ? ratio : 0
  return Math.max(1, Math.min(10, Math.ceil(r * 10)))
}

// ---------------------------------------------------------------------------
// Event constructors
// ---------------------------------------------------------------------------

export interface TrackStartInfo {
  videoId: string
  artistId?: string
  artistName?: string
}

export interface TrackStartOpts {
  surface?: SourceSurface
  queuePosition?: number
  wasRecommended?: boolean
  reasonCode?: ReasonCode
  duration?: number // seconds
}

export function trackStart(track: TrackStartInfo, opts: TrackStartOpts): LedgerEventIn {
  return enqueue(
    buildEvent('TRACK_START', {
      trackId: track.videoId,
      artistId: track.artistId,
      artistName: track.artistName,
      surface: opts.surface,
      payload: {
        queuePosition: opts.queuePosition,
        wasRecommended: opts.wasRecommended ?? false,
        reasonCode: opts.reasonCode,
        durationSec:
          opts.duration && isFinite(opts.duration) && opts.duration > 0
            ? Math.round(opts.duration)
            : undefined,
      },
    })
  )
}

export function heartbeat(trackId: string, elapsedMs: number): LedgerEventIn {
  return enqueue(
    buildEvent('TRACK_HEARTBEAT', {
      trackId,
      payload: { elapsedMs: Math.max(0, Math.round(elapsedMs || 0)) },
    })
  )
}

export interface TrackEndOpts {
  listenedMs: number
  durationMs?: number
  grade?: ListenGrade
  completionRatio?: number
  skipBucket?: number
  wasRecommended?: boolean
  reasonCode?: ReasonCode
  surface?: SourceSurface
}

/**
 * Listen end. If notifyUserSkip() fired within the last SKIP_FLAG_TTL_MS
 * (a user-initiated next/prev), this becomes an explicit TRACK_SKIP;
 * otherwise a graded TRACK_END.
 */
export function trackEnd(trackId: string, opts: TrackEndOpts & { forceType?: 'TRACK_SKIP' | 'TRACK_END' }): LedgerEventIn {
  const listened = Math.max(0, Math.round(opts.listenedMs || 0))
  const durMs = opts.durationMs && opts.durationMs > 0 ? Math.round(opts.durationMs) : 0
  const ratio = durMs > 0 ? Math.min(1, listened / durMs) : 0
  const isUserSkip = Date.now() < userSkipUntil
  if (isUserSkip) userSkipUntil = 0
  const evType = opts.forceType ?? (isUserSkip ? 'TRACK_SKIP' : 'TRACK_END')
  return enqueue(
    buildEvent(evType, {
      trackId,
      surface: opts.surface,
      payload: {
        listenedMs: listened,
        durationMs: durMs,
        grade: opts.grade ?? gradeOf(listened, durMs),
        completionRatio: opts.completionRatio ?? ratio,
        skipBucket: opts.skipBucket ?? skipBucketOf(ratio),
        wasRecommended: opts.wasRecommended ?? false,
        reasonCode: opts.reasonCode,
      },
    })
  )
}

let lastSeekEmit = 0

export function seek(trackId: string, fromMs: number, toMs: number): LedgerEventIn {
  const now = Date.now()
  const throttled = now - lastSeekEmit < SEEK_THROTTLE_MS
  if (!throttled) lastSeekEmit = now
  return enqueue(
    buildEvent('TRACK_SEEK', { trackId, payload: { fromMs: Math.round(fromMs || 0), toMs: Math.round(toMs || 0) } }),
    throttled
  )
}

export function like(
  trackId: string,
  artistId?: string,
  artistName?: string,
  surface?: SourceSurface
): LedgerEventIn {
  return enqueue(buildEvent('TRACK_LIKE', { trackId, artistId, artistName, surface }))
}

export function unlike(trackId: string): LedgerEventIn {
  return enqueue(buildEvent('TRACK_UNLIKE', { trackId }))
}

export function download(trackId: string): LedgerEventIn {
  return enqueue(buildEvent('TRACK_DOWNLOAD', { trackId }))
}

export function queueAdd(trackId: string, targetSurface: SourceSurface): LedgerEventIn {
  return enqueue(buildEvent('QUEUE_ADD_MANUAL', { trackId, payload: { targetSurface } }))
}

export function queueRemove(trackId: string, wasRecommended?: boolean): LedgerEventIn {
  // resolve recommendation from the queue-source stamp when the caller doesn't know
  const rec = wasRecommended ?? freshQueueSource(trackId) != null
  return enqueue(buildEvent('QUEUE_REMOVE', { trackId, payload: { wasRecommended: rec } }))
}

export function recExposure(
  trackId: string,
  surface: SourceSurface,
  rankInPool: number,
  reasonCode?: ReasonCode
): LedgerEventIn {
  return enqueue(
    buildEvent('REC_EXPOSURE', { trackId, surface, payload: { rankInPool, reasonCode } })
  )
}

let lastSearchQ = ''
let lastSearchAt = 0

export function searchQuery(query: string, resultCount: number): LedgerEventIn {
  const now = Date.now()
  const dup = query === lastSearchQ && now - lastSearchAt < SEARCH_DEDUP_MS
  lastSearchQ = query
  lastSearchAt = now
  return enqueue(
    buildEvent('SEARCH_QUERY', { payload: { query, resultCount } }),
    dup
  )
}

export function searchClick(trackId: string, rankInResults: number): LedgerEventIn {
  return enqueue(
    buildEvent('SEARCH_CLICK', { trackId, payload: { rankInResults } })
  )
}

export function playlistSaveAi(playlistId: string, promptHash: string): LedgerEventIn {
  return enqueue(
    buildEvent('PLAYLIST_SAVE_AI', { payload: { playlistId, promptHash } })
  )
}

export function aiRegenerate(promptHash: string, variantIndex: number): LedgerEventIn {
  return enqueue(
    buildEvent('AI_REGENERATE', { payload: { promptHash, variantIndex } })
  )
}

export function notForMe(trackId: string, surface?: SourceSurface): LedgerEventIn {
  return enqueue(buildEvent('NOT_FOR_ME', { trackId, surface }))
}

export function stationEnded(tracksServed: number, avgListenRatio: number): LedgerEventIn {
  return enqueue(
    buildEvent('STATION_ENDED', {
      payload: { tracksServed, avgListenRatio: isFinite(avgListenRatio) ? avgListenRatio : 0 },
    })
  )
}

export function appBackground(): LedgerEventIn {
  return enqueue(buildEvent('APP_BACKGROUND', {}))
}

// ---------------------------------------------------------------------------
// Heartbeat timer (constitution: HEARTBEAT_SEC interval, only while playing —
// the getTrackId callback returns null when playback is paused)
// ---------------------------------------------------------------------------

let hbTimer: ReturnType<typeof setInterval> | null = null
let hbGetTrackId: (() => string | null) | null = null
let hbGetElapsed: (() => number) | null = null

export function startHeartbeats(
  getTrackId: () => string | null,
  getElapsedMs: () => number
): void {
  if (typeof window === 'undefined') return
  stopHeartbeats()
  hbGetTrackId = getTrackId
  hbGetElapsed = getElapsedMs
  hbTimer = setInterval(() => {
    try {
      const id = hbGetTrackId?.()
      if (!id) return
      heartbeat(id, hbGetElapsed?.() ?? 0)
    } catch { /* instrumentation only */ }
  }, HEARTBEAT_SEC * 1000)
}

export function stopHeartbeats(): void {
  if (hbTimer != null) {
    clearInterval(hbTimer)
    hbTimer = null
  }
  hbGetTrackId = null
  hbGetElapsed = null
}

// ---------------------------------------------------------------------------
// Module init (client only — self-initializes on first import by AudioEngine)
// ---------------------------------------------------------------------------

let initDone = false

function init(): void {
  if (initDone || typeof window === 'undefined') return
  initDone = true
  try {
    if (isEnabled()) ensureSession()
  } catch { /* session starts lazily on first event instead */ }
  // flush the batch when the page hides or the tab goes to background
  // (keepalive on the POST keeps it alive through unload)
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush()
  }
  const onPageHide = () => flush()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
}

init()
