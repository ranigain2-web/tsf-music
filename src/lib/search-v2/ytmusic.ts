/**
 * SEARCH V2 · YT MUSIC source — InnerTube catalog search with
 * songs-filter PRIMARY (R8-P2 field fix: lo-fi-first results).
 *
 * Ported from TSF-MUSIC v3.4.5 src/api/youtube.ts search section,
 * adapted to OUR innertube layer (ytmFetch — cached, retrying,
 * WEB_REMIX-contexted):
 *
 *   primary  → SONGS_FILTER_PARAMS query (YouTube Music's own "Songs"
 *              chip params) — official recording first, 20 rows/page,
 *              continuation for page 2+
 *   fallback → raw general query (videos, albums, spell corrections,
 *              rotation-proof chip-params harvest)
 *   top card → musicCardShelfRenderer SKIPPED (it carries lo-fi mixes
 *              for fuzzy queries — "tu chaiye" rank-1 lo-fi fix)
 *   rows     → BOTH subtitle shapes (kind-prefixed general rows +
 *              artist-first filtered rows), Indian-unit play counts
 *   kill     → 3 consecutive SEARCH failures soft-disable 1h
 *   more     → ytSearchMusicMore(cont) continuation walk — resolves
 *              (never rejects); transport failure → {error:true},
 *              token kept, retryable (R8-P3)
 */

import { ytmFetch } from '@/lib/ytm/innertube';
import { parseHumanCount, type SearchRow } from './rows';
import { reconcileRecordings } from './recording';

// ── kill switch (reference BAR 6: breakage can never degrade the core) ──

const SOFT_DISABLE_MS = 60 * 60 * 1000;
const FAILURE_LIMIT = 3;
const ytState = { failures: 0, disabledUntil: 0 };

export function ytAvailable(now: number = Date.now()): boolean {
  return now >= ytState.disabledUntil;
}
export function noteYtFailure(now: number = Date.now()): void {
  ytState.failures += 1;
  if (ytState.failures >= FAILURE_LIMIT) {
    ytState.disabledUntil = now + SOFT_DISABLE_MS;
    ytState.failures = 0;
  }
}
export function noteYtSuccess(): void {
  ytState.failures = 0;
  ytState.disabledUntil = 0;
}

// ── songs-filter params (pinned + rotation-proof harvest) ──

/** Params YouTube Music itself sends for the "Songs" chip (probe-verified). */
export const SONGS_FILTER_PARAMS = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';

/** Subtitle shapes WEB_REMIX emits:
 *  general rows : "Song • Artist • 3:51" / "Video • Channel • 6.2M views • 4:28"
 *  filtered rows: "Artist • Album • 4:25" (NO kind prefix — seg 0 IS artist) */
const KIND_WORDS = new Set([
  'song', 'video', 'album', 'single', 'ep', 'artist', 'playlist',
  'episode', 'podcast', 'profile', 'movie', 'radio',
]);
const VIDEO_KIND_WORDS = new Set(['video', 'episode', 'podcast', 'movie', 'radio']);

/** Harvest CURRENT filter-chip params from a general response (rotation-proof). */
function chipParamsFor(data: unknown, labelRe: RegExp): string | undefined {
  const walk = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      for (const x of node) {
        const hit = walk(x);
        if (hit) return hit;
      }
      return undefined;
    }
    const rec = node as Record<string, unknown>;
    const ccr = rec.chipCloudRenderer as { chips?: Array<{ chipCloudChipRenderer?: { text?: { runs?: Array<{ text?: string }> }; navigationEndpoint?: { searchEndpoint?: { params?: unknown } } } }> } | undefined;
    if (ccr) {
      for (const c of ccr.chips ?? []) {
        const cr = c?.chipCloudChipRenderer;
        const label = cr?.text?.runs?.[0]?.text ?? '';
        if (labelRe.test(label)) {
          const params = cr?.navigationEndpoint?.searchEndpoint?.params;
          if (typeof params === 'string') return params;
        }
      }
      return undefined;
    }
    for (const k of Object.keys(rec)) {
      const hit = walk(rec[k]);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(data);
}

// ── row mapping ──

function parseDuration(text: string | undefined): number {
  if (!text) return 0;
  const parts = text.split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function firstVideoId(item: unknown): string | null {
  const text = JSON.stringify(item);
  const m = text.match(/"watchEndpoint":\{"videoId":"([\w-]{11})"/);
  return m ? m[1] : null;
}

function thumbFrom(renderer: Record<string, unknown>): string {
  const r = renderer as {
    thumbnail?: { musicThumbnailRenderer?: { thumbnail?: { thumbnails?: Array<{ url?: string }> } } };
    thumbnailRenderer?: { musicThumbnailRenderer?: { thumbnail?: { thumbnails?: Array<{ url?: string }> } } };
  };
  const thumbs =
    r?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ??
    r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails ??
    [];
  const best = thumbs[thumbs.length - 1]?.url;
  return best ? best.replace(/^\/\//, 'https://') : '';
}

/** Map one YT-Music list item — handles BOTH subtitle shapes. */
function toRow(item: unknown): SearchRow | null {
  const rec = item as { musicResponsiveListItemRenderer?: Record<string, unknown> };
  const r = rec?.musicResponsiveListItemRenderer as {
    flexColumns?: Array<{ musicResponsiveListItemFlexColumnRenderer?: { text?: { runs?: Array<{ text?: string; navigationEndpoint?: { watchEndpoint?: { videoId?: string } } }> } } }>;
  } | undefined;
  if (!r) return null;
  const runs = (col: number) =>
    r.flexColumns?.[col]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [];
  const title = runs(0)[0]?.text;
  const videoId = firstVideoId(r) ?? runs(0)[0]?.navigationEndpoint?.watchEndpoint?.videoId;
  if (!title || !videoId) return null;
  const subtitle = runs(1)
    .map((x) => x.text ?? '')
    .join('');
  const segs = subtitle.split('•').map((s: string) => s.trim());
  const firstSeg = segs[0] ?? '';
  const kindPrefixed = KIND_WORDS.has(firstSeg.toLowerCase());
  const kindWord = kindPrefixed ? firstSeg.toLowerCase() : '';
  const ytKind: 'song' | 'video' = VIDEO_KIND_WORDS.has(kindWord) ? 'video' : 'song';
  // kind-prefixed: "Song • ARTIST • duration" — artist is seg 1
  // artist-first  : "ARTIST • ALBUM • duration" — artist is seg 0, album seg 1
  const artistSeg = kindPrefixed ? (segs[1] ?? '') : firstSeg;
  const albumSeg = !kindPrefixed ? segs[1] ?? '' : '';
  const durationSeg = [...segs].reverse().find((s: string) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(s));
  const playsSeg = segs.find((s: string) => /views|plays/i.test(s));
  // degenerate general rows ("Song • 3.3M views • 4:27", no artist) —
  // view counts must never become artist names
  const artist =
    artistSeg && !/views|plays/i.test(artistSeg) && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(artistSeg)
      ? artistSeg
      : 'YouTube';
  return {
    id: videoId,
    videoId,
    ytKind,
    title,
    artistName: artist,
    artistsFull: artist !== 'YouTube'
      ? artist.split(/,|&/).map((a: string) => a.trim()).filter(Boolean)
      : undefined,
    albumName: albumSeg || undefined,
    thumbnail: thumbFrom(r as unknown as Record<string, unknown>),
    duration: parseDuration(durationSeg),
    source: 'youtube',
    playCount: playsSeg ? parseHumanCount(playsSeg) : undefined,
    playsRaw: playsSeg,
  };
}

const JUNK_KINDS = new Set(['episode', 'podcast', 'profile']);

function collectRows(data: unknown, skipTopCard = true): { tracks: SearchRow[]; chipSongs?: string } {
  const tracks: SearchRow[] = [];
  const root = data as Record<string, unknown>;
  const tabs = (root?.contents as Record<string, unknown> | undefined)?.tabbedSearchResultsRenderer as
    | { tabs?: Array<{ tabRenderer?: { content?: { sectionListRenderer?: { contents?: unknown[] } } } }> }
    | undefined;
  const shelves = tabs?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  const collect = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    // SKIP the top-result card — it carries lo-fi mixes for fuzzy queries
    if (skipTopCard && rec.musicCardShelfRenderer) return;
    if (rec.musicResponsiveListItemRenderer) {
      const flex = (rec.musicResponsiveListItemRenderer as Record<string, unknown>).flexColumns as
        | Array<{ musicResponsiveListItemFlexColumnRenderer?: { text?: { runs?: Array<{ text?: string }> } } }>
        | undefined;
      const kind = (flex?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text ?? '').toLowerCase();
      if (!JUNK_KINDS.has(kind)) {
        const t = toRow(node);
        if (t) tracks.push(t);
      }
      return;
    }
    for (const k of Object.keys(rec)) collect(rec[k]);
  };
  if (shelves.length) {
    for (const shelf of shelves) collect(shelf);
  } else {
    // continuation responses omit the tabbed wrapper — rows sit directly
    // in continuationItems; walk the whole root (reference parity)
    collect(root);
  }
  const chipSongs = chipParamsFor(data, /^[Ss]ongs$/);
  return { tracks, chipSongs };
}

function continuationOf(data: unknown): string | undefined {
  // songs-shelf token first (page 2+ of the filtered list lives in
  // musicShelfRenderer.continuations → nextContinuationData)
  let shelfToken: string | undefined;
  const shelfWalk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || shelfToken) return;
    if (Array.isArray(node)) {
      for (const x of node) shelfWalk(x);
      return;
    }
    const rec = node as Record<string, unknown>;
    const msr = rec.musicShelfRenderer as { continuations?: Array<{ nextContinuationData?: { continuation?: unknown } }> } | undefined;
    if (msr) {
      for (const c of msr.continuations ?? []) {
        const t = c?.nextContinuationData?.continuation;
        if (typeof t === 'string' && t.length > 8) {
          shelfToken = t;
          return;
        }
      }
    }
    for (const k of Object.keys(rec)) shelfWalk(rec[k]);
  };
  shelfWalk(data);
  if (shelfToken) return shelfToken;
  const root = data as Record<string, unknown>;
  const walk = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      for (const x of node) {
        const hit = walk(x);
        if (hit) return hit;
      }
      return undefined;
    }
    const rec = node as Record<string, unknown>;
    const ncd = rec.nextContinuationData as { continuation?: unknown } | undefined;
    if (typeof ncd?.continuation === 'string' && ncd.continuation.length > 8) return ncd.continuation;
    for (const k of Object.keys(rec)) {
      const hit = walk(rec[k]);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(root);
}

export interface YtSearchOutcome {
  tracks: SearchRow[];
  latencyMs: number;
  unavailable: boolean;
  continuation?: string;
}

export interface YtMoreOutcome {
  tracks: SearchRow[];
  continuation?: string;
  /** transport failure — caller keeps token + hasMore (retryable) */
  error?: boolean;
}

/** YT Music catalog search — songs-filter PRIMARY, raw fallback supplements.
 *  Never throws (kill-switch gated, fail-soft to []). */
export async function ytSearchMusic(
  query: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<YtSearchOutcome> {
  const t0 = Date.now();
  if (!ytAvailable()) {
    return { tracks: [], latencyMs: 0, unavailable: true };
  }
  if (signal?.aborted) return { tracks: [], latencyMs: 0, unavailable: false };
  let primary: unknown = null;
  let fallback: unknown = null;
  try {
    const [p, f] = await Promise.all([
      ytmFetch<unknown>('search', { query, params: SONGS_FILTER_PARAMS }, { cacheTtlMinutes: 10, retries: 1 }).catch(() => null),
      ytmFetch<unknown>('search', { query }, { cacheTtlMinutes: 10, retries: 1 }).catch(() => null),
    ]);
    primary = p;
    fallback = f;
    if (!primary && !fallback) throw new Error('both empty');
    noteYtSuccess();
  } catch {
    noteYtFailure();
    return { tracks: [], latencyMs: Date.now() - t0, unavailable: !ytAvailable() };
  }

  // rotation-proof: if YouTube rotated the songs params, the live chips
  // carry today's value — re-issue primary once with it
  let primaryTracks: SearchRow[] = [];
  let continuation: string | undefined;
  if (primary) {
    const c = collectRows(primary);
    primaryTracks = c.tracks;
    continuation = continuationOf(primary);
    if (c.chipSongs && c.chipSongs !== SONGS_FILTER_PARAMS && primaryTracks.length < 5 && fallback) {
      try {
        const rotated = await ytmFetch<unknown>('search', { query, params: c.chipSongs }, { cacheTtlMinutes: 10, retries: 0 }).catch(() => null);
        if (rotated) {
          const rc = collectRows(rotated);
          if (rc.tracks.length > primaryTracks.length) {
            primaryTracks = rc.tracks;
            continuation = continuationOf(rotated) ?? continuation;
          }
        }
      } catch { /* keep original primary */ }
    }
  }

  const fallbackTracks = fallback ? collectRows(fallback).tracks : [];
  const fbCont = fallback ? continuationOf(fallback) : undefined;
  if (!continuation) continuation = fbCont;

  // merge: songs-filter list FIRST (official recording rank 1), then
  // fallback rows not already present (videos, spell corrections)
  const byId = new Map<string, SearchRow>();
  for (const t of primaryTracks) if (!byId.has(t.id)) byId.set(t.id, t);
  for (const t of fallbackTracks) if (!byId.has(t.id)) byId.set(t.id, t);
  const merged = [...byId.values()];

  const songs = merged.filter((t) => t.ytKind === 'song');
  const videos = merged.filter(
    (t) => t.ytKind !== 'song' && (t.duration ?? 0) > 0 && (t.duration ?? 0) <= 15 * 60,
  );
  const ordered = reconcileRecordings([...songs, ...videos]) as SearchRow[];
  return { tracks: ordered.slice(0, limit), latencyMs: Date.now() - t0, unavailable: false, continuation };
}

/** Continuation walk — page 2+. RESOLVES (never rejects): a transport
 *  failure returns {error:true} so the caller keeps the token + hasMore. */
export async function ytSearchMusicMore(
  continuation: string,
  signal?: AbortSignal,
): Promise<YtMoreOutcome> {
  if (!continuation || signal?.aborted) return { tracks: [], error: true };
  if (!ytAvailable()) return { tracks: [], error: true };
  try {
    const data = await ytmFetch<unknown>(
      'search',
      { continuation },
      { cacheTtlMinutes: 10, retries: 1, noCache: true },
    ).catch(() => null);
    if (!data) {
      noteYtFailure();
      return { tracks: [], error: true };
    }
    noteYtSuccess();
    const { tracks } = collectRows(data);
    const next = continuationOf(data);
    const songs = tracks.filter((t) => t.ytKind === 'song');
    const videos = tracks.filter(
      (t) => t.ytKind !== 'song' && (t.duration ?? 0) > 0 && (t.duration ?? 0) <= 15 * 60,
    );
    const ordered = reconcileRecordings([...songs, ...videos]) as SearchRow[];
    return { tracks: ordered, continuation: next };
  } catch {
    noteYtFailure();
    return { tracks: [], error: true };
  }
}
