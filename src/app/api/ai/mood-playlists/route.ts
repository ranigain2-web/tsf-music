import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { search as ytmSearch } from '@/lib/ytm'
import { readProfile } from '../../onboarding/route'
import { filterSafeTracks } from '@/lib/safety'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/ai/mood-playlists?mood=chill
 *
 * Spotify "Mood" hub equivalent. Pre-defined mood stations with hand-tuned
 * search queries; results are merged with the user's preference signature so
 * every mood still reflects their taste.
 *
 * Moods:
 *   - chill       — relax, low energy
 *   - focus       — instrumental, no vocals
 *   - workout     — high energy, fast BPM
 *   - sleep       — ambient, calm
 *   - party       — dancefloor bangers
 *   - energy      — morning hype
 *   - sad         — melancholic
 *   - happy       — uplifting
 *   - romance     — love songs
 *   - throwback   — classics
 *
 * Returns all moods in one shot if no ?mood= specified.
 */

const MOODS: Record<string, { label: string; subtitle: string; query: string; gradient: [string, string]; emoji: string }> = {
  chill:     { label: 'Chill',     subtitle: 'Kick back & relax',  query: 'chill vibes mellow',         gradient: ['#1e3264', '#503750'], emoji: '🌙' },
  focus:     { label: 'Focus',     subtitle: 'Instrumental flow',   query: 'focus instrumental deep',   gradient: ['#0d73ec', '#503750'], emoji: '🎯' },
  workout:   { label: 'Workout',   subtitle: 'Push it',             query: 'workout pump high energy',   gradient: ['#477d95', '#503750'], emoji: '💪' },
  sleep:     { label: 'Sleep',     subtitle: 'Wind down',           query: 'sleep ambient calm night',   gradient: ['#1e3264', '#1e3264'], emoji: '💤' },
  party:     { label: 'Party',     subtitle: 'Turn it up',         query: 'party dance hits',           gradient: ['#af2896', '#503750'], emoji: '🎉' },
  energy:    { label: 'Energy',    subtitle: 'Morning hype',        query: 'energy boost upbeat morning',gradient: ['#e8145c', '#503750'], emoji: '⚡' },
  sad:       { label: 'Sad',       subtitle: 'Feel the feels',     query: 'sad melancholic emotional',   gradient: ['#503750', '#503750'], emoji: '😢' },
  happy:     { label: 'Happy',     subtitle: 'Good vibes',         query: 'happy uplifting feel good',   gradient: ['#1ed760', '#503750'], emoji: '😊' },
  romance:   { label: 'Romance',  subtitle: 'Love songs',          query: 'love songs romance',         gradient: ['#dc148c', '#503750'], emoji: '❤️' },
  throwback: { label: 'Throwback', subtitle: 'Classics & gems',    query: 'throwback classic hits 90s 00s', gradient: ['#ba5d07', '#503750'], emoji: '📼' },
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

async function buildMood(moodKey: string): Promise<{
  id: string
  title: string
  subtitle: string
  gradient: [string, string]
  emoji: string
  tracks: any[]
}> {
  const def = MOODS[moodKey] || MOODS.chill
  const profile = await readProfile()

  // Mix mood query + first favorite genre (if any) for personalization
  const genreBoost = profile.genres[0] ? ` ${profile.genres[0]}` : ''
  const sq = `${def.query}${genreBoost}`

  try {
    const r = await ytmSearch(sq, 'songs')
    const tracks = filterSafeTracks((r.tracks || []).slice(0, 25)).map(trackToPlayer).filter(Boolean)
    return {
      id: `mood-${moodKey}`,
      title: def.label,
      subtitle: def.subtitle,
      gradient: def.gradient,
      emoji: def.emoji,
      tracks,
    }
  } catch {
    return {
      id: `mood-${moodKey}`,
      title: def.label,
      subtitle: def.subtitle,
      gradient: def.gradient,
      emoji: def.emoji,
      tracks: [],
    }
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const moodParam = url.searchParams.get('mood')

  if (moodParam) {
    if (!MOODS[moodParam]) {
      return NextResponse.json({ error: 'unknown mood' }, { status: 400 })
    }
    const m = await buildMood(moodParam)
    return NextResponse.json(m)
  }

  // No mood → return all mood hubs (lightweight: just metadata, no tracks)
  const all = Object.entries(MOODS).map(([key, def]) => ({
    id: `mood-${key}`,
    key,
    title: def.label,
    subtitle: def.subtitle,
    gradient: def.gradient,
    emoji: def.emoji,
  }))

  return NextResponse.json({ moods: all })
}
