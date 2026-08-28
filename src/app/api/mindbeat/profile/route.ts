import { NextRequest } from 'next/server'
import { compileProfile, applyCorrection, compactSummary, type CorrectionAction } from '@/lib/mindbeat/profile'

export const dynamic = 'force-dynamic'

/**
 * MINDBEAT L2 taste profile.
 *
 * GET  ?full=1 → the full compiled profile JSON (Taste DNA / export data).
 * GET  default → compact summary (top artists/genres/languages/moods,
 *                current-daypart snapshot, session count, epsilon, corrections).
 * POST { action: 'rebuild'|'mute'|'boost'|'wrong'|'reset', target?, kind? }
 *              → applies the correction (or forces a rebuild), returns the
 *                fresh compact summary.
 */

const ACTIONS: CorrectionAction[] = ['mute', 'boost', 'wrong', 'reset']

export async function GET(req: NextRequest) {
  const full = new URL(req.url).searchParams.get('full')
  try {
    const profile = await compileProfile(false)
    if (full) return Response.json(profile)
    return Response.json(compactSummary(profile))
  } catch (e) {
    return Response.json({ error: 'profile unavailable', detail: String(e).slice(0, 200) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { action?: string; target?: string; kind?: 'artist' | 'track' }
    | null
  const action = body?.action
  if (action === 'rebuild') {
    const profile = await compileProfile(true)
    return Response.json({ ok: true, profile: compactSummary(profile) })
  }
  if (action && (ACTIONS as string[]).includes(action)) {
    if (action !== 'reset' && !body?.target) {
      return Response.json({ error: 'missing target' }, { status: 400 })
    }
    const corrections = await applyCorrection(
      action as CorrectionAction,
      body?.target,
      body?.kind === 'track' ? 'track' : body?.kind === 'artist' ? 'artist' : undefined
    )
    const profile = await compileProfile(true)
    return Response.json({ ok: true, corrections, profile: compactSummary(profile) })
  }
  return Response.json({ error: 'unknown action' }, { status: 400 })
}
