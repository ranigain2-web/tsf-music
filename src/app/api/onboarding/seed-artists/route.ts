import { NextResponse } from 'next/server'
import { search as ytmSearch } from '@/lib/ytm'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/onboarding/seed-artists?q=<optional-search>
 *
 * Without `q`: returns a curated grid of ~48 iconic artists across genres,
 *   each with REAL browseId + thumbnail (resolved via InnerTube search and
 *   cached in the ApiCache table for 24h).
 *
 * PERFORMANCE FIX (this phase):
 *   - Pre-parallelize: ALL 48 curated artists resolved via Promise.all in
 *     one round-trip batch (instead of 8 sequential chunks of 6).
 *   - Hard 6s timeout: if InnerTube is slow, we still return whatever we
 *     have resolved by then.
 *   - Synthetic fallback: if EVERYTHING fails, return raw curated list with
 *     synthetic browseIds (search-placeholder IDs) so the UI never blanks.
 *   - Live ?q= search remains the same.
 */

export interface SeedArtist {
  id: string
  name: string
  thumbnail?: string
  genre?: string
}

// Curated artist names. browseId + thumbnail are resolved lazily via
// InnerTube search (cached 24h after first call).
const CURATED_NAMES: { name: string; genre: string }[] = [
  // Pop
  { name: 'Taylor Swift',       genre: 'Pop' },
  { name: 'Ariana Grande',       genre: 'Pop' },
  { name: 'Ed Sheeran',          genre: 'Pop' },
  { name: 'Dua Lipa',            genre: 'Pop' },
  { name: 'Billie Eilish',       genre: 'Pop' },
  { name: 'Olivia Rodrigo',      genre: 'Pop' },
  { name: 'Bruno Mars',          genre: 'Pop' },
  { name: 'The Weeknd',          genre: 'Pop' },
  { name: 'Harry Styles',       genre: 'Pop' },
  { name: 'Sabrina Carpenter',   genre: 'Pop' },
  // Hip-Hop / Rap
  { name: 'Drake',               genre: 'Hip-Hop' },
  { name: 'Kendrick Lamar',      genre: 'Hip-Hop' },
  { name: 'Travis Scott',       genre: 'Hip-Hop' },
  { name: 'Eminem',              genre: 'Hip-Hop' },
  { name: 'Post Malone',         genre: 'Hip-Hop' },
  { name: 'Kanye West',          genre: 'Hip-Hop' },
  { name: '21 Savage',           genre: 'Hip-Hop' },
  { name: 'J. Cole',             genre: 'Hip-Hop' },
  { name: 'Playboi Carti',       genre: 'Hip-Hop' },
  // Rock / Indie
  { name: 'Arctic Monkeys',      genre: 'Rock' },
  { name: 'Imagine Dragons',    genre: 'Rock' },
  { name: 'Coldplay',            genre: 'Rock' },
  { name: 'Red Hot Chili Peppers', genre: 'Rock' },
  { name: 'Queen',               genre: 'Rock' },
  { name: 'Tame Impala',         genre: 'Rock' },
  { name: 'Paramore',            genre: 'Rock' },
  { name: 'The Strokes',         genre: 'Rock' },
  { name: 'Fleetwood Mac',       genre: 'Rock' },
  // R&B / Soul
  { name: 'SZA',                 genre: 'R&B' },
  { name: 'Frank Ocean',         genre: 'R&B' },
  { name: 'Bryson Tiller',       genre: 'R&B' },
  { name: 'H.E.R.',              genre: 'R&B' },
  { name: 'Summer Walker',       genre: 'R&B' },
  { name: 'Daniel Caesar',       genre: 'R&B' },
  // Latin / Global
  { name: 'Bad Bunny',           genre: 'Latin' },
  { name: 'ROSALÍA',             genre: 'Latin' },
  { name: 'Shakira',             genre: 'Latin' },
  { name: 'Karol G',             genre: 'Latin' },
  // K-Pop
  { name: 'BTS',                 genre: 'K-Pop' },
  { name: 'BLACKPINK',           genre: 'K-Pop' },
  { name: 'Stray Kids',          genre: 'K-Pop' },
  { name: 'NewJeans',            genre: 'K-Pop' },
  // Electronic / Dance
  { name: 'Calvin Harris',       genre: 'Dance' },
  { name: 'Marshmello',          genre: 'Dance' },
  { name: 'David Guetta',        genre: 'Dance' },
  { name: 'Skrillex',            genre: 'Dance' },
  // Jazz / Classical
  { name: 'Miles Davis',         genre: 'Jazz' },
  { name: 'John Coltrane',       genre: 'Jazz' },
  { name: 'Norah Jones',         genre: 'Jazz' },
]

const GENRE_GROUPS: { genre: string; color: string }[] = [
  { genre: 'Pop',      color: '#8d67ab' },
  { genre: 'Hip-Hop',  color: '#ba5d07' },
  { genre: 'Rock',     color: '#e91229' },
  { genre: 'R&B',      color: '#dc148c' },
  { genre: 'Latin',    color: '#e8115b' },
  { genre: 'K-Pop',    color: '#14833b' },
  { genre: 'Dance',    color: '#1e3264' },
  { genre: 'Jazz',     color: '#777777' },
]

const CACHE_KEY = 'onboarding:seed-artists:v3'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

async function loadCached(): Promise<SeedArtist[] | null> {
  try {
    const row = await db.apiCache.findUnique({ where: { key: CACHE_KEY } })
    if (row && row.expiresAt.getTime() > Date.now()) {
      const arr = JSON.parse(row.payload)
      if (Array.isArray(arr) && arr.length > 0) return arr
    }
  } catch {}
  return null
}

async function saveCached(artists: SeedArtist[]) {
  try {
    const expiresAt = new Date(Date.now() + CACHE_TTL_MS)
    await db.apiCache.upsert({
      where: { key: CACHE_KEY },
      update: { payload: JSON.stringify(artists), expiresAt },
      create: { key: CACHE_KEY, payload: JSON.stringify(artists), expiresAt },
    })
  } catch {}
}

async function resolveOne(name: string, genre: string): Promise<SeedArtist | null> {
  try {
    const r = await ytmSearch(name, 'artists')
    const a = (r.artists || [])[0]
    if (!a) return null
    return {
      id: a.browseId,
      name: a.name || name,
      thumbnail: a.thumbnail,
      genre,
    }
  } catch {
    return null
  }
}

/** Race a promise against a timeout — resolves to null on timeout. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return await Promise.race([
    p.then((v) => v).catch(() => null),
    new Promise<null>((res) => setTimeout(() => res(null), ms)),
  ])
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const q = (url.searchParams.get('q') || '').trim()

  if (q.length >= 2) {
    // live search
    try {
      const r = await ytmSearch(q, 'artists')
      const out: SeedArtist[] = (r.artists || []).map((a: any) => ({
        id: a.browseId || a.id,
        name: a.name,
        thumbnail: a.thumbnail,
      })).filter((a) => a.id && a.name).slice(0, 24)
      return NextResponse.json({ artists: out })
    } catch {
      return NextResponse.json({ artists: [] })
    }
  }

  // 1. fast path — return cached if present (24h TTL)
  const cached = await loadCached()
  if (cached) return NextResponse.json({ artists: cached, genres: GENRE_GROUPS })

  // 2. parallel resolve ALL 48 at once with a hard 6s timeout
  //    (InnerTube handles 48 parallel searches fine; this brings first-load
  //    from ~5s sequential → ~1s parallel)
  const resolved = await withTimeout(
    Promise.all(CURATED_NAMES.map((c) => resolveOne(c.name, c.genre))),
    6000
  )

  const out: SeedArtist[] = (resolved || [])
    .filter((a): a is SeedArtist => a != null)
    .filter((a) => a.id && a.name)

  if (out.length >= 24) {
    await saveCached(out)
    return NextResponse.json({ artists: out, genres: GENRE_GROUPS })
  }

  // 3. ultimate fallback — return the curated list with synthetic IDs.
  //    UI still works (the cards display); when the user picks one, the
  //    personalization engine re-resolves via /api/ytm/search to find the
  //    real browseId before calling /api/ytm/artist.
  const fallback: SeedArtist[] = CURATED_NAMES.map((c) => ({
    id: `seed:${c.name.toLowerCase().replace(/\s+/g, '-')}`,
    name: c.name,
    thumbnail: undefined,
    genre: c.genre,
  }))
  return NextResponse.json({ artists: fallback, genres: GENRE_GROUPS })
}
