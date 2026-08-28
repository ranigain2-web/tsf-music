'use client'

/**
 * MINDBEAT RADIO V2 — client helper.
 *
 * POSTs /api/mindbeat/radio (Decision Engine multi-seed + drift control +
 * 7-day dedup) and returns PlayerTracks ready for playQueue. The caller
 * ALWAYS keeps its previous flow as the fallback: if the engine route fails
 * for any reason, radio still works the old way (/api/ytm/radio).
 */

import type { PlayerTrack } from '@/store/player'
import type { EnginePick } from '@/lib/mindbeat/types'

interface PickShape {
  track: {
    videoId: string
    title: string
    artistName: string
    artistId?: string
    duration?: number
    thumbnail?: string
  }
}

/** Engine picks → queue rows (EnginePick.track ⊂ PlayerTrack). */
export function picksToTracks(picks: PickShape[]): PlayerTrack[] {
  return (picks ?? [])
    .filter((p) => p?.track?.videoId)
    .map((p: PickShape) => ({
      videoId: p.track.videoId,
      title: p.track.title,
      artistName: p.track.artistName,
      ...(p.track.artistId ? { artistId: p.track.artistId } : {}),
      duration: p.track.duration ?? 0,
      thumbnail: p.track.thumbnail ?? '',
    }))
}

/**
 * Fetch a Mindbeat radio for the seed track. Resolves null on any failure —
 * callers then fall back to the legacy radio endpoint. Stamps the picks for
 * REC_EXPOSURE attribution (surface 'radio').
 */
export async function fetchMindbeatRadio(
  seedTrack: PlayerTrack,
  count = 25,
  exclude: string[] = []
): Promise<PlayerTrack[] | null> {
  try {
    const r = await fetch('/api/mindbeat/radio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seedTrack: {
          videoId: seedTrack.videoId,
          ...(seedTrack.title ? { title: seedTrack.title } : {}),
          ...(seedTrack.artistName ? { artistName: seedTrack.artistName } : {}),
          ...(seedTrack.artistId ? { artistId: seedTrack.artistId } : {}),
          ...(seedTrack.duration ? { duration: seedTrack.duration } : {}),
          ...(seedTrack.thumbnail ? { thumbnail: seedTrack.thumbnail } : {}),
        },
        count,
        exclude,
      }),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { picks?: EnginePick[] }
    const tracks = picksToTracks(j?.picks ?? [])
    if (!tracks.length) return null
    // MINDBEAT: attribute these rows to the radio surface
    try {
      const m = await import('@/lib/mindbeat/client')
      m.markQueueSource(tracks, 'radio')
    } catch {
      /* instrumentation only */
    }
    return tracks
  } catch {
    return null
  }
}
