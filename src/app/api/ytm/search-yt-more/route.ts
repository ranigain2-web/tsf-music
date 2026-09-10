import { NextRequest, NextResponse } from 'next/server';
import { ytSearchMusicMore } from '@/lib/search-v2/ytmusic';

export const dynamic = 'force-dynamic';

/**
 * POST /api/ytm/search-yt-more
 * YouTube deep pagination (R8-P3) — walks one continuation page.
 * Body: { continuation: string }
 * Resolves (never rejects the contract): transport failure →
 * { tracks: [], error: true } so the caller keeps the token + hasMore
 * (a network blip is not end-of-catalog). Honest end → no continuation.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { continuation?: string };
    const continuation = (body.continuation || '').trim();
    if (!continuation) {
      return NextResponse.json({ tracks: [], continuation: null, end: true });
    }
    const page = await ytSearchMusicMore(continuation, req.signal);
    if (page.error) {
      return NextResponse.json({ tracks: [], error: true });
    }
    return NextResponse.json({
      tracks: page.tracks,
      continuation: page.continuation ?? null,
      end: !page.continuation,
    });
  } catch {
    return NextResponse.json({ tracks: [], error: true });
  }
}
