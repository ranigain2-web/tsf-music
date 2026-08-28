/**
 * MINDBEAT v2.0 — THE CONSTITUTION (shared contract for every layer)
 *
 * Source: the user's improvement plan ("SUGGESTION PLAN — IMPROVING AI,
 * Project MINDBEAT v2.0 · Industrial Edition"). Every number here is the
 * plan's starting value from Appendix C — tunable, never magic.
 *
 * THE ONE DATA-FLOW RULE: surfaces never read the raw ledger; they ask the
 * Decision Engine. The Decision Engine never mutates memory; only the ledger
 * route writes, through batched, serialized writes.
 */

// ---------------------------------------------------------------------------
// Events (L1)
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'SESSION_START', 'APP_BACKGROUND', 'TRACK_START', 'TRACK_HEARTBEAT',
  'TRACK_SKIP', 'TRACK_END', 'TRACK_SEEK', 'TRACK_LIKE', 'TRACK_UNLIKE',
  'TRACK_DOWNLOAD', 'QUEUE_ADD_MANUAL', 'QUEUE_REMOVE', 'REC_EXPOSURE',
  'SEARCH_QUERY', 'SEARCH_CLICK', 'PLAYLIST_SAVE_AI', 'AI_REGENERATE',
  'NOT_FOR_ME', 'STATION_ENDED',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const SOURCE_SURFACES = [
  'user_playlist', 'user_queue', 'search', 'chart', 'daily_mix', 'smart_shuffle_rec',
  'radio', 'ai_playlist', 'daylist', 'discovery', 'onboarding', 'liked', 'album', 'artist',
] as const
export type SourceSurface = (typeof SOURCE_SURFACES)[number]

/** Listen grades — a skip is not a boolean (plan §5.2). */
export type ListenGrade =
  | 'INSTANT_REJECT'  // skip < 5s            — wrong context more than wrong song
  | 'EARLY_SKIP'      // 5–30s
  | 'MID_SKIP'        // 30–75% of duration
  | 'LATE_SKIP'       // ≥ 75%
  | 'COMPLETED'       // ≥ 95% or natural end

/** Grade → artist evidence weight (Appendix C). */
export const GRADE_WEIGHTS: Record<ListenGrade, number> = {
  INSTANT_REJECT: -3.0,
  EARLY_SKIP: -1.5,
  MID_SKIP: -0.5,
  LATE_SKIP: 0.5,
  COMPLETED: 2.0,
}
/** Extra evidence actions. */
export const ACTION_WEIGHTS = {
  HEART: 4.0,
  HEART_CONTRADICT: 1.0, // collapsed heart after 2 instant-skips
  DOWNLOAD: 2.5,
  REPLAY_BONUS: 1.0,
  NOT_FOR_ME_TRACK: -4.0,
  NOT_FOR_ME_ARTIST: -1.0,
} as const

/** Grade blame split — evidence distributed across accounts (plan §5.2). */
export const GRADE_BLAME_SPLIT: Record<ListenGrade, { artist: number; track: number; mood: number; session: number }> = {
  INSTANT_REJECT: { artist: 0.4, track: 0.2, mood: 0.2, session: 0.2 },
  EARLY_SKIP: { artist: 0.5, track: 0.25, mood: 0.25, session: 0 },
  MID_SKIP: { artist: 0.6, track: 0.3, mood: 0.1, session: 0 },
  LATE_SKIP: { artist: 0.6, track: 0.3, mood: 0.1, session: 0 },
  COMPLETED: { artist: 0.6, track: 0.3, mood: 0.1, session: 0 },
}

// ---------------------------------------------------------------------------
// Session (L1/L3)
// ---------------------------------------------------------------------------

export const SESSION_GAP_MIN = 30          // minutes without TRACK_START ends a session
export const SESSION_WINDOW = 12           // sliding window of graded listens
export const SESSION_RECENCY_TIERS = [3, 2, 1] // most recent 3 weigh 3×, next 4 weigh 2×, rest 1×
export const SKIP_STORM_THRESHOLD = 3      // instant-rejects within…
export const SKIP_STORM_WINDOW = 6         // …last 6 tracks
export const HEARTBEAT_SEC = 10

// ---------------------------------------------------------------------------
// Daypart matrix (L2) — Heggli-verified 5 blocks × weekday/weekend (plan §6.3)
// ---------------------------------------------------------------------------

export const DAYPART_BLOCKS = ['morning', 'afternoon', 'evening', 'night', 'lateNight'] as const
export type DaypartBlock = (typeof DAYPART_BLOCKS)[number]
export type DayKind = 'weekday' | 'weekend'

/** Block boundary start hours [weekday, weekend]. lateNight wraps midnight. */
export const BLOCK_BOUNDARIES: Record<DaypartBlock, [number, number]> = {
  morning: [5, 7],
  afternoon: [11, 12],
  evening: [16, 17],
  night: [20, 21],
  lateNight: [0, 1], // weekday lateNight = 00–05; weekend = 01–07
}

export function currentDaypart(now = new Date()): { block: DaypartBlock; dayKind: DayKind } {
  const h = now.getHours()
  const dow = now.getDay()
  const dayKind: DayKind = dow === 0 || dow === 6 ? 'weekend' : 'weekday'
  const i = dayKind === 'weekday' ? 0 : 1
  // ordered check with midnight wrap for lateNight
  const inBlock = (start: number, nextStart: number) =>
    start < nextStart ? h >= start && h < nextStart : h >= start || h < nextStart
  if (inBlock(BLOCK_BOUNDARIES.morning[i], BLOCK_BOUNDARIES.afternoon[i])) return { block: 'morning', dayKind }
  if (inBlock(BLOCK_BOUNDARIES.afternoon[i], BLOCK_BOUNDARIES.evening[i])) return { block: 'afternoon', dayKind }
  if (inBlock(BLOCK_BOUNDARIES.evening[i], BLOCK_BOUNDARIES.night[i])) return { block: 'night', dayKind }
  if (inBlock(BLOCK_BOUNDARIES.night[i], BLOCK_BOUNDARIES.lateNight[i])) return { block: 'night', dayKind }
  return { block: 'lateNight', dayKind }
}

// ---------------------------------------------------------------------------
// Decay (L2) — lazy at read time: effective = stored · 0.5^(ageDays/halfLife)
// ---------------------------------------------------------------------------

export const HALF_LIFE_DAYS = {
  heart: 180,
  artist: 45,
  genre: 60,
  language: 90,
  era: 120,
  daypartCell: 30,
  skipProfile: 180,
  coplayEdge: 60,
  sourceTrust: 21,
} as const

/** Popularity damping: famous artists must earn 3× the evidence (plan §6.2). */
export const POPULARITY_DAMPING = 3.0
/** Binge damping: per-artist per-day evidence capped at 8 listens' worth. */
export const BINGE_CAP_PER_DAY = 8

// ---------------------------------------------------------------------------
// Decision Engine (L4) — scoring contract (plan §8.3)
// ---------------------------------------------------------------------------

export const SCORE_WEIGHTS = {
  profileAffinity: 1.0, // w1 — the long-term "you"
  sessionFit: 1.2,      // w2 — reading the room beats knowing the person
  daypartFit: 0.8,      // w3
  freshness: 0.6,       // w4
  sourceTrust: 0.4,     // w5
} as const

export const SESSION_ENERGY_TOLERANCE = 0.2   // vibe-lock band
export const SAME_ARTIST_PER_6_SLOTS = 2      // artist cap within a 6-slot horizon
export const ARTIST_CAP_PER_SEQUENCE = 5      // AI playlist / generated sequences
export const ENERGY_STEP_MAX = 0.25           // max adjacent-slot energy step (arc smoothing)

export const EPSILON = {
  coldStart: 0.5,      // sessions 1–5
  coldStartSessions: 5,
  established: 0.15,
  floor: 0.10,
  autoDropPerWeek: 0.02, // if exploration conversion < 10% in 30d
  storm: 0,              // SKIP_STORM → no experiments during a fire
} as const

/** Truth-conditioned reason codes (plan §8.5). Banned forever: social proof. */
export const REASON_CODES = {
  BECAUSE_PLAYED: 'Because you played {artist} a lot',
  BECAUSE_HEARTED: 'You loved {artist}',
  NEIGHBOR: 'You keep playing this next to {track}',
  FITS_BLOCK: 'Fits your {block} sound',
  SESSION_CONTINUITY: 'Keeps tonight\u2019s mood going',
  FRESH_FIND: 'A fresh find — see if it sticks',
  FROM_YOUR_AI_MIX: 'From the AI mix you saved',
  BACK_FOR_MORE: 'You replayed this last week',
} as const
export type ReasonCode = keyof typeof REASON_CODES

// ---------------------------------------------------------------------------
// Surfaces (L5)
// ---------------------------------------------------------------------------

export const SMART_SHUFFLE = {
  cadenceOver15: 3,     // 1 rec per 3 tracks for >15-track playlists (Spotify-verified)
  cadenceSmall: 3,      // 6–15 tracks: 1 per 3…
  smallMaxRecs: 2,      // …at most 2 total
  healBackoff: 4,       // after a skipped rec: cadence 1:4
  saveTighten: 2,       // after 2 saved recs: cadence 1:2
} as const

export const RADIO = {
  driftEvery: 5,        // every 5th slot is a drift track
  driftMaxConsecutive: 1,
  dedupServes: 100,     // last 100 serves…
  dedupTtlDays: 7,      // …7-day TTL hard blocklist
  prefetchAhead: 2,     // extend 2 slots ahead while playing
} as const

export const MIXES = {
  count: { min: 3, max: 6 },
  corePct: 60,
  bridgePct: 25,
  freshPct: 15,
  repeatFromYesterdayMax: 0.3,
} as const

export const AI_PLAYLIST = {
  poolMin: 60,
  poolMax: 120,
  defaultCount: 25,
  minCount: 18,
  artistCap: 5,
  noArtist3InARow: true,
  intentConfidenceAsk: 0.4,
  regenerateMinDiff: 0.4,
} as const

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** Event payload sent by the client, stored in LedgerEvent.payload JSON. */
export interface LedgerEventIn {
  id: string            // ULID (client-generated; server falls back if absent)
  ts: string            // ISO8601
  type: EventType
  sessionId: string
  trackId?: string
  artistId?: string
  artistName?: string
  surface?: SourceSurface
  payload?: Record<string, unknown>
}

/** A graded listen as reconstructed by the profile compiler. */
export interface ListenRecord {
  trackId: string
  artistId?: string
  artistName?: string
  sessionId: string
  surface?: SourceSurface
  startedTs: string
  listenedMs: number
  durationMs: number
  completionRatio: number
  grade: ListenGrade
  skipBucket?: number // 1..10 — position histogram for the per-track skip profile
  wasRecommended: boolean
  reasonCode?: ReasonCode
}

/** Vibe states (plan §7.2). */
export type VibeState = 'WARMUP' | 'FLOW' | 'PEAK' | 'WIND_DOWN' | 'SKIP_STORM' | 'EXPLORING'

/** A Decision Engine pick, delivered to a surface. */
export interface EnginePick {
  track: {
    videoId: string
    title: string
    artistName: string
    artistId?: string
    duration?: number
    thumbnail?: string
  }
  score: number
  reasonCode: ReasonCode
  reasonLine: string
  explored: boolean   // true if this slot spent the exploration budget
  pool: string        // affinity | neighborhood | daypart | cultural | discovery
}
