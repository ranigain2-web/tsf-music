import { NextRequest } from 'next/server'
import { search as ytmSearch } from '@/lib/ytm'
import { parseIntent, killByNegations, type Intent } from '@/lib/ai/intent'
import { filterSafeTracks, isShelfTitleSafe } from '@/lib/safety'

export const dynamic = 'force-dynamic'

/**
 * POST /api/ai/vibe-search — S1 UNDERSTAND + S2 HUNT for the search box.
 *
 * body: { query: string }
 *
 * The free-text query goes through the SAME intent brain as the playlist
 * generator (parseIntent: LLM ≤1.5s over a heuristic base, Hinglish-robust,
 * negations first-class), then a small deterministic parallel hunt via the
 * same ytm search helpers. Negated families are applied to the results.
 *
 * Response: {
 *   tracks: YtmTrack[],
 *   vibePlaylistShortcut: { prompt: query },   // one tap → AI generator
 *   artistsLike: [{ id?, name }],              // from intent.artists
 *   intentConfidence, offline
 * }
 *
 * Timeout-safe: every search is raced against a deadline and the whole route
 * degrades gracefully (fallback plain search → empty-but-valid JSON).
 */

const SEARCH_TIMEOUT_MS = 4_000
const MAX_TRACKS = 30
const MAX_QUERY_BUDGET_MS = 8_000

type HuntTrack = {
  videoId: string
  title: string
  artistName: string
  artistId?: string
  albumName?: string
  duration: number
  thumbnail: string
  year?: number
}

async function searchRaced(query: string): Promise<HuntTrack[]> {
  try {
    const raced = await Promise.race([
      ytmSearch(query, 'songs'),
      new Promise<null>((res) => setTimeout(() => res(null), SEARCH_TIMEOUT_MS)),
    ])
    const tracks = (raced as { tracks?: unknown[] } | null)?.tracks ?? []
    return tracks
      .filter((t): t is NonNullable<typeof t> => !!t && typeof (t as { videoId?: unknown }).videoId === 'string')
      .slice(0, 15)
      .map((t) => {
        const tr = t as { videoId: string; title?: string; artistName?: string; artistId?: string; albumName?: string; duration?: number; thumbnail?: string; year?: number }
        return {
          videoId: tr.videoId,
          title: tr.title ?? '',
          artistName: tr.artistName ?? '',
          artistId: tr.artistId,
          albumName: tr.albumName,
          duration: tr.duration ?? 0,
          thumbnail: tr.thumbnail ?? '',
          year: tr.year,
        }
      })
  } catch {
    return []
  }
}

function buildVibeQueries(intent: Intent, query: string): string[] {
  const qs: string[] = []
  const push = (q: string) => {
    const t = q.replace(/\s+/g, ' ').trim()
    if (t.length >= 3 && !qs.some((x) => x.toLowerCase() === t.toLowerCase())) qs.push(t)
  }
  const lang = intent.languages[0] ?? ''
  const genre = intent.genres[0] ?? ''
  const mood0 = intent.moods[0] ?? ''
  const era = intent.eras[0] ?? ''

  // named artists ("songs like kun faya kun" → kkk search + artist cell)
  for (const a of intent.artists.slice(0, 3)) push(`${a} ${genre || lang || mood0 || ''} songs`)
  // candidateNameHints — searched, never trusted
  for (const h of intent.candidateNameHints.slice(0, 2)) push(h)
  // mood × genre × language cell
  push([mood0, genre, lang, 'songs'].filter(Boolean).join(' '))
  // era cell
  if (era) push([era, lang || genre || mood0, 'hits'].filter(Boolean).join(' '))
  // activity cell
  if (intent.activities[0]) push([intent.activities[0], lang || genre || mood0, 'songs'].filter(Boolean).join(' '))
  // raw query last (broadest)
  push(query)
  return qs.slice(0, 6)
}

function dedupe(tracks: HuntTrack[]): HuntTrack[] {
  const byId = new Set<string>()
  const byPair = new Set<string>()
  const out: HuntTrack[] = []
  for (const t of tracks) {
    if (!t.videoId || byId.has(t.videoId)) continue
    const pair = `${t.title.toLowerCase().replace(/[^a-z0-9]/g, '')}|${t.artistName.toLowerCase().replace(/[^a-z0-9]/g, '')}`
    if (byPair.has(pair)) continue
    byId.add(t.videoId)
    byPair.add(pair)
    out.push(t)
  }
  return out
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const query: string = (body.query || '').trim()

  if (!query) {
    return Response.json({ error: 'Missing query' }, { status: 400 })
  }
  if (!isShelfTitleSafe(query)) {
    return Response.json({ error: 'Query blocked by content safety filter' }, { status: 400 })
  }

  const startedAt = Date.now()
  try {
    // S1 — the shared brain (hard ≤1.5s LLM budget, heuristic fallback)
    const intent = await parseIntent(query)
    // S2 — small deterministic parallel hunt through the same ytm layer
    const queries = buildVibeQueries(intent, query)
    let tracks: HuntTrack[] = []
    if (queries.length) {
      const settled = await Promise.allSettled(queries.map((q) => searchRaced(q)))
      const merged: HuntTrack[] = []
      for (const s of settled) {
        if (s.status === 'fulfilled') merged.push(...s.value)
      }
      tracks = dedupe(merged)
    }
    // safety → negations (first-class)
    tracks = killByNegations(filterSafeTracks(tracks), intent.negations).slice(0, MAX_TRACKS)

    // graceful degradation: nothing came back → plain search of the raw query
    if (!tracks.length && Date.now() - startedAt < MAX_QUERY_BUDGET_MS) {
      tracks = dedupe(await searchRaced(query))
      tracks = killByNegations(filterSafeTracks(tracks), intent.negations).slice(0, MAX_TRACKS)
    }

    // artistsLike — from the intent's named artists, id best-effort from results
    const artistsLike: { id?: string; name: string }[] = []
    for (const name of intent.artists.slice(0, 4)) {
      const hit = tracks.find((t) => t.artistName.toLowerCase().includes(name.toLowerCase()))
      artistsLike.push(hit?.artistId ? { id: hit.artistId, name } : { name })
    }

    return Response.json({
      tracks,
      vibePlaylistShortcut: { prompt: query },
      artistsLike,
      intentConfidence: intent.intentConfidence,
      offline: false,
      ms: Date.now() - startedAt,
    })
  } catch {
    // total failure → valid empty response (the search box must never break)
    return Response.json({
      tracks: [],
      vibePlaylistShortcut: { prompt: query },
      artistsLike: [],
      offline: true,
      ms: Date.now() - startedAt,
    })
  }
}

export async function GET() {
  return Response.json({ ok: true, hint: 'POST {query}' })
}
