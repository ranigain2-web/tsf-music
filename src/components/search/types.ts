'use client'

/**
 * SEARCH V2 · client-side view of the engine contract.
 *
 * These types mirror EXACTLY what /api/ytm/search-v2 and
 * /api/ytm/typeahead emit (plain-NDJSON + JSON) — no invented fields.
 * Row extras (reason/reasonCode/lyricMatch/versionCount/ytKind/…) come
 * from src/lib/search-v2/rows.ts; reason lines are a CLOSED set — the UI
 * renders `reason` verbatim and never invents strings.
 */

export type SearchSourceKey = 'catalog' | 'youtube'

/** One engine result row (subset the UI consumes). Playable rows carry
 *  videoId; iTunes preview rows carry previewUrl only (truthfully
 *  labelled, never queued into the videoId player). */
export interface SearchRow {
  id: string
  videoId?: string
  title: string
  artistName: string
  artistId?: string
  albumName?: string
  albumId?: string
  duration: number
  thumbnail: string
  year?: number
  explicit?: boolean
  source: 'ytm' | 'youtube' | 'saavn' | 'itunes'
  artistsFull?: string[]
  featuredArtists?: string[]
  playCount?: number
  playsRaw?: string
  previewOnly?: boolean
  previewUrl?: string
  ytKind?: 'song' | 'video'
  pool?: string
  poolRank?: number
  reason?: string
  reasonCode?: string
  versionCount?: number
  lyricMatch?: boolean
  matchedLine?: string
  rescued?: boolean
  rescueRung?: string
}

export interface SearchPlanLite {
  raw: string
  normalized: string
  kind: string
  titleTokens: string[]
  artistTokens: string[]
  variants: string[]
  corrections: Array<{ from: string; to: string }>
}

/** The `final` NDJSON line's result payload — exactly serializeResult()
 *  in the route plus the youtube/vibe extras. */
export interface SearchV2Final {
  rows: SearchRow[]
  plan?: SearchPlanLite
  topReason?: string
  corrected?: string
  relaxedFrom?: string
  relaxedQuery?: string
  latencyMs?: number
  correlationId?: string | null
  probes?: string[]
  sigState?: 'hit' | 'rescued' | 'partial' | 'zero'
  partialArtists?: string[]
  rescueRung?: string
  // youtube source extras
  ytUnavailable?: boolean
  source?: 'youtube'
  // vibe extras (engine route's in-process delegation)
  vibe?: {
    shortcut: { prompt: string }
    artistsLike: Array<{ id?: string; name: string }>
    intentConfidence?: number
  }
}

/** The `early` NDJSON line — progressive paint (may be skipped on a
 *  cache hit; the final line follows instantly). */
export interface SearchEarly {
  type: 'early'
  rows: SearchRow[]
  corrected?: string
  planKind?: string
  latencyMs?: number
  correlationId?: string | null
}

export type SearchFinalLine = { type: 'final'; result?: SearchV2Final; error?: string }

export type SearchV2State =
  | { phase: 'idle' }
  | { phase: 'loading'; source: SearchSourceKey }
  /** progressive paint: rows exist, final hasn't landed yet */
  | { phase: 'refining'; source: SearchSourceKey; early: SearchEarly }
  | { phase: 'ready'; source: SearchSourceKey; final: SearchV2Final; error?: string }

/** /api/ytm/typeahead payload (route NEVER throws — failure degrades to
 *  recents-only on the client). */
export interface TypeaheadPayload {
  recents: string[]
  songs?: Array<{
    videoId: string
    title: string
    artistName: string
    artistId?: string
    albumName?: string
    duration: number
    thumbnail: string
    year?: number
  }>
  artists?: Array<{ id: string; name: string; thumbnail: string }>
  bestGuess?: NonNullable<TypeaheadPayload['songs']>[number]
  deadlineHit?: boolean
}
