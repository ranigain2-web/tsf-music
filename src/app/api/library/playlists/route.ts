import { NextRequest } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id')
  if (id) {
    const pl = await db.playlist.findUnique({
      where: { id },
      include: { tracks: { orderBy: { position: 'asc' }, include: { track: true } } },
    })
    if (!pl) return Response.json({ error: 'not found' }, { status: 404 })
    // Map Track → PlayerTrack shape (id → videoId)
    const tracks = pl.tracks
      .map((t) => t.track)
      .filter(Boolean)
      .map((t: any) => ({
        videoId: t.id,
        title: t.title,
        artistName: t.artistName,
        artistId: t.artistId ?? undefined,
        albumName: t.albumName ?? undefined,
        albumId: t.albumId ?? undefined,
        duration: t.duration ?? 0,
        thumbnail: t.thumbnail ?? '',
      }))
    return Response.json({ playlist: { ...pl, tracks } })
  }
  const pls = await db.playlist.findMany({
    orderBy: { updatedAt: 'desc' },
    include: { tracks: { orderBy: { position: 'asc' }, include: { track: true }, take: 4 } },
  })
  // Fetch full track counts in parallel (don't rely on the limited `take: 4` above)
  const counts = await Promise.all(
    pls.map((p) => db.playlistTrack.count({ where: { playlistId: p.id } }))
  )
  return Response.json({
    playlists: pls.map((p, i) => ({
      ...p,
      coverTracks: p.tracks.map((t) => t.track),
      trackCount: counts[i],
    })),
  })
}

export async function POST(req: NextRequest) {
  const { action, playlistId, name, description, videoId, track, trackIds } = await req.json()

  switch (action) {
    case 'create': {
      const pl = await db.playlist.create({ data: { name: name || 'New Playlist', description } })
      return Response.json({ playlist: pl })
    }
    case 'rename': {
      const pl = await db.playlist.update({
        where: { id: playlistId },
        data: { name, description },
      })
      return Response.json({ playlist: pl })
    }
    case 'delete': {
      await db.playlist.delete({ where: { id: playlistId } })
      return Response.json({ ok: true })
    }
    case 'addTrack': {
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
      const count = await db.playlistTrack.count({ where: { playlistId } })
      const existing = await db.playlistTrack.findUnique({
        where: { playlistId_trackId: { playlistId, trackId: videoId } },
      })
      if (existing) return Response.json({ ok: true, duplicate: true })
      await db.playlistTrack.create({
        data: { playlistId, trackId: videoId, position: count },
      })
      await db.playlist.update({ where: { id: playlistId }, data: { updatedAt: new Date() } })
      return Response.json({ ok: true })
    }
    case 'removeTrack': {
      const item = await db.playlistTrack.findUnique({
        where: { playlistId_trackId: { playlistId, trackId: videoId } },
      })
      if (item) {
        await db.playlistTrack.delete({ where: { id: item.id } })
        // reflow positions
        const rest = await db.playlistTrack.findMany({
          where: { playlistId },
          orderBy: { position: 'asc' },
        })
        await Promise.all(rest.map((r, i) => db.playlistTrack.update({ where: { id: r.id }, data: { position: i } })))
      }
      return Response.json({ ok: true })
    }
    case 'reorder': {
      // trackIds = full ordered list
      await Promise.all(
        (trackIds || []).map((tid: string, i: number) =>
          db.playlistTrack.updateMany({
            where: { playlistId, trackId: tid },
            data: { position: i },
          })
        )
      )
      await db.playlist.update({ where: { id: playlistId }, data: { updatedAt: new Date() } })
      return Response.json({ ok: true })
    }
    case 'bulkCreate': {
      // create playlist from track list (AI / radio)
      const pl = await db.playlist.create({ data: { name: name || 'New Playlist', description, source: description?.startsWith('ai') ? 'ai' : 'manual' } })
      for (let i = 0; i < (trackIds || []).length; i++) {
        await db.playlistTrack.create({ data: { playlistId: pl.id, trackId: trackIds[i], position: i } }).catch(() => {})
      }
      return Response.json({ playlist: pl })
    }
  }
  return Response.json({ error: 'unknown action' }, { status: 400 })
}
