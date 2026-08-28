/**
 * TSF Music — /api/sponsorblock
 *
 * Returns the community-curated non-music segments for a track so the
 * player can hop straight over intros/outros/sponsor plugs ("ad-free"
 * experience, Musify-style). The heavy lifting (caching, merge logic)
 * lives in @/lib/ytm/sponsorblock.
 *
 *   GET /api/sponsorblock?id=<videoId>&dur=<trackDurationSec>
 *   → { videoId, segments: [{ start, end, category }], enabled: true }
 *
 * Never errors the player: any failure returns an empty segment list.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSkipSegments, buildSkipPlan } from '@/lib/ytm/sponsorblock'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const videoId = searchParams.get('id') || ''
  const dur = parseFloat(searchParams.get('dur') || '0') || 0
  if (!videoId) {
    return NextResponse.json({ error: 'missing id' }, { status: 400 })
  }

  try {
    const raw = await getSkipSegments(videoId)
    const segments = buildSkipPlan(raw, dur)
    return NextResponse.json(
      { videoId, segments, enabled: true },
      { headers: { 'Cache-Control': 'public, max-age=3600' } },
    )
  } catch {
    // Never break playback over segment lookup failures.
    return NextResponse.json({ videoId, segments: [], enabled: true })
  }
}
