import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { readProfile, type SelectedArtist } from '../../onboarding/route'
import { artist as ytmArtist, radio as ytmRadio, search as ytmSearch } from '@/lib/ytm'
import type { YtmTrack, YtmAlbum, YtmArtist, YtmShelf } from '@/lib/ytm'
import { filterSafeTracks, isShelfTitleSafe } from '@/lib/safety'
import { cachedJson } from '@/lib/ai/cache'

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
 * Result cached in ApiCache (key `ai:home:v1`) for 4h.
 */

const CACHE_KEY = 'ai:home:v1'
const CACHE_TTL_MS = 4 * 60 * 60 * 1000

interface AiHome {
  shelves: YtmShelf[]
  mixes: { id: string; title: string; subtitle: string; cover?: string; tracks: any[] }[]
  topArtists: SelectedArtist[]
  greeting: string
  name?: string
  needsOnboarding?: boolean
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Late night'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  if (h < 22) return 'Good evening'
  return 'Good night'
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

async function buildTopTracksShelf(artist: SelectedArtist): Promise<YtmShelf | null> {
  try {
    const page = await ytmArtist(artist.id)
    const tracks = filterSafeTracks((page.topTracks || []).slice(0, 8))
    if (!tracks.length) return null
    return {
      title: `${artist.name} · Top tracks`,
      subtitle: "Songs you'll recognise",
      tracks,
    }
  } catch {
    return null
  }
}

async function buildMoreLikeShelf(artist: SelectedArtist): Promise<YtmShelf | null> {
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
      title: `More like ${artist.name}`,
      subtitle: "Artists you'll probably love",
      artists: safeArtists,
    }
  } catch {
    return null
  }
}

async function buildDiscographyShelf(artist: SelectedArtist): Promise<YtmShelf | null> {
  try {
    const page = await ytmArtist(artist.id)
    const discog = (page.shelves || []).find((s) => /albums|discography|releases/i.test(s.title) && s.albums?.length)
    if (!discog || !discog.albums?.length) return null
    const safeAlbums = discog.albums
      .filter((a) => isShelfTitleSafe(a.name + ' ' + (a.artistName || '')))
      .slice(0, 10)
    if (!safeAlbums.length) return null
    return {
      title: `${artist.name} · Albums`,
      subtitle: 'Full discography at a glance',
      albums: safeAlbums,
    }
  } catch {
    return null
  }
}

async function buildGenreShelf(genre: string, subtitle: string): Promise<YtmShelf | null> {
  try {
    const r = await ytmSearch(`${genre} hits`, 'songs')
    const tracks = filterSafeTracks((r.tracks || []).slice(0, 12))
    if (!tracks.length) return null
    return { title: subtitle, tracks }
  } catch {
    return null
  }
}

async function buildAiHome(profile: Awaited<ReturnType<typeof readProfile>>): Promise<AiHome> {
  const shelves: YtmShelf[] = []

  // 1. "Your top artists" shelf — artist cards from prefs
  const topArtists: YtmShelf = {
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

  return NextResponse.json(home)
}
