/**
 * TSF Music — public YT Music API
 * Every call: live InnerTube → on failure, seed fallback (offline mode).
 * Track metadata is persisted to the catalog cache.
 */

import { ytmFetch } from './innertube'
import { CLIENTS, SEARCH_FILTERS } from './clients'
import { parseSearch, parseTracklist, parseArtistPage, parseHomeFeed, parseRadio, parseLyrics, type YtmTrack, type YtmAlbum, type YtmArtist, type YtmShelf } from './parse'
import { seedSearch, seedHome, seedArtist, seedAlbumTracks } from './seed'
import { db } from '@/lib/db'
import { filterSafeTracks, isShelfTitleSafe } from '@/lib/safety'

export type { YtmTrack, YtmAlbum, YtmArtist, YtmShelf }

/** Persist tracks into the catalog cache (best-effort).
 *  NOTE: artistId/albumId are FK-constrained to Artist/Album tables. Only
 *  set them when we know those rows exist (or omit them entirely). For
 *  search/radio results we just persist the denormalized text fields.
 */
async function persistTracks(tracks: YtmTrack[]) {
  if (!tracks.length) return
  try {
    await Promise.all(
      tracks.slice(0, 40).map((t) =>
        db.track.upsert({
          where: { id: t.videoId },
          update: {
            title: t.title,
            artistName: t.artistName,
            albumName: t.albumName,
            duration: t.duration,
            thumbnail: t.thumbnail,
            year: t.year,
            isExplicit: !!t.explicit,
          },
          create: {
            id: t.videoId,
            title: t.title,
            artistName: t.artistName,
            albumName: t.albumName,
            duration: t.duration,
            thumbnail: t.thumbnail,
            year: t.year,
            isExplicit: !!t.explicit,
          },
        }).catch(() => {})
      )
    )
  } catch { /* non-fatal */ }
}

// ---------- search ----------

export async function search(query: string, filter?: keyof typeof SEARCH_FILTERS) {
  if (!query.trim()) return { tracks: [] as YtmTrack[], albums: [] as YtmAlbum[], artists: [] as YtmArtist[], offline: false }
  try {
    const body: Record<string, unknown> = { query }
    if (filter && SEARCH_FILTERS[filter]) body.params = SEARCH_FILTERS[filter]
    // DURATION FIX (dual merge): an InnerTube A/B variant of the UNFILTERED
    // search response omits row durations entirely (no fixedColumns, no
    // duration run — rows look like "Song • Artist" + "9.5B plays"). The
    // songs-filtered AND videos-filtered responses always carry them (video
    // rows put the mm:ss tail in the subtitle runs), so we fetch BOTH in
    // PARALLEL (no added latency, cached like any other call) and merge
    // durations by videoId.
    const [res, songsRes, videosRes] = await Promise.all([
      ytmFetch<any>('search', body),
      filter
        ? Promise.resolve(null)
        : ytmFetch<any>('search', { query, params: SEARCH_FILTERS.songs }).catch(() => null),
      filter
        ? Promise.resolve(null)
        : ytmFetch<any>('search', { query, params: SEARCH_FILTERS.videos }).catch(() => null),
    ])
    const parsed = parseSearch(res)
    const songsParsed = songsRes ? parseSearch(songsRes) : null
    const videosParsed = videosRes ? parseSearch(videosRes) : null
    if ((songsParsed || videosParsed) && parsed.tracks.some((t) => !t.duration)) {
      const durById = new Map<string, number>()
      const collect = (src: { tracks: YtmTrack[] } | null) => {
        if (!src) return
        for (const t of src.tracks) {
          if (t.duration > 0 && !durById.has(t.videoId)) durById.set(t.videoId, t.duration)
        }
      }
      collect(songsParsed)
      collect(videosParsed)
      for (const t of parsed.tracks) {
        if (!t.duration && durById.has(t.videoId)) t.duration = durById.get(t.videoId) as number
      }
    }
    // SONGS-FIRST ORDERING (Spotify-style): the songs-filtered response is
    // the canonical songs list — every row there carries a duration (the
    // type-grouped unfiltered variant serves Song rows bare: "Song • Artist
    // • 9.5B plays", no mm:ss anywhere). Merge order: songs response first,
    // then unfiltered-response rows not already present (music videos,
    // top-result cards), then videos-response stragglers. Video rows still
    // without a duration are playable and self-correct on play (the audio
    // element's duration is authoritative once bytes flow).
    if (songsParsed && !filter) {
      const byId = new Map<string, YtmTrack>()
      for (const t of songsParsed.tracks) if (!byId.has(t.videoId)) byId.set(t.videoId, t)
      for (const t of parsed.tracks) if (!byId.has(t.videoId)) byId.set(t.videoId, t)
      // Videos-response stragglers: only rows WITH a duration — InnerTube's
      // videos response occasionally serves a malformed first row (title of
      // one video mapped to a DIFFERENT video's id, no duration run), which
      // would resurface as a 0:00 duplicate deep in the list.
      if (videosParsed)
        for (const t of videosParsed.tracks)
          if (t.duration > 0 && !byId.has(t.videoId)) byId.set(t.videoId, t)
      if (byId.size) parsed.tracks = [...byId.values()]
      // albums/artists still come from the unfiltered parse (richer)
      if (!parsed.albums.length && songsParsed.albums.length) parsed.albums = songsParsed.albums
      if (!parsed.artists.length && songsParsed.artists.length) parsed.artists = songsParsed.artists
      // Cosmetic polish: the rare rows still lacking a duration (deep video
      // variants absent from every filtered response) sink to the bottom —
      // stable sort keeps the songs order intact and the visible list clean.
      parsed.tracks = parsed.tracks
        .map((t, i) => ({ t, i }))
        .sort((a, b) => (a.t.duration ? 0 : 1) - (b.t.duration ? 0 : 1) || a.i - b.i)
        .map((x) => x.t)
    }
    // SAFETY: drop inappropriate content
    const safeTracks = filterSafeTracks(parsed.tracks)
    const safeAlbums = (parsed.albums || []).filter((a) => isShelfTitleSafe(a.name + ' ' + (a.artistName || '')))
    const safeArtists = (parsed.artists || []).filter((a) => isShelfTitleSafe(a.name))
    await persistTracks(safeTracks)
    return { tracks: safeTracks, albums: safeAlbums, artists: safeArtists, offline: false }
  } catch {
    const s = seedSearch(query)
    const safeTracks = filterSafeTracks(s.tracks)
    return { tracks: safeTracks, albums: s.albums, artists: s.artists, offline: true }
  }
}

// ---------- home ----------

/** Curated shelves built from search (region-proof, English). */
const CURATED: { query: string; title: string; subtitle?: string }[] = [
  { query: 'top hits', title: 'Trending hits' },
  { query: 'pop hits', title: 'Pop rising' },
  { query: 'hip hop hits', title: 'Hip-hop heavyweights' },
  { query: 'rock classics', title: 'Rock classics' },
  { query: 'chill vibes playlist', title: 'Chill vibes' },
  { query: 'electronic dance hits', title: 'Electronic energy' },
  { query: 'r&b hits', title: 'R&B favorites' },
  { query: 'acoustic covers', title: 'Acoustic corner' },
]

export async function home() {
  try {
    const res = await ytmFetch<any>('browse', { browseId: 'FEmusic_home' })
    const innerShelves = parseHomeFeed(res)
      .filter((s) => isShelfTitleSafe(s.title))
      .map((s) => ({
        ...s,
        tracks: s.tracks ? filterSafeTracks(s.tracks) : undefined,
        albums: s.albums ? s.albums.filter((a) => isShelfTitleSafe(a.name + ' ' + (a.artistName || ''))) : undefined,
        artists: s.artists ? s.artists.filter((a) => isShelfTitleSafe(a.name)) : undefined,
      }))
      .filter((s) => (s.tracks?.length || 0) + (s.albums?.length || 0) + (s.artists?.length || 0) > 0)

    // curated search shelves (cached in DB 24h — cheap after first hit)
    const curated: YtmShelf[] = []
    const wanted = CURATED.slice(0, 5)
    await Promise.all(
      wanted.map(async ({ query, title }) => {
        try {
          const r = await ytmFetch<any>('search', { query, params: SEARCH_FILTERS.songs }, { cacheTtlMinutes: 60 * 24 })
          const parsed = parseSearch(r)
          const safeTracks = filterSafeTracks(parsed.tracks)
          if (safeTracks.length) curated.push({ title, tracks: safeTracks })
        } catch { /* skip */ }
      })
    )

    const shelves = [...innerShelves, ...curated]
    return { shelves, offline: false }
  } catch {
    return { shelves: seedHome().filter((s) => isShelfTitleSafe(s.title)), offline: true }
  }
}

// ---------- album / playlist ----------

export async function album(browseId: string) {
  try {
    const res = await ytmFetch<any>('browse', { browseId })
    const parsed = parseTracklist(res)
    const safeTracks = filterSafeTracks(parsed.tracks)
    if (!safeTracks.length) throw new Error('empty')
    await persistTracks(safeTracks)
    return { ...parsed, tracks: safeTracks, offline: false }
  } catch {
    return { ...seedAlbumTracks(browseId), offline: true }
  }
}

// ---------- artist ----------

export async function artist(browseId: string) {
  try {
    const res = await ytmFetch<any>('browse', { browseId })
    const parsed = parseArtistPage(res)
    if (!parsed.name) throw new Error('empty')
    parsed.topTracks = filterSafeTracks(parsed.topTracks)
    parsed.shelves = parsed.shelves
      .filter((s) => isShelfTitleSafe(s.title))
      .map((s) => ({
        ...s,
        tracks: s.tracks ? filterSafeTracks(s.tracks) : undefined,
        albums: s.albums ? s.albums.filter((a) => isShelfTitleSafe(a.name + ' ' + (a.artistName || ''))) : undefined,
        artists: s.artists ? s.artists.filter((a) => isShelfTitleSafe(a.name)) : undefined,
      }))
      .filter((s) => (s.tracks?.length || 0) + (s.albums?.length || 0) + (s.artists?.length || 0) > 0)
    await persistTracks(parsed.topTracks)
    return { ...parsed, offline: false }
  } catch {
    return { ...seedArtist(browseId), offline: true }
  }
}

// ---------- radio / up next ----------

export async function radio(videoId: string, playlistId?: string) {
  try {
    const body: Record<string, unknown> = {
      videoId,
      playlistId: playlistId ?? 'RDAMVM' + videoId,
      params: 'wAEB',
      isAudioOnly: true,
    }
    const res = await ytmFetch<any>('next', body)
    const tracks = parseRadio(res)
    const safeTracks = filterSafeTracks(tracks)
    if (!safeTracks.length) throw new Error('empty')
    await persistTracks(safeTracks)
    return { tracks: safeTracks, offline: false }
  } catch {
    // seed radio: the seed tracks after this one
    const SEED_IDS = ['LKYPYj2XX80', '5NV6Rdv1a3I', 'yuFI5KSPAt4', 'k2qgadSvNyU', '4NRXx6U8ABQ', 'JGwWNGJdvx8', 'hLQl3WQQoQ0', 'fJ9rUzIMcZQ', '7wtfhZwyrcc', 'TUVcZfQe-Kw']
    const { SEED } = await import('./seed')
    const idx = SEED_IDS.indexOf(videoId)
    const tracks = idx >= 0 ? [...SEED.tracks.slice(idx), ...SEED.tracks.slice(0, idx)] : SEED.tracks
    return { tracks: filterSafeTracks(tracks).slice(0, 12), offline: true }
  }
}

// ---------- lyrics ----------

export async function lyrics(videoId: string, title?: string, artist?: string, album?: string, duration?: number) {
  // Primary: LRCLIB (open synced lyrics DB)
  if (title && artist) {
    try {
      const lrc = await fetchLrclib(title, artist, album, duration)
      if (lrc) return lrc
    } catch { /* fall through */ }
  }

  // Fallback: InnerTube lyrics tab (plain text)
  try {
    const next = await ytmFetch<any>('next', { videoId, isAudioOnly: true })
    const browseId = findLyricsBrowseId(next)
    if (!browseId) throw new Error('no lyrics tab')
    const res = await ytmFetch<any>('browse', { browseId }, { cacheTtlMinutes: 60 * 24 })
    const parsed = parseLyrics(res)
    if (parsed.lines.length) return { ...parsed, offline: false }
    throw new Error('empty')
  } catch {
    return { synced: false, lines: [], offline: true }
  }
}

async function fetchLrclib(title: string, artist: string, album?: string, duration?: number) {
  const params = new URLSearchParams({ track_name: title, artist_name: artist })
  if (album) params.set('album_name', album)

  // exact match first
  const getUrl = `https://lrclib.net/api/get?${params.toString()}${duration ? `&duration=${duration}` : ''}`
  const exact = await fetch(getUrl, {
    headers: { 'User-Agent': 'TSF-Music/1.0 (https://github.com/tsf-music)' },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null)
  if (exact?.ok) {
    const j: any = await exact.json()
    const parsed = parseLrc(j.syncedLyrics || '', j.plainLyrics || '')
    if (parsed.lines.length) return { ...parsed, offline: false }
  }

  // search fallback
  const sres = await fetch(
    `https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`,
    { headers: { 'User-Agent': 'TSF-Music/1.0' }, signal: AbortSignal.timeout(8000) }
  ).catch(() => null)
  if (sres?.ok) {
    const results: any[] = await sres.json()
    const best =
      results.find((r) => r.syncedLyrics && (duration ? Math.abs((r.duration || 0) - duration) < 8 : true)) ||
      results.find((r) => r.syncedLyrics) ||
      results[0]
    if (best) {
      const parsed = parseLrc(best.syncedLyrics || '', best.plainLyrics || '')
      if (parsed.lines.length) return { ...parsed, offline: false }
    }
  }
  return null
}

function parseLrc(synced: string, plain: string): { synced: boolean; lines: { time: number; text: string }[] } {
  if (synced) {
    const lines = synced
      .split('\n')
      .map((line) => {
        const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/)
        if (!m) return null
        return { time: Number(m[1]) * 60 + Number(m[2]), text: m[3] }
      })
      .filter((l): l is { time: number; text: string } => l !== null && l.text !== '')
    if (lines.length) return { synced: true, lines }
  }
  if (plain) {
    const lines = plain.split('\n').map((text, i) => ({ time: 0, text: text.trim() }))
    return { synced: false, lines: lines.filter((l) => l.text) }
  }
  return { synced: false, lines: [] }
}

function findLyricsBrowseId(next: any): string | null {
  // lyrics tab lives in tabs[] where pageTitle == "Lyrics"
  const tabs = next?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || []
  for (const tab of tabs) {
    const tr = tab.tabRenderer
    if (tr && tr.title === 'Lyrics' && tr.endpoint?.browseEndpoint?.browseId) {
      return tr.endpoint.browseEndpoint.browseId
    }
  }
  return null
}

// ---------- watch playlist continuation (for infinite radio) ----------

export async function radioContinuation(continuationToken: string) {
  const res = await ytmFetch<any>('next', { continuation: continuationToken })
  return { tracks: parseRadio(res) }
}
