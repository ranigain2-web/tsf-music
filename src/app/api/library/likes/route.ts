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

export async function GET() {
  const likes = await db.like.findMany({
    orderBy: { createdAt: 'desc' },
    include: { track: true },
  })
  return Response.json({ tracks: likes.map((l) => trackToPlayer(l.track)).filter(Boolean) })
}

export async function POST(req: NextRequest) {
  const { videoId, track } = await req.json()
  if (!videoId) return Response.json({ error: 'missing videoId' }, { status: 400 })

  // ensure the track exists in catalog (no FK fields — Artist/Album rows may not exist)
  if (track) {
    await db.track.upsert({
      where: { id: videoId },
      update: {
        title: track.title, artistName: track.artistName,
        albumName: track.albumName, duration: track.duration,
        thumbnail: track.thumbnail,
      },
      create: {
        id: videoId, title: track.title || 'Unknown', artistName: track.artistName || 'Unknown artist',
        albumName: track.albumName,
        duration: track.duration || 0, thumbnail: track.thumbnail,
      },
    }).catch(() => {})
  }

  const existing = await db.like.findUnique({ where: { trackId: videoId } })
  if (existing) {
    await db.like.delete({ where: { trackId: videoId } })
    return Response.json({ liked: false })
  }
  await db.like.create({ data: { trackId: videoId } })
  return Response.json({ liked: true })
}
