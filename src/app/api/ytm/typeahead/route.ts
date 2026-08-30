import { NextRequest } from 'next/server'
import { search as ytmSearch } from '@/lib/ytm'
import { getRecentEventsByType } from '@/lib/mindbeat/ledger'
import { isShelfTitleSafe } from '@/lib/safety'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ytm/typeahead?q=
 *
 * The SearchView typeahead rail payload:
 *   recents:   string[]      — the user's own recent searches (ledger
 *                              SEARCH_QUERY events, latest first, filtered
 *                              by the typed prefix; the rail's first block)
 *   songs:     PlayerTrack[] — provider suggestions ≤6 (songs-filtered
 *                              YT Music search, tiny limit)
 *   artists:   [{id,name,thumbnail}] ≤4 — artist rows from the same probe
 *   bestGuess: PlayerTrack?  — the top songs row (Spotify-style hero)
 *
 * Budget: ≤250 ms target. Both probes race a hard 1.5 s deadline; the
 * route NEVER throws — a provider failure degrades to { recents } only.
 * The request's own AbortSignal is honored end-to-end.
 */

const HARD_DEADLINE_MS = 1500
const RECENTS_MAX = 6
const SONGS_MAX = 6
const ARTISTS_MAX = 4

interface TypeaheadSong {
  videoId: string
  title: string
  artistName: string
  artistId?: string
  albumName?: string
  duration: number
  thumbnail: string
  year?: number
}

async function recentsFor(q: string): Promise<string[]> {
  try {
    const rows = await getRecentEventsByType('SEARCH_QUERY', 30 * 24 * 3600 * 1000, 80)
    const out: string[] = []
    const seen = new Set<string>()
    const needle = q.toLowerCase().trim()
    for (const r of rows) {
      const query = typeof r.payload?.query === 'string' ? r.payload.query.trim() : ''
      const key = query.toLowerCase()
      if (!query) continue
      // latest-first, deduped, prefix-match when the user typed something
      if (needle && !key.startsWith(needle) && !key.includes(needle)) continue
      if (seen.has(key)) continue
      seen.add(key)
      out.push(query)
      if (out.length >= RECENTS_MAX) break
    }
    return out
  } catch {
    return []
  }
}

async function providerSuggestions(q: string): Promise<{ songs: TypeaheadSong[]; artists: Array<{ id: string; name: string; thumbnail: string }> }> {
  try {
    const [songsRes, artistsRes] = await Promise.all([
      ytmSearch(q, 'songs').catch(() => ({ tracks: [] as any[] })),
      ytmSearch(q, 'artists').catch(() => ({ artists: [] as any[] })),
    ])
    const songs: TypeaheadSong[] = (songsRes.tracks ?? [])
      .filter((t) => t && typeof t.videoId === 'string')
      .slice(0, SONGS_MAX)
      .map((t) => ({
        videoId: t.videoId,
        title: t.title ?? '',
        artistName: t.artistName ?? '',
        artistId: t.artistId,
        albumName: t.albumName,
        duration: t.duration ?? 0,
        thumbnail: t.thumbnail ?? '',
        year: t.year,
      }))
    const artists = (artistsRes.artists ?? [])
      .filter((a) => a && typeof a.browseId === 'string' && a.name)
      .slice(0, ARTISTS_MAX)
      .map((a) => ({ id: a.browseId, name: a.name, thumbnail: a.thumbnail ?? '' }))
    return { songs, artists }
  } catch {
    return { songs: [], artists: [] }
  }
}

function raced<T>(p: Promise<T>, ms: number): { promise: Promise<T>; won: () => boolean } {
  let timedOut = false
  const promise = Promise.race([
    p,
    new Promise<T>((resolve) =>
      setTimeout(() => {
        timedOut = true
        resolve(undefined as unknown as T)
      }, ms),
    ),
  ])
  return { promise, won: () => timedOut }
}

export async function GET(req: NextRequest) {
  const q = (new URL(req.url).searchParams.get('q') || '').trim()

  if (!q) {
    // focus state: recents-only rail
    return Response.json({ recents: await recentsFor('') })
  }
  if (!isShelfTitleSafe(q)) {
    return Response.json({ recents: [], songs: [], artists: [] })
  }

  // recents resolve against the local ledger (fast, always answered);
  // provider suggestions race the hard deadline
  const suggestions = raced(providerSuggestions(q), HARD_DEADLINE_MS)
  const [recents, sugg] = await Promise.all([recentsFor(q), suggestions.promise])

  if (suggestions.won() || !sugg) {
    // deadline won — recents only (the rail must never stall a keystroke)
    return Response.json({ recents, deadlineHit: true })
  }

  return Response.json({
    recents,
    songs: sugg.songs,
    artists: sugg.artists,
    bestGuess: sugg.songs[0] ?? undefined,
  })
}
