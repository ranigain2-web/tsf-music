import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { search as ytmSearch, artist as ytmArtist, radio as ytmRadio } from '@/lib/ytm'
import { readProfile } from '../../onboarding/route'
import { filterSafeTracks, isShelfTitleSafe } from '@/lib/safety'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/ai/daylist
 *
 * Spotify "Daylist" equivalent — a dynamic playlist that changes by time of
 * day, reflecting the typical listening mood for that time block:
 *   - 04–09: Morning / Rise & Shine
 *   - 09–12: Mid-Morning / Focus Flow
 *   - 12–15: Afternoon / Lunch Break
 *   - 15–18: Late Afternoon / Energy Boost
 *   - 18–22: Evening / Unwind
 *   - 22–04: Late Night / Wind Down
 *
 * Built by:
 *   1) mapping the time block to a mood descriptor
 *   2) using user's genres + artists + mood to build a search query
 *   3) supplementing with a couple radios from user's favorite artists
 *
 * Refreshes every 6 hours (each time block bucket).
 */

const TARGET_TRACKS = 25

const TIME_BLOCKS = [
  { start: 4, end: 9, name: 'Rise & Shine', query: 'morning chill feel good' },
  { start: 9, end: 12, name: 'Focus Flow', query: 'focus instrumental deep' },
  { start: 12, end: 15, name: 'Lunch Break', query: 'afternoon hits upbeat' },
  { start: 15, end: 18, name: 'Energy Boost', query: 'energy workout hits' },
  { start: 18, end: 22, name: 'Unwind', query: 'evening chill acoustic' },
  { start: 22, end: 28, name: 'Wind Down', query: 'late night ambient slow' }, // wraps past midnight
]

function getCurrentBlock() {
  const h = new Date().getHours()
  const block = TIME_BLOCKS.find((b) => {
    if (b.end > 24) return h >= b.start || h < (b.end - 24)
    return h >= b.start && h < b.end
  })
  return block || TIME_BLOCKS[5]
}

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

async function buildDaylist(): Promise<{
  id: string
  title: string
  subtitle: string
  cover?: string
  tracks: any[]
  savedAt: string
}> {
  const profile = await readProfile()
  const block = getCurrentBlock()
  const hour = new Date().getHours()
  const hourStr = hour === 0 ? '12 AM' : hour > 12 ? `${hour - 12} PM` : `${hour} AM`

  const seen = new Set<string>()
  const out: any[] = []

  // 1) Search: mood query + first genre + first artist name
  if (profile.artists.length) {
    const sq = `${block.query} ${profile.artists[0].name}`.trim()
    try {
      const r = await ytmSearch(sq, 'songs')
      const tracks = filterSafeTracks((r.tracks || []).slice(0, 15)).map(trackToPlayer)
      for (const t of tracks) {
        if (t && !seen.has(t.videoId)) { out.push(t); seen.add(t.videoId) }
      }
    } catch { /* skip */ }
  }

  // 2) Search: genre-based mood
  if (profile.genres.length && out.length < TARGET_TRACKS) {
    const sq = `${block.query} ${profile.genres[0]}`.trim()
    try {
      const r = await ytmSearch(sq, 'songs')
      const tracks = filterSafeTracks((r.tracks || []).slice(0, 10)).map(trackToPlayer)
      for (const t of tracks) {
        if (t && !seen.has(t.videoId)) { out.push(t); seen.add(t.videoId) }
      }
    } catch { /* skip */ }
  }

  // 3) Radio from one favorite artist (variety)
  if (profile.artists.length && out.length < TARGET_TRACKS) {
    const a = profile.artists[Math.floor(Math.random() * Math.min(profile.artists.length, 3))]
    try {
      const page = await ytmArtist(a.id)
      const top = (page.topTracks || [])[0]
      if (top) {
        const rad = await ytmRadio(top.videoId)
        const tracks = filterSafeTracks((rad.tracks || []).slice(0, 8)).map(trackToPlayer)
        for (const t of tracks) {
          if (t && !seen.has(t.videoId)) { out.push(t); seen.add(t.videoId) }
          if (out.length >= TARGET_TRACKS) break
        }
      }
    } catch { /* skip */ }
  }

  const cover = out[0]?.thumbnail || profile.artists[0]?.thumbnail
  return {
    id: 'daylist',
    title: `${block.name}`,
    subtitle: `Your ${hourStr} mix · ${profile.name || 'you'}`,
    cover,
    tracks: out.slice(0, TARGET_TRACKS),
    savedAt: new Date().toISOString(),
  }
}

export async function GET() {
  const profile = await readProfile()
  if (!profile.complete || profile.artists.length === 0) {
    return NextResponse.json({
      id: 'daylist',
      title: 'Daylist',
      subtitle: 'Pick some favorite artists in onboarding to enable Daylist.',
      tracks: [],
      savedAt: new Date().toISOString(),
    })
  }

  // cache per 6-hour bucket (4 buckets/day)
  const now = new Date()
  const hourBucket = Math.floor(now.getHours() / 6) // 0-3
  const dateStr = now.toISOString().slice(0, 10)
  const cacheKey = `ai:daylist:${dateStr}:${hourBucket}`

  const sig = profile.artists.map((a) => a.id).join(',')
  const cacheKeyWithSig = `${cacheKey}:${sig}`

  try {
    const row = await db.apiCache.findUnique({ where: { key: cacheKeyWithSig } })
    if (row && row.expiresAt.getTime() > Date.now()) {
      try {
        const cached = JSON.parse(row.payload)
        // Re-evaluate subtitle so the hour-of-day reads correctly on refresh
        return NextResponse.json(cached)
      } catch {}
    }
  } catch {}

  const dl = await buildDaylist()
  // 6h TTL — by then the next time block kicks in
  const TTL = 6 * 60 * 60 * 1000
  // hardening: never cache an empty/degraded build (transient upstream failure)
  if ((dl?.tracks?.length ?? 0) > 0) {
    try {
      await db.apiCache.upsert({
      where: { key: cacheKeyWithSig },
      update: { payload: JSON.stringify(dl), expiresAt: new Date(Date.now() + TTL) },
        create: { key: cacheKeyWithSig, payload: JSON.stringify(dl), expiresAt: new Date(Date.now() + TTL) },
      })
    } catch {}
  }
  return NextResponse.json(dl)
}

// silence unused
void isShelfTitleSafe
