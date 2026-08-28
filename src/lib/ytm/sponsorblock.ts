/**
 * TSF Music — SponsorBlock integration ("straight to the music")
 *
 * Ported from Musify (GPL v3, github.com/gokadzev/Musify —
 * lib/services/common_services.dart). Musify's pitch: "No ads" — it works
 * by skipping the NON-MUSIC parts of YouTube uploads:
 *
 *   sponsor         — paid promotions baked into the video
 *   selfpromo       — creator's own merch/social plugs
 *   interaction     — "like & subscribe" beggings
 *   intro           — intros / title cards before the music starts
 *   outro           — outros / end cards after the music ends
 *   music_offtopic  — explicitly-tagged non-music sections (talking, skits)
 *
 * Segments come from the community-curated SponsorBlock database
 * (sponsor.ajay.app — the same one used by millions of SponsorBlock
 * extension users). For most studio recordings there are no segments and
 * this is a no-op; for music videos with intros/outros/plugs the player
 * hops straight over them, giving an ad-free, all-music experience.
 *
 * Caching: 404 ("no segments") is a definitive answer and is remembered
 * for 24h; real segments are remembered for 7 days (they rarely change;
 * more votes can shift boundaries slightly but skip targets stay stable).
 */

export interface SkipSegment {
  start: number
  end: number
  category: string
}

const API_BASE = 'https://sponsor.ajay.app/api/skipSegments'
const CATEGORIES = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'music_offtopic']

const EMPTY_TTL_MS = 24 * 60 * 60 * 1000
const SEGMENTS_TTL_MS = 7 * 24 * 60 * 60 * 1000

// in-process cache (per server instance)
const memory = new Map<string, { segments: SkipSegment[]; expires: number }>()

function apiCacheKey(videoId: string): string {
  return `sponsorblock:${videoId}`
}

async function dbGet(videoId: string): Promise<SkipSegment[] | null> {
  try {
    const { db } = await import('@/lib/db')
    const row = await db.apiCache.findUnique({ where: { key: apiCacheKey(videoId) } })
    if (!row) return null
    if (new Date(row.expiresAt).getTime() < Date.now()) return null
    return JSON.parse(row.payload)
  } catch {
    return null
  }
}

async function dbSet(videoId: string, segments: SkipSegment[], ttlMs: number): Promise<void> {
  try {
    const { db } = await import('@/lib/db')
    const payload = JSON.stringify(segments)
    const expiresAt = new Date(Date.now() + ttlMs)
    await db.apiCache.upsert({
      where: { key: apiCacheKey(videoId) },
      update: { payload, expiresAt },
      create: { key: apiCacheKey(videoId), payload, expiresAt },
    })
  } catch {
    /* cache write failures are non-fatal */
  }
}

async function fetchSegments(videoId: string): Promise<SkipSegment[] | null> {
  const url = new URL(API_BASE)
  url.searchParams.set('videoID', videoId)
  for (const c of CATEGORIES) url.searchParams.append('category', c)
  url.searchParams.set('actionType', 'skip')

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    })
    // 404 = "this video has no segments" — a definitive empty answer.
    if (res.status === 404) return []
    if (!res.ok) return null // transient failure — do NOT cache
    const data = (await res.json()) as Array<{
      segment: [number, number]
      category: string
    }>
    return data.map((d) => ({
      start: Number(d.segment?.[0]) || 0,
      end: Number(d.segment?.[1]) || 0,
      category: String(d.category || 'unknown'),
    }))
  } catch {
    return null // network error — do NOT cache
  }
}

/**
 * Get the skip segments for a track. Returns [] when the track is clean
 * (or on any failure — skipping must never break playback).
 */
export async function getSkipSegments(videoId: string): Promise<SkipSegment[]> {
  if (!videoId) return []

  // 1. memory
  const mem = memory.get(videoId)
  if (mem && mem.expires > Date.now()) return mem.segments

  // 2. db cache
  const cached = await dbGet(videoId)
  if (cached) {
    memory.set(videoId, { segments: cached, expires: Date.now() + 10 * 60 * 1000 })
    return cached
  }

  // 3. live fetch
  const segments = await fetchSegments(videoId)
  if (segments === null) return [] // transient failure — skip silently

  memory.set(videoId, { segments, expires: Date.now() + 10 * 60 * 1000 })
  await dbSet(videoId, segments, segments.length === 0 ? EMPTY_TTL_MS : SEGMENTS_TTL_MS)
  return segments
}

/**
 * Sanitize raw segments into a skip plan for the player:
 *   - sorted by start
 *   - overlapping/adjacent segments merged
 *   - micro-segments under 1.5s dropped (jarring seek for no gain)
 *   - segments that reach the very end of the track dropped (would make
 *     the track "end early" — outro skips must leave the last 2s alone)
 *   - the opening is only skipped if it is unambiguous (< 30s of non-music)
 */
export function buildSkipPlan(raw: SkipSegment[], trackDurationSec?: number): SkipSegment[] {
  const sorted = [...raw]
    .filter((s) => s.end > s.start && s.end - s.start >= 1.5)
    .sort((a, b) => a.start - b.start)

  const merged: SkipSegment[] = []
  for (const seg of sorted) {
    const last = merged[merged.length - 1]
    if (last && seg.start <= last.end + 0.5) {
      last.end = Math.max(last.end, seg.end)
    } else {
      merged.push({ ...seg })
    }
  }

  const duration = isFinite(trackDurationSec as number) ? (trackDurationSec as number) : 0
  return merged.filter((s) => {
    // never skip the tail end of a track — let it finish naturally
    if (duration > 0 && s.end >= duration - 2) return false
    // intros longer than 30s are likely mislabeled — don't skip half the song
    if (s.start < 1 && s.end - s.start > 30) return false
    return true
  })
}
