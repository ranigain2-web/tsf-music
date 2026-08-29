import { NextRequest, NextResponse } from 'next/server'
import { buildNowSound } from '@/lib/mindbeat/daylist'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/ai/daylist[?forceBlock=<block>&forceDayKind=<weekday|weekend>]
 * POST /api/ai/daylist  (same params accepted via query)
 *
 * DAYLIST v2 — "Now Sound" (MINDBEAT plan §9.4).
 *
 * The Heggli five-block × weekday/weekend taste matrix surfaced as a living
 * playlist: built from the block's profile matrix cell + the Decision
 * Engine, 22–28 tracks, mostly trusted artists in the block's energy band,
 * 2–3 FRESH_FINDs, a generated name in the verified daylist pattern and a
 * "Shifts around 5 pm" next-block hint. Re-entries within the same block
 * are served from an in-memory cache (TTL ~20 min, keyed by block/dayKind/
 * profile fingerprint); a profile recompile forces a re-rank.
 *
 * Cold profiles (no daypart data) fall back to the v2.1 keyword-search
 * builder, tagged mode:'cold' — never dumber than v2.1.
 *
 * forceBlock / forceDayKind are a B5 shadow-testing hook: they let tests
 * pin any of morning/afternoon/evening/night/lateNight × weekday/weekend.
 *
 * Response shape (superset of the v2.1 contract — AiGeneratedView + Home
 * keep working): { id, name, title, subtitle, block, dayKind, nextShift,
 * mode, cover?, tracks: PlayerTrack[], savedAt }
 */
export async function GET(req: NextRequest) {
  try {
    const payload = await buildNowSound({
      forceBlock: req.nextUrl.searchParams.get('forceBlock'),
      forceDayKind: req.nextUrl.searchParams.get('forceDayKind'),
    })
    return NextResponse.json(payload)
  } catch (e) {
    return NextResponse.json(
      {
        id: 'daylist',
        title: 'Daylist',
        subtitle: 'Could not build the daylist right now.',
        tracks: [],
        savedAt: new Date().toISOString(),
        error: String(e).slice(0, 200),
      },
      { status: 200 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const payload = await buildNowSound({
      forceBlock: req.nextUrl.searchParams.get('forceBlock'),
      forceDayKind: req.nextUrl.searchParams.get('forceDayKind'),
    })
    return NextResponse.json(payload)
  } catch (e) {
    return NextResponse.json(
      {
        id: 'daylist',
        title: 'Daylist',
        subtitle: 'Could not build the daylist right now.',
        tracks: [],
        savedAt: new Date().toISOString(),
        error: String(e).slice(0, 200),
      },
      { status: 200 }
    )
  }
}
