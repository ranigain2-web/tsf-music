import { NextRequest, NextResponse } from 'next/server'
import { buildOnTheRise } from '@/lib/mindbeat/on-the-rise'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/ai/on-the-rise → { ok: true } ping.
 *
 * POST /api/ai/on-the-rise  body: { count?: number }
 *
 * "ON THE RISE" (MINDBEAT plan §9.6) — the Discover Weekly analog, built
 * ONLY from the user's own evidence: a rolling-7-day playlist anchored by
 * the seed of the week (the best-performing FRESH_FIND of the past week —
 * highest completion of anything newly introduced), then ~70%
 * adjacent-to-taste + ~30% far exploration, ≥60% never-before-played.
 * Every track carries a discovery chain derived from real pool/seed/
 * language evidence.
 *
 * Response: {
 *   id: 'on-the-rise',
 *   name: "On the Rise — week of Aug 25",
 *   tracks: [{ ...PlayerTrack, chain }],
 *   seed: { videoId, title, artistName },
 *   mode: 'live' | 'cold',
 *   builtAt: ISO,
 *   stats: { adjacent, far, neverPlayed, total },
 * }
 */
export async function GET() {
  return NextResponse.json({ ok: true })
}

export async function POST(req: NextRequest) {
  let body: { count?: number } | null = null
  try {
    body = (await req.json().catch(() => null)) as { count?: number } | null
  } catch { /* empty body is fine */ }
  try {
    const payload = await buildOnTheRise({ count: body?.count })
    return NextResponse.json(payload)
  } catch (e) {
    return NextResponse.json(
      { error: 'on-the-rise failed', detail: String(e).slice(0, 200) },
      { status: 500 }
    )
  }
}
