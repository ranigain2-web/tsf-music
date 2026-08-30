/**
 * SEARCH V2 · YT MUSIC source — InnerTube catalog search with the
 * reference's row classification + junk filter (TSF-MUSIC v3.4
 * src/api/youtube.ts, search section) and its kill switch, adapted to OUR
 * innertube layer (src/lib/ytm/innertube.ts ytmFetch — already cached,
 * retrying, WEB_REMIX-contexted).
 *
 *   search   → WEB_REMIX YT Music catalog; Song entities first, then
 *              video rows ≤15 min (junk-filtered: news/episode/profile
 *              rows leak through recursive walkers — a real music row has
 *              a Song/Video type label or a parseable duration)
 *   kill     → 3 consecutive SEARCH failures soft-disable the source for
 *              1 h (auto-retry); ytAvailable() gates every entry point
 *              and the response carries ytUnavailable for honesty.
 */

import { ytmFetch } from '@/lib/ytm/innertube'
import { parseHumanCount, type SearchRow } from './rows'

// ── kill switch (reference BAR 6: breakage can never degrade the core) ──

const SOFT_DISABLE_MS = 60 * 60 * 1000
const FAILURE_LIMIT = 3
const ytState = { failures: 0, disabledUntil: 0 }

export function ytAvailable(now: number = Date.now()): boolean {
  return now >= ytState.disabledUntil
}
export function noteYtFailure(now: number = Date.now()): void {
  ytState.failures += 1
  if (ytState.failures >= FAILURE_LIMIT) {
    ytState.disabledUntil = now + SOFT_DISABLE_MS
    ytState.failures = 0
  }
}
export function noteYtSuccess(): void {
  ytState.failures = 0
  ytState.disabledUntil = 0
}

// ── row classification (reference toTrack + collect walker) ──

function parseDuration(text: string | undefined): number {
  if (!text) return 0
  const parts = text.split(':').map((p) => parseInt(p, 10))
  if (parts.some((p) => Number.isNaN(p))) return 0
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

function firstVideoId(item: any): string | null {
  const text = JSON.stringify(item)
  const m = text.match(/"watchEndpoint":\{"videoId":"([\w-]{11})"/)
  return m ? m[1] : null
}

function thumbFrom(renderer: any): string {
  const thumbs =
    renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? []
  const best = thumbs[thumbs.length - 1]?.url
  return best ? best.replace(/^\/\//, 'https://') : ''
}

/** Map one YT-Music list item to an engine row (Song/Video rows only). */
function toRow(item: any): SearchRow | null {
  const r = item?.musicResponsiveListItemRenderer
  if (!r) return null
  const runs = (col: number) =>
    r.flexColumns?.[col]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? []
  const title = runs(0)[0]?.text
  const videoId = firstVideoId(r) ?? runs(0)[0]?.navigationEndpoint?.watchEndpoint?.videoId
  if (!title || !videoId) return null
  const subtitle = runs(1)
    .map((x: any) => x.text ?? '')
    .join('')
  const kindWord = subtitle.split('•')[0]?.trim().toLowerCase() ?? ''
  const ytKind: 'song' | 'video' = kindWord === 'video' ? 'video' : 'song'
  // "Song • Pritam, Atif Aslam & Amitabh Bhattacharya · 3:51" /
  // "Video • LYRICAL BAM HINDI • 6.2M views • 4:28" /
  // degenerate "Song • 3.3M views • 4:27" (no artist segment at all)
  const segs = subtitle.split('•').map((s: string) => s.trim())
  const durationSeg = [...segs].reverse().find((s: string) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(s))
  const playsSeg = segs.find((s: string) => /views|plays/i.test(s))
  // artist segment = first segment after the kind word that is neither the
  // play-count nor the duration — view counts must never become artist names
  const artistSeg =
    segs
      .slice(1)
      .find((s: string) => s && !/views|plays/i.test(s) && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) ?? ''
  return {
    id: videoId,
    videoId,
    ytKind,
    title,
    artistName: artistSeg || 'YouTube',
    artistsFull: artistSeg
      ? artistSeg.split(/,|&/).map((a: string) => a.trim()).filter(Boolean)
      : undefined,
    thumbnail: thumbFrom(r),
    duration: parseDuration(durationSeg),
    source: 'youtube',
    playCount: playsSeg ? parseHumanCount(playsSeg) : undefined,
    playsRaw: playsSeg,
  }
}

const JUNK_KINDS = new Set(['episode', 'podcast', 'profile'])

export interface YtSearchOutcome {
  tracks: SearchRow[]
  latencyMs: number
  /** soft-disabled state at call time (honesty flag for the response) */
  unavailable: boolean
}

/** YT Music catalog search — Songs first, then videos ≤15 min; Albums are
 *  NOT surfaced as rows (the album route lives in the rescue ladder).
 *  Kill-switch gated: a soft-disabled source answers empty immediately —
 *  no requests, honest fast degradation. Never throws. */
export async function ytSearchMusic(
  query: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<YtSearchOutcome> {
  const t0 = Date.now()
  if (!ytAvailable()) {
    return { tracks: [], latencyMs: 0, unavailable: true }
  }
  if (signal?.aborted) return { tracks: [], latencyMs: 0, unavailable: false }
  let data: any = null
  try {
    data = await ytmFetch<any>(
      'search',
      { query },
      // search freshness: short memory cache; the engine has its own LRU
      { cacheTtlMinutes: 10, retries: 1 },
    )
    noteYtSuccess()
  } catch {
    noteYtFailure()
    return { tracks: [], latencyMs: Date.now() - t0, unavailable: !ytAvailable() }
  }

  const tracks: SearchRow[] = []
  const shelves =
    data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents ?? []
  const collect = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (node.musicResponsiveListItemRenderer) {
      const runs = node.musicResponsiveListItemRenderer?.flexColumns?.[1]
        ?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? []
      const kind = (runs[0]?.text ?? '').toLowerCase()
      // podcast/profile/episode rows never enter a music search
      if (!JUNK_KINDS.has(kind)) {
        const t = toRow(node)
        if (t) tracks.push(t)
      }
    }
    for (const k of Object.keys(node)) collect(node[k])
  }
  // YouTube morphs shelf containers (musicShelfRenderer → itemSection/
  // musicCardShelf variants) — seed the recursive walker from EVERY
  // section so shape changes degrade to the same item set, never zero.
  for (const shelf of shelves) collect(shelf)

  // songs first, videos after; drop junk (news/date-only rows leak through
  // the recursive walker — a real music row has a song badge or a
  // parseable duration); cap videos at 15 min
  const songs = tracks.filter((t) => t.ytKind === 'song')
  const videos = tracks.filter(
    (t) => t.ytKind !== 'song' && (t.duration ?? 0) > 0 && (t.duration ?? 0) <= 15 * 60,
  )
  const seen = new Set<string>()
  const merged = [...songs, ...videos].filter((t) => {
    if (seen.has(t.id)) return false
    seen.add(t.id)
    return true
  })
  return { tracks: merged.slice(0, limit), latencyMs: Date.now() - t0, unavailable: false }
}
