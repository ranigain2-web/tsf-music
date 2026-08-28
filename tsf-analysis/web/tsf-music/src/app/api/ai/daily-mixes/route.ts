import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { artist as ytmArtist, radio as ytmRadio } from '@/lib/ytm'
import { readProfile } from '../../onboarding/route'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ai/daily-mixes
 *
 * Builds up to 6 Spotify-style "Daily Mix" playlists seeded from the user's
 * favorite artists (selected during onboarding). Each mix = radio seeded from
 * one of the user's top artists.
 *
 * Caches the result in ApiCache (key `ai:daily-mixes`) for 12h so we don't
 * recompute on every home open.
 *
 * Returns: { mixes: [{ id, title, subtitle, cover, tracks: PlayerTrack[] }] }
 */

const CACHE_KEY = 'ai:daily-mixes:v1'
const CACHE_TTL_MS = 12 * 60 * 60 * 1000
const MAX_MIXES = 6
const TARGET_TRACKS_PER_MIX = 25

interface DailyMix {
  id: string
  title: string
  subtitle: string
  cover?: string
  tracks: any[]
}

function trackToPlayer(t: any) {
  if (!t) return null
  return {
    videoId: t.videoId || t.id,
    title: t.title,
    artistName: t.artist || t.artistName,
    artistId: t.artistId,
    albumName: t.albumName,
    albumId: t.albumId,
    duration: t.duration || 0,
    thumbnail: t.thumbnail || '',
  }
}

async function buildMixes(): Promise<DailyMix[]> {
  const profile = await readProfile()
  if (profile.artists.length === 0) return []

  // up to 6 artists → up to 6 mixes
  const artists = profile.artists.slice(0, MAX_MIXES)
  const mixes: DailyMix[] = []

  for (let i = 0; i < artists.length; i++) {
    const a = artists[i]
    try {
      // fetch artist page → top track → radio
      const page = await ytmArtist(a.id)
      const topTrack = (page.topTracks || [])[0]
      if (!topTrack) continue
      const radioRes = await ytmRadio(topTrack.videoId)
      const tracks = (radioRes.tracks || []).slice(0, TARGET_TRACKS_PER_MIX).map(trackToPlayer).filter(Boolean)
      mixes.push({
        id: `dm-${i + 1}`,
        title: `Daily Mix ${i + 1}`,
        subtitle: a.name + (page.name && page.name !== a.name ? `, ${page.name}` : ''),
        cover: a.thumbnail || topTrack.thumbnail,
        tracks,
      })
    } catch {
      // skip failed artist silently
    }
  }

  return mixes
}

export async function GET() {
  // read profile for cache key signature
  const profile = await readProfile()
  const sig = profile.artists.map((a) => a.id).join(',')
  const cacheKey = `${CACHE_KEY}:${sig}`

  // try cache
  try {
    const row = await db.apiCache.findUnique({ where: { key: cacheKey } })
    if (row && row.expiresAt.getTime() > Date.now()) {
      const cached = JSON.parse(row.payload)
      if (cached.length > 0) return NextResponse.json({ mixes: cached })
    }
  } catch {}

  const mixes = await buildMixes()
  if (mixes.length > 0) {
    try {
      await db.apiCache.upsert({
        where: { key: cacheKey },
        update: { payload: JSON.stringify(mixes), expiresAt: new Date(Date.now() + CACHE_TTL_MS) },
        create: { key: cacheKey, payload: JSON.stringify(mixes), expiresAt: new Date(Date.now() + CACHE_TTL_MS) },
      })
    } catch {}
  }
  return NextResponse.json({ mixes })
}
