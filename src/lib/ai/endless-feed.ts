/**
 * TSF Music — Endless home feed (F2), ported from the reference repo's
 * v3.4.1 src/api/feed.ts (their gauntlet-hardened pager), adapted to the
 * web edition's catalogs:
 *
 *   • the reference paginates JioSaavn search.getResults by page NUMBER;
 *     our primary catalog is YT Music (InnerTube), so each ladder query
 *     walks its OWN continuation chain (the fetcher closure remembers the
 *     token per query — page numbers keep the reference's cursor semantics).
 *   • songs come back as playable PlayerTrack projections (videoId kept);
 *     albums as tappable Collection cards (browseId → album view).
 *   • every batch is deduped against everything emitted before it AND the
 *     caller-supplied ids already on screen (prime()).
 *   • output contract is IDENTICAL to the reference (the UI depends on it):
 *       { kind:'songs'|'albums', title, rows }  → append and render
 *       { kind:'retry' }                        → transient failure
 *       null                                    → exhausted FOREVER
 *
 * The pager is PURE + injectable — the route owns sessions (globalThis
 * map), the fetchers do I/O, so the rotation/dedupe/exhaustion logic is
 * deterministic and unit-testable.
 */

import { searchPage } from '@/lib/ytm'

export interface FeedSong {
  videoId: string
  title: string
  artistName: string
  duration: number
  thumbnail: string
}

export interface FeedAlbum {
  id: string
  name: string
  artist?: string
  thumbnail: string
  year?: number
}

export interface FeedFetchers {
  searchSongs: (q: string, page: number) => Promise<FeedSong[]>
  searchAlbums: (q: string, page: number) => Promise<FeedAlbum[]>
}

export type FeedBatch =
  | { kind: 'songs'; title: string; rows: FeedSong[] }
  | { kind: 'albums'; title: string; rows: FeedAlbum[] }
  | { kind: 'retry' }

/** Rotating query ladders — broad, popular, safety-filterable by design. */
const SONG_QUERIES = [
  'top songs',
  'arijit singh',
  'punjabi hits',
  'romantic songs',
  'bollywood 2024',
  'party songs',
  'atif aslam',
  'sad songs',
  'dance hits',
  'kishore kumar',
  'lofi songs',
  'workout music',
  'shreya ghoshal',
  'sufi songs',
  'english hits',
  'a r rahman',
]

const ALBUM_QUERIES = [
  'hits',
  'romantic',
  'love',
  'party',
  'sad',
  'punjabi',
  'devotional',
  'dance',
  'acoustic',
  'workout',
  'classic',
  'instrumental',
]

/** How many times each ladder may be walked before honest exhaustion. */
const MAX_LADDER_PASSES = 3
const SONGS_PER_BATCH = 14
const ALBUMS_PER_BATCH = 12
/** Minimum fresh rows for a batch to be worth rendering. */
const MIN_SONG_BATCH = 6
const MIN_ALBUM_BATCH = 4

function titleCase(q: string): string {
  return q.replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Per-ladder cursor: which query, how deep into its pages. */
interface LadderCursor {
  queryIdx: number
  page: number
  /** total times the cursor moved to a NEW query (exhaustion budget) */
  queriesUsed: number
}

export class EndlessFeedPager {
  private songCursor: LadderCursor = { queryIdx: 0, page: 1, queriesUsed: 0 }
  private albumCursor: LadderCursor = { queryIdx: 0, page: 1, queriesUsed: 0 }
  private songLadder: string[]
  private albumLadder: string[]
  private seenSongIds = new Set<string>()
  private seenAlbumIds = new Set<string>()
  private lastWasSongs = false
  private failures = 0
  private exhausted = false

  constructor(
    private fetchers: FeedFetchers,
    opts?: { songQueries?: string[]; albumQueries?: string[] },
  ) {
    this.songLadder = opts?.songQueries ?? SONG_QUERIES
    this.albumLadder = opts?.albumQueries ?? ALBUM_QUERIES
  }

  get isExhausted(): boolean {
    return this.exhausted
  }

  private songLadderDone(): boolean {
    return this.songCursor.queriesUsed >= this.songLadder.length * MAX_LADDER_PASSES
  }

  private albumLadderDone(): boolean {
    return this.albumCursor.queriesUsed >= this.albumLadder.length * MAX_LADDER_PASSES
  }

  /**
   * Pull fresh rows from one ladder. A productive (query, page) advances
   * deeper into the SAME query; a dry one moves the cursor to the next
   * query. Up to `maxAttempts` cursor positions are tried per call.
   *
   * Reference P2-2 parity: a fetch that THROWS is an error, not a dry
   * page — errors never advance the cursor or consume the exhaustion
   * budget (a flaky network must not permanently end the feed).
   */
  private async pullLadder<T>(
    kind: 'songs' | 'albums',
    maxAttempts: number,
    minRows: number,
  ): Promise<{ rows: T[]; title: string } | 'error' | null> {
    const ladder = kind === 'songs' ? this.songLadder : this.albumLadder
    const cursor = kind === 'songs' ? this.songCursor : this.albumCursor
    const seen = kind === 'songs' ? this.seenSongIds : this.seenAlbumIds
    const isDone = kind === 'songs' ? this.songLadderDone : this.albumLadderDone
    const fetchPage =
      kind === 'songs'
        ? (q: string, p: number) => this.fetchers.searchSongs(q, p)
        : (q: string, p: number) => this.fetchers.searchAlbums(q, p)

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (isDone.call(this)) return null
      const q = ladder[cursor.queryIdx % ladder.length]
      let rows: T[]
      try {
        rows = (await fetchPage(q, cursor.page)) as T[]
      } catch {
        return 'error' // network failure — NOT a dry page, no budget burn
      }
      const fresh = (rows as Array<{ id?: string; videoId?: string }>).filter((r) => {
        const id = r.videoId ?? r.id ?? ''
        return id && !seen.has(id)
      })
      for (const r of fresh) {
        const id = (r as { videoId?: string; id?: string }).videoId ?? (r as { id?: string }).id ?? ''
        if (id) seen.add(id)
      }
      if (fresh.length >= minRows) {
        cursor.page += 1 // next call goes deeper into this query
        return { rows: fresh as T[], title: titleCase(q) }
      }
      // dry: move to the next query, restart at page 1
      cursor.queryIdx += 1
      cursor.page = 1
      cursor.queriesUsed += 1
    }
    return null
  }

  /**
   * Emit the next batch — alternates kinds, falls through to the other
   * kind when the preferred one comes up dry, and only ever returns null
   * when BOTH ladders are fully walked (honest exhaustion).
   */
  async next(): Promise<FeedBatch | null> {
    if (this.exhausted) return null

    if (this.songLadderDone() && this.albumLadderDone()) {
      this.exhausted = true
      return null
    }

    // transient network death — offer an honest retry, keep the pager alive
    if (this.failures >= 2) {
      this.failures = 0
      return { kind: 'retry' }
    }

    const firstSongs = !this.lastWasSongs
    let songs: FeedBatch | null = null
    let albums: FeedBatch | null = null
    let errored = false

    const pull = async (kind: 'songs' | 'albums'): Promise<FeedBatch | null> => {
      if (kind === 'songs') {
        const pulled = await this.pullLadder<FeedSong>('songs', 2, MIN_SONG_BATCH)
        if (pulled === 'error' || !pulled) {
          if (pulled === 'error') errored = true
          return null
        }
        return { kind: 'songs', title: pulled.title, rows: pulled.rows.slice(0, SONGS_PER_BATCH) }
      }
      const pulled = await this.pullLadder<FeedAlbum>('albums', 2, MIN_ALBUM_BATCH)
      if (pulled === 'error' || !pulled) {
        if (pulled === 'error') errored = true
        return null
      }
      return { kind: 'albums', title: 'More albums to explore', rows: pulled.rows.slice(0, ALBUMS_PER_BATCH) }
    }

    if (firstSongs) {
      songs = await pull('songs')
      if (!songs) albums = await pull('albums')
    } else {
      albums = await pull('albums')
      if (!albums) songs = await pull('songs')
    }

    const batch = songs ?? albums
    if (batch) {
      this.lastWasSongs = batch.kind === 'songs'
      this.failures = 0
      return batch
    }

    this.failures += 1
    if (this.failures >= 2) {
      this.failures = 0
      return { kind: 'retry' }
    }
    if (!errored && this.songLadderDone() && this.albumLadderDone()) {
      this.exhausted = true
      return null
    }
    // one empty round is not death: let the UI try again on next scroll
    return { kind: 'retry' }
  }

  /** Register ids already on screen (fixed shelves) so the feed never repeats them. */
  prime(seen: { songs?: Array<{ videoId?: string }>; albums?: Array<{ id?: string }> }): void {
    for (const t of seen.songs ?? []) if (t.videoId) this.seenSongIds.add(t.videoId)
    for (const c of seen.albums ?? []) if (c.id) this.seenAlbumIds.add(c.id)
  }
}

// ---------- InnerTube fetchers (per-query continuation memory) ----------

/**
 * Walk a query's continuation chain by page number: page 1 = the filtered
 * search, page N = its (N-1)th continuation. Tokens live in the closure —
 * the pager's cursor semantics stay identical to the reference's
 * page-numbered JioSaavn fetchers.
 */
function makeYtmSongFetcher(): (q: string, page: number) => Promise<FeedSong[]> {
  const tokens = new Map<string, string | undefined>()
  return async (q: string, page: number) => {
    const key = q.toLowerCase()
    const cont = tokens.get(key)
    if (page > 1 && !cont) return [] // walked out — dry
    const res = await searchPage(q, page > 1 ? cont : undefined)
    tokens.set(key, res.continuation)
    return res.tracks.map((t) => ({
      videoId: t.videoId,
      title: t.title,
      artistName: t.artistName || 'Unknown artist',
      duration: t.duration ?? 0,
      thumbnail: t.thumbnail ?? '',
    }))
  }
}

function makeYtmAlbumFetcher(): (q: string, page: number) => Promise<FeedAlbum[]> {
  const tokens = new Map<string, string | undefined>()
  return async (q: string, page: number) => {
    const key = q.toLowerCase()
    const cont = tokens.get(key)
    if (page > 1 && !cont) return []
    // ALBUMS filter — the songs-filtered response carries no album cards.
    const res = await searchPage(q, page > 1 ? cont : undefined, 'albums')
    tokens.set(key, res.continuation)
    return res.albums
      .filter((a) => a.browseId && a.thumbnail)
      .map((a) => ({
        id: a.browseId,
        name: a.name,
        artist: a.artistName,
        thumbnail: a.thumbnail,
        year: a.year,
      }))
  }
}

/** Fresh pager with our fetchers (route-owned sessions call this). */
export function createEndlessPager(opts?: { songQueries?: string[]; albumQueries?: string[] }): EndlessFeedPager {
  return new EndlessFeedPager(
    { searchSongs: makeYtmSongFetcher(), searchAlbums: makeYtmAlbumFetcher() },
    opts,
  )
}
