import { NextRequest, NextResponse } from 'next/server'
import { radio as ytmRadio, search as ytmSearch } from '@/lib/ytm'
import { readProfile } from '../../onboarding/route'
import { filterSafeTracks } from '@/lib/safety'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/ai/smart-shuffle
 *   body: { tracks: PlayerTrack[] (the queue), count?: number (default 10) }
 *
 * Spotify "Smart Shuffle" equivalent — instead of just randomizing the queue,
 * Smart Shuffle sprinkles in fresh recommendations based on the queue's
 * content + user's prefs.
 *
 * Implementation:
 *   1. Pick 2-3 seed tracks from the input queue (most "defining" — first,
 *      middle, last, or top-by-duration)
 *   2. Fetch radio for each seed
 *   3. Exclude tracks already in the queue
 *   4. Interleave recommendations: insert one recommendation after every
 *      3 queue tracks (so the queue still feels mostly "theirs")
 *   5. Return the augmented queue (preserves the current track at index 0)
 *
 * Returns: {
 *   tracks: PlayerTrack[],            // augmented queue
 *   insertedAt: number[]              // indices where recommendations were inserted
 * }
 */

const DEFAULT_COUNT = 10
const MAX_SEEDS = 3

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
  const body = await req.json().catch(() => ({}))
  const inputTracks: any[] = Array.isArray(body.tracks) ? body.tracks : []
  const targetInsertions: number = Math.min(20, Math.max(2, body.count ?? DEFAULT_COUNT))

  if (!inputTracks.length) {
    return NextResponse.json({ tracks: [], insertedAt: [] })
  }

  // Exclude original queue tracks from being inserted (no dupes)
  const exclude = new Set(inputTracks.map((t) => t.videoId).filter(Boolean))

  // Pick seeds: spread across the queue
  const seedIndices: number[] = []
  if (inputTracks.length >= 3) {
    seedIndices.push(0, Math.floor(inputTracks.length / 2), inputTracks.length - 1)
  } else {
    seedIndices.push(...inputTracks.map((_, i) => i))
  }
  const seeds = seedIndices.slice(0, MAX_SEEDS).map((i) => inputTracks[i])

  // Also include user's prefs via radio if available
  const profile = await readProfile()

  // Collect recommendations from each seed's radio
  const radios: any[][] = []
  for (const seed of seeds) {
    if (!seed?.videoId) continue
    try {
      const r = await ytmRadio(seed.videoId)
      const slice = filterSafeTracks((r.tracks || []).slice(0, 8)).map(trackToPlayer)
      if (slice.length) radios.push(slice)
    } catch { /* skip */ }
  }

  // Supplement with one artist-based search if user has preferences
  if (profile.artists.length && radios.length < 2) {
    try {
      const a = profile.artists[Math.floor(Math.random() * Math.min(profile.artists.length, 3))]
      const r = await ytmSearch(`${a.name} hits`, 'songs')
      const slice = filterSafeTracks((r.tracks || []).slice(0, 5)).map(trackToPlayer)
      if (slice.length) radios.push(slice)
    } catch { /* skip */ }
  }

  // Build insertions: dedupe against exclude + across radios
  const seen = new Set(exclude)
  const insertions: any[] = []
  let radioIdx = 0
  let attempt = 0
  while (insertions.length < targetInsertions && attempt < 50) {
    let added = false
    for (const list of radios) {
      const t = list[radioIdx]
      if (t && !seen.has(t.videoId)) {
        insertions.push(t); seen.add(t.videoId); added = true
      }
      if (insertions.length >= targetInsertions) break
    }
    radioIdx++
    attempt++
    if (!added && radioIdx >= 10) break
  }

  // Interleave: insert one recommendation after every 3 queue tracks
  // (Never insert before index 0 — preserve the currently playing track)
  const result: any[] = []
  const insertedAt: number[] = []
  let insertIdx = 0
  for (let i = 0; i < inputTracks.length; i++) {
    result.push(inputTracks[i])
    // After every 3rd original track (and only if we still have insertions left)
    if (i > 0 && i % 3 === 0 && insertIdx < insertions.length) {
      result.push(insertions[insertIdx])
      insertedAt.push(result.length - 1)
      insertIdx++
    }
  }
  // Append any remaining insertions at the end
  while (insertIdx < insertions.length) {
    result.push(insertions[insertIdx])
    insertedAt.push(result.length - 1)
    insertIdx++
  }

  return NextResponse.json({
    tracks: result,
    insertedAt,
  })
}
