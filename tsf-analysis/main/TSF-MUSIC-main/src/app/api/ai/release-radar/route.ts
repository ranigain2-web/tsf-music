import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { artist as ytmArtist, search as ytmSearch } from '@/lib/ytm'
import { readProfile } from '../../onboarding/route'
import { filterSafeTracks, isShelfTitleSafe } from '@/lib/safety'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * GET /api/ai/release-radar
 *
 * Spotify "Release Radar" equivalent — a 25-track playlist of recent releases
 * from the user's favorite artists + their favorite artists' latest featured tracks.
 *
 * Implementation:
 *   1. For each favorite artist (up to 8), pull their artist page and look
 *      at the "New releases" / "Latest" / "Singles" shelf.
 *   2. If none, search "[artist name] new song 2024" or "[artist name] latest".
 *   3. Aggregate and dedupe.
 *
 * Refreshes weekly (Friday anchored — matches Spotify's Release Radar drop).
 */

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TARGET_TRACKS = 25
const CURRENT_YEAR = new Date().getFullYear()

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
    year: t.year,
  }
}

async function findArtistNewReleases(artistId: string, artistName: string): Promise<any[]> {
  try {
    const page = await ytmArtist(artistId)

    // Look for "New releases" / "Latest" / "Singles" shelf
    const newShelf = (page.shelves || []).find(
      (s) => /new\s*(releases|singles|music)|latest|just\s*out/i.test(s.title) && (s.albums?.length || s.tracks?.length)
    )

    if (newShelf) {
      // Walk albums → fetch tracks (best-effort: just take first track of each album)
      if (newShelf.albums?.length) {
        const out: any[] = []
        for (const alb of newShelf.albums.slice(0, 3)) {
          try {
            const albumRes = await import('@/lib/ytm').then((m) => m.album(alb.browseId))
            const firstTrack = filterSafeTracks(albumRes.tracks || []).slice(0, 1)[0]
            if (firstTrack) out.push(firstTrack)
          } catch { /* skip */ }
          if (out.length >= 5) break
        }
        if (out.length) return out
      }
      if (newShelf.tracks?.length) {
        return filterSafeTracks(newShelf.tracks.slice(0, 5))
      }
    }

    // Fallback: search "{artist} new song {year}"
    const sq = `${artistName} new song ${CURRENT_YEAR}`
    const r = await ytmSearch(sq, 'songs')
    return filterSafeTracks((r.tracks || []).slice(0, 5))
  } catch {
    return []
  }
}

async function buildReleaseRadar(): Promise<{
  id: string
  title: string
  subtitle: string
  cover?: string
  tracks: any[]
  savedAt: string
} | null> {
  const profile = await readProfile()
  if (!profile.artists.length) return null

  const seen = new Set<string>()
  const out: any[] = []

  for (const a of profile.artists.slice(0, 8)) {
    if (out.length >= TARGET_TRACKS) break
    const fresh = await findArtistNewReleases(a.id, a.name)
    for (const t of fresh) {
      const vid = t.videoId || t.id
      if (!vid || seen.has(vid)) continue
      // SAFETY check on track title/artist
      if (!isShelfTitleSafe(`${t.title} ${t.artistName || t.artist || ''}`)) continue
      seen.add(vid)
      out.push(trackToPlayer(t))
      if (out.length >= TARGET_TRACKS) break
    }
  }

  if (!out.length) return null
  const cover = profile.artists[0]?.thumbnail || out[0]?.thumbnail

  return {
    id: 'rr',
    title: 'Release Radar',
    subtitle: `New from ${profile.artists.slice(0, 5).map((a) => a.name).join(', ')}`,
    cover,
    tracks: out,
    savedAt: new Date().toISOString(),
  }
}

export async function GET() {
  const profile = await readProfile()
  if (!profile.complete || profile.artists.length === 0) {
    return NextResponse.json({
      id: 'rr',
      title: 'Release Radar',
      subtitle: 'Pick some favorite artists in onboarding to enable Release Radar.',
      tracks: [],
      savedAt: new Date().toISOString(),
    })
  }

  const sig = profile.artists.map((a) => a.id).join(',')
  // Friday-anchored week bucket
  const now = new Date()
  const dayOfWeek = (now.getDay() + 2) % 7 // 0=Fri
  const friday = new Date(now)
  friday.setDate(now.getDate() - dayOfWeek)
  friday.setHours(0, 0, 0, 0)
  const weekBucket = friday.toISOString().slice(0, 10)
  const cacheKey = `ai:release-radar:${sig}:${weekBucket}`

  try {
    const row = await db.apiCache.findUnique({ where: { key: cacheKey } })
    if (row && row.expiresAt.getTime() > Date.now()) {
      try {
        const cached = JSON.parse(row.payload)
        return NextResponse.json(cached)
      } catch {}
    }
  } catch {}

  const rr = await buildReleaseRadar()
  if (rr) {
    try {
      await db.apiCache.upsert({
        where: { key: cacheKey },
        update: { payload: JSON.stringify(rr), expiresAt: new Date(Date.now() + CACHE_TTL_MS) },
        create: { key: cacheKey, payload: JSON.stringify(rr), expiresAt: new Date(Date.now() + CACHE_TTL_MS) },
      })
    } catch {}
    return NextResponse.json(rr)
  }

  return NextResponse.json({
    id: 'rr',
    title: 'Release Radar',
    subtitle: 'No new releases found this week. Try again later.',
    tracks: [],
    savedAt: new Date().toISOString(),
  })
}
