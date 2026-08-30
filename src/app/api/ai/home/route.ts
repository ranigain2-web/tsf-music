import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { readProfile, type SelectedArtist } from '../../onboarding/route'
import { artist as ytmArtist, radio as ytmRadio, search as ytmSearch } from '@/lib/ytm'
import type { YtmTrack, YtmAlbum, YtmArtist, YtmShelf } from '@/lib/ytm'
import { filterSafeTracks, isShelfTitleSafe } from '@/lib/safety'
import { cachedJson } from '@/lib/ai/cache'
import { buildNowSound } from '@/lib/mindbeat/daylist'
import { buildOnTheRise } from '@/lib/mindbeat/on-the-rise'
import { getShelfBanditState, reorderShelves, banditMeta } from '@/lib/mindbeat/shelf-bandit'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * GET /api/ai/home
 *
 * Fully personalized home feed. NO generic trending YouTube Music content.
 * Every shelf is derived from the user's onboarding selections:
 *
 *   1. "Your top artists"            — cards for each onboarding-selected artist
 *   2. "Made for [Name]"            — Daily Mix 1..N (one per favorite artist)
 *   3. "[Artist] · Top tracks"      — for the first 2 favorite artists
 *   4. "More like [Artist]"         — similar artists via radio/related shelves
 *   5. "[Artist] · Albums"          — discography for the second favorite
 *   6. "Because you like [Genre]"  — genre search shelf per selected genre
 *
 * Result cached in ApiCache (key `ai:home:v2`) for 4h — bandit reordering
 * runs per-request AFTER cache retrieval and is never baked into the cache.
 */

// v2: shelf payloads now carry stable ids (task 15-c shelf bandit) — the old
// v1 rows keep the id-less shape, so the version bumps and v1 expires naturally.
const CACHE_KEY = 'ai:home:v2'
const CACHE_TTL_MS = 4 * 60 * 60 * 1000

interface AiHome {
  shelves: (YtmShelf & { id?: string })[]
  mixes: { id: string; title: string; subtitle: string; cover?: string; tracks: any[] }[]
  topArtists: SelectedArtist[]
  greeting: string
  name?: string
  needsOnboarding?: boolean
  /** Shelf-bandit transparency (task 15-c): live = a champion earned the top slot. */
  bandit?: { mode: 'live' | 'cold'; champion?: string; dayBucket: number }
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Late night'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  if (h < 22) return 'Good evening'
  return 'Good night'
}

/**
 * MINDBEAT plan surfaces (§9.4 Daylist / §9.6 On the Rise) attach to the
 * home feed WITHOUT reordering the existing shelves: "Now Sound" lands as
 * the first music shelf after "Your top artists" (Spotify puts the Daylist
 * near the top), "On the Rise" right after it. Both builders are read-only
 * engine/pool work with their own in-memory caches, run in parallel, and a
 * failure simply omits the shelf — home never breaks because of them.
 *
 * Shelf ids for the shelf-bandit/telemetry: 'now-sound' · 'on-the-rise'.
 */
function insertShelfAt(shelves: (YtmShelf & { id?: string })[], shelf: YtmShelf & { id?: string }, index: number): (YtmShelf & { id?: string })[] {
  const out = [...shelves]
  out.splice(Math.max(0, Math.min(index, out.length)), 0, shelf)
  return out
}

async function attachPlanShelves(home: AiHome): Promise<AiHome> {
  // Jump back in (reference repo's deep-Home feed): the user's own recent
  // listens as the second shelf — evidence of "it remembers" with zero
  // intelligence cost. Read-only over the history table; omitted on error.
  const jumpBackIn = (async () => {
    try {
      const items = await db.historyItem.findMany({
        orderBy: { playedAt: 'desc' },
        take: 30,
        include: { track: true },
      })
      const seen = new Set<string>()
      const tracks = items
        .filter((i) => (seen.has(i.trackId) ? false : (seen.add(i.trackId), true)))
        .map((i) => trackToPlayer(i.track))
        .filter((t): t is NonNullable<ReturnType<typeof trackToPlayer>> => !!t?.videoId)
      return tracks.length >= 4 ? tracks.slice(0, 10) : null
    } catch {
      return null
    }
  })()

  const [nsRes, otrRes, jbiRes] = await Promise.allSettled([
    buildNowSound(),
    buildOnTheRise(),
    jumpBackIn,
  ])
  let inserted = 0
  if (nsRes.status === 'fulfilled' && nsRes.value.tracks.length) {
    const ns = nsRes.value
    home.shelves = insertShelfAt(
      home.shelves,
      { id: 'now-sound', title: ns.title, subtitle: ns.subtitle, tracks: ns.tracks },
      1 // first music shelf after "Your top artists"
    )
    inserted++
  }
  if (jbiRes.status === 'fulfilled' && jbiRes.value) {
    home.shelves = insertShelfAt(
      home.shelves,
      { id: 'jump-back-in', title: 'Jump back in', subtitle: 'Your recent listens', tracks: jbiRes.value },
      1 + inserted // right after Now Sound
    )
    inserted++
  }
  if (otrRes.status === 'fulfilled' && otrRes.value.tracks.length) {
    const otr = otrRes.value
    home.shelves = insertShelfAt(
      home.shelves,
      { id: 'on-the-rise', title: otr.name, subtitle: `Anchored by ${otr.seed.artistName}`, tracks: otr.tracks },
      1 + inserted // right after the shelves above
    )
  }
  return home
}

function trackToPlayer(t: any) {
  if (!t) return null
  return {
    videoId: t.videoId || t.id,
    title: t.title,
    artistName: t.artistName || t.artist,
    artistId: t.artistId,
    albumName: t.albumName,
    albumId: t.albumId,
    duration: t.duration || 0,
    thumbnail: t.thumbnail || '',
  }
}

async function buildMixes(artists: SelectedArtist[]) {
  const mixes: { id: string; title: string; subtitle: string; cover?: string; tracks: any[] }[] = []
  const MAX = 6
  for (let i = 0; i < Math.min(artists.length, MAX); i++) {
    const a = artists[i]
    try {
      const page = await ytmArtist(a.id)
      const topTrack = (page.topTracks || [])[0]
      if (!topTrack) continue
      const radioRes = await ytmRadio(topTrack.videoId)
      const tracks = (radioRes.tracks || []).slice(0, 25).map(trackToPlayer).filter(Boolean)
      if (!tracks.length) continue
      mixes.push({
        id: `dm-${i + 1}`,
        title: `Daily Mix ${i + 1}`,
        subtitle: a.name,
        cover: a.thumbnail || topTrack.thumbnail,
        tracks,
      })
    } catch { /* skip */ }
  }
  return mixes
}

/**
 * Stable shelf ids (shelf-bandit/telemetry contract, task 15-c):
 *   'top-artists' · 'now-sound' · 'on-the-rise' · 'artist-top-{artistId}'
 *   'more-like-{artistId}' · 'albums-{artistId}' · 'genre-{slug}'
 * The bandit reorders ONLY shelves carrying these ids; anything else keeps
 * its curated position.
 */
function genreSlug(genre: string): string {
  return genre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'genre'
}

async function buildTopTracksShelf(artist: SelectedArtist): Promise<(YtmShelf & { id?: string }) | null> {
  try {
    const page = await ytmArtist(artist.id)
    const tracks = filterSafeTracks((page.topTracks || []).slice(0, 8))
    if (!tracks.length) return null
    return {
      id: `artist-top-${artist.id}`,
      title: `${artist.name} · Top tracks`,
      subtitle: "Songs you'll recognise",
      tracks,
    }
  } catch {
    return null
  }
}

async function buildMoreLikeShelf(artist: SelectedArtist): Promise<(YtmShelf & { id?: string }) | null> {
  try {
    const page = await ytmArtist(artist.id)
    const related = (page.shelves || []).find(
      (s) =>
        /related|similar|fans might also like|discover more/i.test(s.title) &&
        s.artists &&
        s.artists.length > 0
    )
    if (!related || !related.artists?.length) return null
    const safeArtists = related.artists.filter((a) => isShelfTitleSafe(a.name)).slice(0, 10)
    if (!safeArtists.length) return null
    return {
      id: `more-like-${artist.id}`,
      title: `More like ${artist.name}`,
      subtitle: "Artists you'll probably love",
      artists: safeArtists,
    }
  } catch {
    return null
  }
}

async function buildDiscographyShelf(artist: SelectedArtist): Promise<(YtmShelf & { id?: string }) | null> {
  try {
    const page = await ytmArtist(artist.id)
    const discog = (page.shelves || []).find((s) => /albums|discography|releases/i.test(s.title) && s.albums?.length)
    if (!discog || !discog.albums?.length) return null
    const safeAlbums = discog.albums
      .filter((a) => isShelfTitleSafe(a.name + ' ' + (a.artistName || '')))
      .slice(0, 10)
    if (!safeAlbums.length) return null
    return {
      id: `albums-${artist.id}`,
      title: `${artist.name} · Albums`,
      subtitle: 'Full discography at a glance',
      albums: safeAlbums,
    }
  } catch {
    return null
  }
}

async function buildGenreShelf(genre: string, subtitle: string): Promise<(YtmShelf & { id?: string }) | null> {
  try {
    const r = await ytmSearch(`${genre} hits`, 'songs')
    const tracks = filterSafeTracks((r.tracks || []).slice(0, 12))
    if (!tracks.length) return null
    return { id: `genre-${genreSlug(genre)}`, title: subtitle, tracks }
  } catch {
    return null
  }
}

async function buildAiHome(profile: Awaited<ReturnType<typeof readProfile>>): Promise<AiHome> {
  const shelves: (YtmShelf & { id?: string })[] = []

  // 1. "Your top artists" shelf — artist cards from prefs (identity shelf:
  //    pinned at position 0 by the shelf bandit, never demoted)
  const topArtists: YtmShelf & { id?: string } = {
    id: 'top-artists',
    title: 'Your top artists',
    subtitle: profile.genres.length ? `From your ${profile.genres.slice(0, 3).join(', ')} picks` : 'Tap to dive in',
    artists: profile.artists.map((a) => ({
      browseId: a.id,
      name: a.name,
      thumbnail: a.thumbnail || '',
      description: '',
      subscribers: '',
    })),
  }
  shelves.push(topArtists)

  // 2. Daily Mixes (built into mixes[], surfaced as a separate row in UI)
  const mixes = await buildMixes(profile.artists)

  // 3. Top tracks shelf for first 2 favorite artists (parallel)
  const topTracksShelves = await Promise.all(
    profile.artists.slice(0, 2).map((a) => buildTopTracksShelf(a))
  )
  for (const s of topTracksShelves) if (s) shelves.push(s)

  // 4. "More like [artist]" — only for the first favorite artist
  if (profile.artists[0]) {
    const ml = await buildMoreLikeShelf(profile.artists[0])
    if (ml) shelves.push(ml)
  }

  // 5. Discography for the second favorite artist
  if (profile.artists[1]) {
    const d = await buildDiscographyShelf(profile.artists[1])
    if (d) shelves.push(d)
  }

  // 6. "Because you like [genre]" shelves — one per selected genre
  const genreShelves = await Promise.all(
    profile.genres.slice(0, 3).map((g) => buildGenreShelf(g, `Because you like ${g}`))
  )
  for (const s of genreShelves) if (s) shelves.push(s)

  return {
    shelves,
    mixes,
    topArtists: profile.artists,
    greeting: greeting(),
    name: profile.name,
  }
}

export async function GET() {
  const profile = await readProfile()
  if (!profile.complete || profile.artists.length === 0) {
    return NextResponse.json({
      shelves: [],
      mixes: [],
      topArtists: [],
      greeting: greeting(),
      name: profile.name,
      needsOnboarding: true,
    })
  }

  // Cache key includes the user's artist IDs + genre set so that when the
  // user re-onboards or changes preferences, the cache invalidates itself.
  const sig = profile.artists.map((a) => a.id).join(',') + '|' + profile.genres.join(',')
  const cacheKey = `${CACHE_KEY}:${sig}`

  const home = await cachedJson<AiHome>({
    key: cacheKey,
    ttlMs: CACHE_TTL_MS,
    build: () => buildAiHome(profile),
    isEmpty: (h) => !h?.shelves?.length && !h?.mixes?.length,
    refresh: () => ({ greeting: greeting(), name: profile.name }),
  })

  // MINDBEAT plan shelves — additive, parallel, failure = silently omitted
  let out = home
  try {
    out = await attachPlanShelves(home)
  } catch {
    out = home // plan shelves omitted — home never breaks because of them
  }

  // SHELF BANDIT (task 15-c): per-REQUEST reorder on the parsed-per-request
  // shelf array — runs AFTER the 4h cache retrieval so the curated order
  // stays baked in the cache and the bandit order never pollutes it.
  // Reorder-only: existing shelves never disappear. Failure = curated order.
  try {
    const state = await getShelfBanditState()
    out.shelves = reorderShelves(out.shelves, state)
    out.bandit = banditMeta(state, out.shelves)
  } catch {
    // bandit unavailable → serve the curated order untouched, no bandit field
  }

  return NextResponse.json(out)
}
