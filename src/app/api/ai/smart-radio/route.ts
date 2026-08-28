import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { artist as ytmArtist, radio as ytmRadio } from '@/lib/ytm'
import { readProfile } from '../../onboarding/route'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ai/smart-radio
 *   Builds a single "Smart Radio" queue that mixes the user's favorite artists
 *   by chaining their radios together. ~50 tracks.
 *
 *   Implementation: take the first track videoId of each of the user's favorite
 *   artists' top tracks, fetch each artist's radio, then interleave (round-robin)
 *   to produce a varied 50-track queue.
 */

const TARGET_TOTAL = 50
const PER_ARTIST = 8

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

export async function GET() {
  const profile = await readProfile()
  if (profile.artists.length === 0) {
    return NextResponse.json({ tracks: [], subtitle: 'Pick some favorite artists in onboarding to enable Smart Radio.' })
  }

  const perArtist: any[][] = []
  const seen = new Set<string>()
  for (const a of profile.artists.slice(0, 8)) {
    try {
      const page = await ytmArtist(a.id)
      const top = (page.topTracks || [])[0]
      if (!top) continue
      const r = await ytmRadio(top.videoId)
      const slice: any[] = (r.tracks || []).slice(0, PER_ARTIST).map(trackToPlayer).filter(Boolean)
      const filtered = slice.filter((t) => !seen.has(t.videoId))
      for (const t of filtered) {
        if (t) seen.add(t.videoId)
      }
      perArtist.push(filtered)
    } catch {}
  }

  // interleave round-robin
  // (NOTE: `seen` was already used to dedupe tracks across artists while
  // building perArtist. We must NOT re-check it here — those tracks are
  // already in `seen` by construction, so checking again would yield 0 tracks.)
  const out: any[] = []
  let idx = 0
  while (out.length < TARGET_TOTAL) {
    let added = false
    for (const list of perArtist) {
      const t = list[idx]
      if (t) {
        out.push(t)
        added = true
        if (out.length >= TARGET_TOTAL) break
      }
    }
    idx++
    if (!added && idx >= 100) break  // safety brake
  }

  return NextResponse.json({
    tracks: out.slice(0, TARGET_TOTAL),
    subtitle: profile.artists.slice(0, 6).map((a) => a.name).join(' · ') || 'Smart Radio',
  })
}
