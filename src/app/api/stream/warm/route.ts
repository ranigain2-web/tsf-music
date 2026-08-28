import { NextRequest, NextResponse } from 'next/server'
import { warmStreams } from '@/lib/ytm/stream'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * POST /api/stream/warm
 *
 * Deep Warm: client tells us which upcoming tracks it will play; the server
 * re-runs the full provider race for cache rows that are previews/synths so
 * they upgrade to full-length (bgutil POT + yt-dlp hero path) while the user
 * listens. Body: { ids: string[], meta?: Record<id, {title?, artist?, durationSec?}> }
 *
 * Guarded server-side: dedup + in-flight set + one batch per 20s window.
 */
export async function POST(req: NextRequest) {
  let body: { ids?: unknown; meta?: Record<string, { title?: string; artist?: string; durationSec?: number }> }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : []
  if (!ids.length) return NextResponse.json({ error: 'ids required' }, { status: 400 })
  if (ids.length > 16) return NextResponse.json({ error: 'too many ids (max 16)' }, { status: 400 })

  try {
    const result = await warmStreams(ids, body.meta || {})
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: 'warm failed', detail: String(e) }, { status: 500 })
  }
}
