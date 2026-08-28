import { NextResponse } from 'next/server'
import { readProfile } from '../../onboarding/route'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * GET /api/ai/featured
 *
 * Returns the LIGHTWEIGHT metadata for all AI playlist hubs (no tracks):
 *   - Discover Weekly
 *   - Release Radar
 *   - Daylist (current time block)
 *   - On Repeat
 *   - Mood hubs (10 moods)
 *
 * The Home view renders these as cards. Clicking a card loads the tracks
 * from the individual endpoints.
 */

interface FeaturedCard {
  id: string
  kind: 'playlist' | 'mood-hub'
  title: string
  subtitle: string
  cover?: string
  gradient?: [string, string]
  emoji?: string
  icon?: string
  endpoint: string
  view?: 'playlist' | 'ai-generated'
}

const MOODS: { key: string; label: string; subtitle: string; gradient: [string, string]; emoji: string }[] = [
  { key: 'chill',     label: 'Chill',     subtitle: 'Kick back & relax',    gradient: ['#1e3264', '#503750'], emoji: '🌙' },
  { key: 'focus',     label: 'Focus',     subtitle: 'Instrumental flow',     gradient: ['#0d73ec', '#503750'], emoji: '🎯' },
  { key: 'workout',   label: 'Workout',   subtitle: 'Push it',               gradient: ['#477d95', '#503750'], emoji: '💪' },
  { key: 'sleep',     label: 'Sleep',     subtitle: 'Wind down',              gradient: ['#1e3264', '#1e3264'], emoji: '💤' },
  { key: 'party',     label: 'Party',     subtitle: 'Turn it up',            gradient: ['#af2896', '#503750'], emoji: '🎉' },
  { key: 'energy',    label: 'Energy',    subtitle: 'Morning hype',           gradient: ['#e8145c', '#503750'], emoji: '⚡' },
  { key: 'sad',       label: 'Sad',       subtitle: 'Feel the feels',        gradient: ['#503750', '#503750'], emoji: '😢' },
  { key: 'happy',     label: 'Happy',     subtitle: 'Good vibes',             gradient: ['#1ed760', '#503750'], emoji: '😊' },
  { key: 'romance',   label: 'Romance',   subtitle: 'Love songs',             gradient: ['#dc148c', '#503750'], emoji: '❤️' },
  { key: 'throwback', label: 'Throwback', subtitle: 'Classics & gems',        gradient: ['#ba5d07', '#503750'], emoji: '📼' },
]

const TIME_BLOCKS = [
  { start: 4, end: 9, name: 'Rise & Shine' },
  { start: 9, end: 12, name: 'Focus Flow' },
  { start: 12, end: 15, name: 'Lunch Break' },
  { start: 15, end: 18, name: 'Energy Boost' },
  { start: 18, end: 22, name: 'Unwind' },
  { start: 22, end: 28, name: 'Wind Down' },
]

function getCurrentBlockLabel(): string {
  const h = new Date().getHours()
  const block = TIME_BLOCKS.find((b) => {
    if (b.end > 24) return h >= b.start || h < (b.end - 24)
    return h >= b.start && h < b.end
  })
  return block?.name || 'Wind Down'
}

export async function GET() {
  const profile = await readProfile()

  if (!profile.complete || profile.artists.length === 0) {
    return NextResponse.json({
      cards: [],
      moods: MOODS,
      needsOnboarding: true,
    })
  }

  const hour = new Date().getHours()
  const hourStr = hour === 0 ? '12 AM' : hour > 12 ? `${hour - 12} PM` : `${hour} AM`
  const blockLabel = getCurrentBlockLabel()

  const cards: FeaturedCard[] = [
    {
      id: 'dw',
      kind: 'playlist',
      title: 'Discover Weekly',
      subtitle: 'Your weekly mixtape. Refreshes every Monday.',
      gradient: ['#5a4fcf', '#1e3264'],
      emoji: '✨',
      icon: 'Compass',
      endpoint: '/api/ai/discover-weekly',
      view: 'ai-generated',
    },
    {
      id: 'rr',
      kind: 'playlist',
      title: 'Release Radar',
      subtitle: `New from ${profile.artists.slice(0, 5).map((a) => a.name).join(', ')}`,
      gradient: ['#e8145c', '#503750'],
      emoji: '🛰️',
      icon: 'Satellite',
      endpoint: '/api/ai/release-radar',
      view: 'ai-generated',
    },
    {
      id: 'daylist',
      kind: 'playlist',
      title: blockLabel,
      subtitle: `Your ${hourStr} mix · ${profile.name || 'you'}`,
      gradient: ['#ba5d07', '#477d95'],
      emoji: '⏰',
      icon: 'AlarmClock',
      endpoint: '/api/ai/daylist',
      view: 'ai-generated',
    },
    {
      id: 'on-repeat',
      kind: 'playlist',
      title: 'On Repeat',
      subtitle: 'The songs you can\'t stop playing',
      gradient: ['#1ed760', '#0d73ec'],
      emoji: '🔁',
      icon: 'Repeat2',
      endpoint: '/api/ai/on-repeat',
      view: 'ai-generated',
    },
  ]

  // Assign REAL track-art covers from each hub's cached payload, but only
  // when distinct (4x the same photo looked worse than gradients). Hubs that
  // haven't been built yet keep their signature gradient+icon cover.
  const sig = profile.artists.map((a) => a.id).join(',')
  const now = new Date()
  const dayOfWeek = (now.getDay() + 6) % 7
  const monday = new Date(now)
  monday.setDate(now.getDate() - dayOfWeek); monday.setHours(0, 0, 0, 0)
  const weekBucket = monday.toISOString().slice(0, 10)
  const hourBucket6 = Math.floor(now.getHours() / 6) // daylist's bucketing
  const dateStr = now.toISOString().slice(0, 10)
  // release-radar buckets by FRIDAY (its refresh day); on-repeat by monday week
  const friday = new Date(now)
  friday.setDate(now.getDate() - ((now.getDay() + 2) % 7)); friday.setHours(0, 0, 0, 0)
  const fridayBucket = friday.toISOString().slice(0, 10)
  const cacheKeys: Record<string, string> = {
    dw: `ai:discover-weekly:${sig}|${profile.genres.join(',')}:${weekBucket}`,
    rr: `ai:release-radar:${sig}:${fridayBucket}`,
    daylist: `ai:daylist:${dateStr}:${hourBucket6}:${sig}`,
    'on-repeat': `ai:on-repeat:${weekBucket}`,
  }
  try {
    const rows = await db.apiCache.findMany({ where: { key: { in: Object.values(cacheKeys) } } })
    const map: Record<string, any> = {}
    for (const row of rows) {
      try { map[row.key] = JSON.parse(row.payload) } catch {}
    }
    const seen = new Set<string>()
    const pickDistinct = (payload: any): string | null => {
      const candidates = [payload?.cover, ...(payload?.tracks || []).slice(0, 14).map((t: any) => t?.thumbnail)]
      for (const c of candidates) {
        if (c && !seen.has(c)) return c
      }
      return null
    }
    for (const [cardId, key] of Object.entries(cacheKeys)) {
      const cover = pickDistinct(map[key])
      if (cover) {
        seen.add(cover)
        const card = cards.find((c) => c.id === cardId)
        if (card) card.cover = cover
      }
    }
  } catch { /* non-fatal */ }

  return NextResponse.json({
    cards,
    moods: MOODS,
  })
}
