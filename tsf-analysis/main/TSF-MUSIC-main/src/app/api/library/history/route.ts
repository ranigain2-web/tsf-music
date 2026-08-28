import { NextRequest } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

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
    isExplicit: t.isExplicit ?? false,
  }
}

export async function GET(req: NextRequest) {
  const limit = Number(new URL(req.url).searchParams.get('limit')) || 50
  const items = await db.historyItem.findMany({
    orderBy: { playedAt: 'desc' },
    take: limit,
    include: { track: true },
  })
  // dedupe consecutive same-track plays
  const seen = new Set<string>()
  const tracks = items
    .filter((i) => (seen.has(i.trackId) ? false : (seen.add(i.trackId), true)))
    .map((i) => trackToPlayer(i.track))
    .filter(Boolean)
  return Response.json({ tracks })
}

export async function POST(req: NextRequest) {
  const { videoId, track, msPlayed } = await req.json()
  if (!videoId) return Response.json({ error: 'missing videoId' }, { status: 400 })
  if (track) {
    await db.track.upsert({
      where: { id: videoId },
      update: {
        title: track.title, artistName: track.artistName,
        albumName: track.albumName, duration: track.duration, thumbnail: track.thumbnail,
      },
      create: {
        id: videoId, title: track.title || 'Unknown', artistName: track.artistName || 'Unknown artist',
        duration: track.duration || 0, thumbnail: track.thumbnail, albumName: track.albumName,
      },
    }).catch(() => {})
  }
  await db.historyItem.create({ data: { trackId: videoId, msPlayed: msPlayed || 0 } })
  return Response.json({ ok: true })
}
