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
  // raw=1 → per-play rows with msPlayed + playedAt, no dedupe (Your Sound stats
  // need repeat plays and real listened-ms — the 30-second rule source data).
  const raw = new URL(req.url).searchParams.get('raw') != null
  const items = await db.historyItem.findMany({
    orderBy: { playedAt: 'desc' },
    take: limit,
    include: { track: true },
  })
  // dedupe consecutive same-track plays (display feed only — raw mode skips this)
  const seen = new Set<string>()
  const rows = raw ? items : items.filter((i) => (seen.has(i.trackId) ? false : (seen.add(i.trackId), true)))
  const tracks = rows
    .map((i) => {
      const t = trackToPlayer(i.track)
      if (!t) return null
      return raw ? { ...t, msPlayed: i.msPlayed, playedAt: i.playedAt.toISOString() } : t
    })
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

/**
 * PATCH /api/library/history — listen-end flush from the audio engine.
 * Called when the listener leaves a track (skip/complete/unmount) with the
 * REAL accumulated listened ms (sendBeacon body arrives as POST-shaped —
 * detect via method header fallback below). Updates the most recent history
 * row for that track so "how long did you actually listen" becomes truthful.
 */
export async function PATCH(req: NextRequest) {
  const { videoId, msPlayed, completed } = await req.json().catch(() => ({}))
  if (!videoId) return Response.json({ error: 'missing videoId' }, { status: 400 })
  const ms = Math.max(0, Math.min(Math.round(msPlayed || 0), 3600_000))
  if (ms <= 0) return Response.json({ ok: true, skipped: true })
  const latest = await db.historyItem.findFirst({
    where: { trackId: videoId },
    orderBy: { playedAt: 'desc' },
  })
  if (!latest) return Response.json({ ok: true, skipped: true })
  // keep the larger of recorded-vs-flushed (dedup safe under double flush)
  await db.historyItem.update({
    where: { id: latest.id },
    data: { msPlayed: Math.max(latest.msPlayed, ms) },
  })
  return Response.json({ ok: true })
}
