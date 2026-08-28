import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { artist as ytmArtist, radio as ytmRadio } from '@/lib/ytm'
import { readProfile, type SelectedArtist } from '../../onboarding/route'
import { filterSafeTracks } from '@/lib/safety'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * GET /api/ai/discover-weekly
 *
 * Spotify "Discover Weekly" equivalent — a 30-track playlist that mixes:
 *   - the user's top 2-3 favorite artists' radios (the spine)
 *   - related/similar artists' radios (the discovery portion)
 *   - light genre search (filler for variety)
 *
 * Refreshes weekly (caches 7 days). Each Monday the cache rolls forward.
 */

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TARGET_TRACKS = 30

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

async function findRelatedArtists(artistId: string, n: number): Promise<SelectedArtist[]> {
  try {
    const page = await ytmArtist(artistId)
    const related = (page.shelves || []).find(
      (s) => /related|similar|fans might also like|discover more/i.test(s.title) && s.artists?.length
    )
    if (!related?.artists) return []
    return related.artists.slice(0, n).map((a) => ({
      id: a.browseId,
      name: a.name,
      thumbnail: a.thumbnail || '',
    }))
  } catch {
    return []
  }
}

async function buildDiscoverWeekly(): Promise<{
  id: string
  title: string
  subtitle: string
  cover?: string
  tracks: any[]
  savedAt: string
} | null> {
  const profile = await readProfile()
  if (!profile.artists.length) return null

  const favoriteSeeds = profile.artists.slice(0, 3)

  // PHASE 1 (parallel): For each favorite seed, fetch artist page + radio in
  // a single promise. All 3 seeds run concurrently. We also fetch each
  // favorite's related-artists list at the same time — this used to be
  // sequential and took 5-10s; now it's ~1.5s.
  const favResults = await Promise.all(
    favoriteSeeds.map(async (a) => {
      try {
        const page = await ytmArtist(a.id)
        const topTrack = (page.topTracks || [])[0]
        const related = await findRelatedArtists(a.id, 2)
        let radio: any[] = []
        if (topTrack) {
          try {
            const r = await ytmRadio(topTrack.videoId)
            radio = filterSafeTracks((r.tracks || []).slice(0, 10)).map(trackToPlayer).filter(Boolean)
          } catch { /* skip */ }
        }
        return { radio, related, ok: radio.length > 0 }
      } catch {
        return { radio: [], related: [], ok: false }
      }
    })
  )

  const favoriteRadios = favResults
    .filter((r) => r.radio.length > 0)
    .map((r) => r.radio)

  // PHASE 2 (parallel): For each related artist from the favorite seeds,
  // fetch their artist page + top track + radio. All related artists run
  // in parallel — previously sequential (slowest part).
  const relatedPromises: Promise<any[]>[] = []
  const seenRelated = new Set<string>()
  for (const r of favResults) {
    for (const rel of r.related) {
      if (seenRelated.has(rel.id)) continue
      seenRelated.add(rel.id)
      if (relatedPromises.length >= 6) break
      relatedPromises.push(
        (async () => {
          try {
            const page = await ytmArtist(rel.id)
            const top = (page.topTracks || [])[0]
            if (!top) return []
            const rad = await ytmRadio(top.videoId)
            return filterSafeTracks((rad.tracks || []).slice(0, 6)).map(trackToPlayer).filter(Boolean)
          } catch {
            return []
          }
        })()
      )
    }
    if (relatedPromises.length >= 6) break
  }
  const relatedRadios = (await Promise.all(relatedPromises)).filter((r) => r.length > 0)

  const seen = new Set<string>()
  const out: any[] = []
  const allRadios = [...favoriteRadios, ...relatedRadios]
  let idx = 0
  while (out.length < TARGET_TRACKS && idx < 50) {
    let added = false
    for (const list of allRadios) {
      const t = list[idx]
      if (t && !seen.has(t.videoId)) {
        out.push(t); seen.add(t.videoId); added = true
      }
      if (out.length >= TARGET_TRACKS) break
    }
    idx++
    if (!added && idx >= 50) break
  }

  if (!out.length) return null
  const cover = favoriteSeeds[0]?.thumbnail || out[0]?.thumbnail

  return {
    id: 'dw',
    title: 'Discover Weekly',
    subtitle: `Your weekly mixtape · ${favoriteSeeds.map((a) => a.name).join(', ')} + related`,
    cover,
    tracks: out,
    savedAt: new Date().toISOString(),
  }
}

export async function GET() {
  const profile = await readProfile()
  if (!profile.complete || profile.artists.length === 0) {
    return NextResponse.json({
      id: 'dw',
      title: 'Discover Weekly',
      subtitle: 'Pick some favorite artists in onboarding to enable Discover Weekly.',
      tracks: [],
      savedAt: new Date().toISOString(),
    })
  }

  const sig = profile.artists.map((a) => a.id).join(',') + '|' + profile.genres.join(',')
  const now = new Date()
  const dayOfWeek = (now.getDay() + 6) % 7
  const monday = new Date(now)
  monday.setDate(now.getDate() - dayOfWeek)
  monday.setHours(0, 0, 0, 0)
  const weekBucket = monday.toISOString().slice(0, 10)
  const cacheKey = `ai:discover-weekly:${sig}:${weekBucket}`

  try {
    const row = await db.apiCache.findUnique({ where: { key: cacheKey } })
    if (row && row.expiresAt.getTime() > Date.now()) {
      try {
        const cached = JSON.parse(row.payload)
        return NextResponse.json(cached)
      } catch {}
    }
  } catch {}

  const dw = await buildDiscoverWeekly()
  if (dw) {
    try {
      await db.apiCache.upsert({
        where: { key: cacheKey },
        update: { payload: JSON.stringify(dw), expiresAt: new Date(Date.now() + CACHE_TTL_MS) },
        create: { key: cacheKey, payload: JSON.stringify(dw), expiresAt: new Date(Date.now() + CACHE_TTL_MS) },
      })
    } catch {}
    return NextResponse.json(dw)
  }

  return NextResponse.json({
    id: 'dw',
    title: 'Discover Weekly',
    subtitle: 'Could not build your mixtape this week. Try again later.',
    tracks: [],
    savedAt: new Date().toISOString(),
  })
}
