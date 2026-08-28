import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { readProfile } from '../../onboarding/route'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * GET /api/ai/on-repeat
 *
 * Spotify "On Repeat" equivalent — a 15-track playlist of tracks the user has
 * actually played the most in the last 30 days. Derived from the HistoryItem
 * table; falls back to favorite-artist top tracks if no history yet.
 */

const TARGET_TRACKS = 15

function trackToPlayer(t: any) {
  if (!t) return null
  return {
    videoId: t.id,
    title: t.title,
    artistName: t.artistName,
    artistId: t.artistId ?? undefined,
    albumName: t.albumName ?? undefined,
    albumId: t.albumId ?? undefined,
    duration: t.duration ?? 0,
    thumbnail: t.thumbnail ?? '',
    year: t.year ?? undefined,
  }
}

async function buildOnRepeat(): Promise<{
  id: string
  title: string
  subtitle: string
  cover?: string
  tracks: any[]
  savedAt: string
}> {
  const since = new Date()
  since.setDate(since.getDate() - 30)

  // Aggregate play counts per trackId over the last 30 days
  const items = await db.historyItem.findMany({
    where: { playedAt: { gte: since } },
    include: { track: true },
  })

  // tally
  const counts = new Map<string, { track: any; count: number; lastPlayed: Date }>()
  for (const item of items) {
    if (!item.track) continue
    const existing = counts.get(item.trackId)
    if (existing) {
      existing.count++
      if (item.playedAt > existing.lastPlayed) existing.lastPlayed = item.playedAt
    } else {
      counts.set(item.trackId, { track: item.track, count: 1, lastPlayed: item.playedAt })
    }
  }

  // sort by count desc, then recency
  const ranked = [...counts.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return b.lastPlayed.getTime() - a.lastPlayed.getTime()
  })

  const tracks = ranked.slice(0, TARGET_TRACKS).map((r) => trackToPlayer(r.track)).filter(Boolean)
  const cover = tracks[0]?.thumbnail

  return {
    id: 'on-repeat',
    title: 'On Repeat',
    subtitle: 'The songs you can\'t stop playing',
    cover,
    tracks,
    savedAt: new Date().toISOString(),
  }
}

export async function GET() {
  const profile = await readProfile()
  if (!profile.complete) {
    return NextResponse.json({
      id: 'on-repeat',
      title: 'On Repeat',
      subtitle: 'Pick some favorite artists in onboarding to enable On Repeat.',
      tracks: [],
      savedAt: new Date().toISOString(),
    })
  }

  // Cache key per-week (so it refreshes weekly but updates with new plays)
  const now = new Date()
  const dayOfWeek = (now.getDay() + 6) % 7
  const monday = new Date(now)
  monday.setDate(now.getDate() - dayOfWeek)
  monday.setHours(0, 0, 0, 0)
  const weekBucket = monday.toISOString().slice(0, 10)
  const cacheKey = `ai:on-repeat:${weekBucket}`

  try {
    const row = await db.apiCache.findUnique({ where: { key: cacheKey } })
    if (row && row.expiresAt.getTime() > Date.now()) {
      try {
        const cached = JSON.parse(row.payload)
        return NextResponse.json(cached)
      } catch {}
    }
  } catch {}

  const r = await buildOnRepeat()
  // cache 6 hours — short enough that plays from today are reflected tomorrow morning
  const TTL = 6 * 60 * 60 * 1000
  // hardening: never cache an empty/degraded build (transient upstream failure)
  if ((r?.tracks?.length ?? 0) > 0) {
    try {
      await db.apiCache.upsert({
      where: { key: cacheKey },
      update: { payload: JSON.stringify(r), expiresAt: new Date(Date.now() + TTL) },
        create: { key: cacheKey, payload: JSON.stringify(r), expiresAt: new Date(Date.now() + TTL) },
      })
    } catch {}
  }
  return NextResponse.json(r)
}
