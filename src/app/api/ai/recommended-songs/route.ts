import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { radio as ytmRadio } from '@/lib/ytm'
import { filterSafeTracks } from '@/lib/safety'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/ai/recommended-songs
 *
 * Spotify "Recommended Songs" panel — given a seed of trackIds (e.g. an album
 * or a playlist), return ~10-15 tracks the user might also like. Used at the
 * bottom of playlist/album views.
 *
 * Implementation: For each seed (up to 3), fetch its radio via InnerTube `next`
 * (RDAMVM endpoint), then interleave and dedupe against the seed list.
 *
 * Body: { seedTrackIds: string[], excludeTrackIds?: string[] }
 * Returns: { tracks: PlayerTrack[] }
 */

const MAX_SEEDS = 3
const TARGET = 12

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

export async function POST(req: NextRequest) {
  const { seedTrackIds, excludeTrackIds } = (await req.json()) as {
    seedTrackIds: string[]
    excludeTrackIds?: string[]
  }
  if (!Array.isArray(seedTrackIds) || !seedTrackIds.length) {
    return NextResponse.json({ tracks: [] })
  }

  const exclude = new Set<string>(excludeTrackIds || [])
  const seen = new Set<string>()
  const radios: any[][] = []

  // PARALLEL: fetch all seed radios at once. Previously this was a sequential
  // for-loop (one radio per seed) that took ~3 * 500ms = 1.5s. Now it's a
  // single round of ~500ms via Promise.all.
  const seedResults = await Promise.all(
    seedTrackIds.slice(0, MAX_SEEDS).map(async (vid) => {
      try {
        const r = await ytmRadio(vid)
        return filterSafeTracks((r.tracks || []).slice(0, 20)).map(trackToPlayer).filter(Boolean)
      } catch {
        return []
      }
    })
  )
  for (const slice of seedResults) {
    if (slice.length) radios.push(slice)
  }

  const out: any[] = []
  let idx = 0
  while (out.length < TARGET && idx < 30) {
    let added = false
    for (const list of radios) {
      const t = list[idx]
      if (t && !seen.has(t.videoId) && !exclude.has(t.videoId)) {
        out.push(t); seen.add(t.videoId); added = true
      }
      if (out.length >= TARGET) break
    }
    idx++
    if (!added && idx >= 30) break
  }

  return NextResponse.json({ tracks: out })
}

export async function GET(req: NextRequest) {
  // GET form: ?seed=videoId1&seed=videoId2&exclude=videoId3
  const url = new URL(req.url)
  const seeds = url.searchParams.getAll('seed')
  const excludes = url.searchParams.getAll('exclude')
  if (!seeds.length) return NextResponse.json({ tracks: [] })
  // delegate to POST logic
  return POST(new NextRequest(req.url, {
    method: 'POST',
    body: JSON.stringify({ seedTrackIds: seeds, excludeTrackIds: excludes }),
    headers: { 'Content-Type': 'application/json' },
  }))
}

void db
