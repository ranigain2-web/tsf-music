/**
 * TSF Music — /api/stream/synth
 *
 * Full-length deterministic per-track music stream. Every videoId gets its
 * own unique song (key, tempo, genre, chords, melody, drums) rendered for
 * the track's real duration. Supports Range requests (seek) and streams
 * progressively in 192KB pull-chunks so playback starts instantly and no
 * full-file render is ever needed.
 *
 * Query: ?id=<videoId>&dur=<seconds>
 */
import { NextRequest } from 'next/server'
import { buildPlan } from '@/lib/synth/arrangement'
import { synthStreamResponse } from '@/lib/synth/render'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const videoId = searchParams.get('id') || 'tsf'
  const dur = parseFloat(searchParams.get('dur') || '0') || 0
  const plan = buildPlan(videoId, dur)
  return synthStreamResponse(plan, req)
}

export async function HEAD(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const videoId = searchParams.get('id') || 'tsf'
  const dur = parseFloat(searchParams.get('dur') || '0') || 0
  const plan = buildPlan(videoId, dur)
  return synthStreamResponse(plan, req, { head: true })
}
