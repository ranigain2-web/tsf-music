/**
 * TSF Music — /api/ai/feed (F2 · endless home feed tail)
 *
 * Spotify-style "scroll forever" tail of Home. The pager itself is a pure
 * module (src/lib/ai/endless-feed.ts — ported from the reference repo's
 * v3.4.1 with its honest-exhaustion/retry contract intact); this route
 * owns SESSIONS so the client stays cursor-dumb:
 *
 *   POST { sessionKey?, seed?: { songIds, albumIds }, fresh? }
 *   → { batch | null, sessionKey, exhausted }
 *
 *   • batch = { kind:'songs'|'albums', title, rows } → append + render
 *   • batch = { kind:'retry' } → transient failure; the NEXT call resumes
 *   • batch = null → exhausted FOREVER → the honest end marker, never call again
 *   • seed ids = what's already on screen (shelves) — the feed never repeats them
 *
 * Sessions live in a globalThis map (Turbopack-safe singleton), 30-minute
 * sliding TTL, LRU-capped — dev server restarts simply re-seed.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createEndlessPager, type EndlessFeedPager } from '@/lib/ai/endless-feed'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SESSION_TTL_MS = 30 * 60 * 1000
const SESSION_MAX = 200

interface FeedSession {
  pager: EndlessFeedPager
  at: number
}

function sessionMap(): Map<string, FeedSession> {
  const g = globalThis as unknown as { __tsfFeedSessions?: Map<string, FeedSession> }
  g.__tsfFeedSessions ??= new Map()
  return g.__tsfFeedSessions
}

function gcSessions(): void {
  const map = sessionMap()
  const now = Date.now()
  for (const [k, s] of map) if (now - s.at > SESSION_TTL_MS) map.delete(k)
  while (map.size > SESSION_MAX) {
    const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (!oldest) break
    map.delete(oldest[0])
  }
}

export async function POST(req: NextRequest) {
  let body: {
    sessionKey?: string
    fresh?: boolean
    seed?: { songIds?: string[]; albumIds?: string[] }
  }
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  gcSessions()
  const map = sessionMap()

  let sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey : ''
  let pager: EndlessFeedPager | undefined = sessionKey ? map.get(sessionKey)?.pager : undefined

  // A retry batch means the last call errored transiently — the pager stays
  // alive, but the UI may also ask for a FRESH session (source flip etc.).
  if (!pager || body.fresh) {
    pager = createEndlessPager()
    sessionKey = sessionKey || `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    map.set(sessionKey, { pager, at: Date.now() })
    pager.prime({
      songs: (body.seed?.songIds ?? []).map((videoId) => ({ videoId })),
      albums: (body.seed?.albumIds ?? []).map((id) => ({ id })),
    })
  } else {
    map.get(sessionKey)!.at = Date.now()
  }

  try {
    const batch = await pager.next()
    return NextResponse.json({
      batch,
      sessionKey,
      exhausted: pager.isExhausted,
    })
  } catch {
    return NextResponse.json({ batch: { kind: 'retry' }, sessionKey, exhausted: false })
  }
}
