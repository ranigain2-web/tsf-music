import { NextRequest } from 'next/server'
import { getFeatures, calibrate } from '@/lib/mindbeat/features'

export const dynamic = 'force-dynamic'

/**
 * MINDBEAT Proxy Feature Space.
 *
 * GET ?ids=a,b,c → { features: { [id]: { energy, valence, tempoClass,
 *   acoustic, eraBucket, language, moodTags[], confidence, effEnergy,
 *   effValence } } }
 *   Cache misses get metadata heuristics applied synchronously (confidence
 *   LOW, persisted); LLM cultural-prior enrichment is fired in the
 *   background and NEVER awaited here.
 *
 * POST { trackId, completed, energyAt } → behavioral calibration of the
 *   track's effEnergy toward/away from the observed energy context.
 */

const MAX_IDS = 80

export async function GET(req: NextRequest) {
  const idsParam = new URL(req.url).searchParams.get('ids') ?? ''
  const ids = idsParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_IDS)
  if (!ids.length) return Response.json({ features: {} })

  try {
    const map = await getFeatures(ids)
    const features: Record<string, unknown> = {}
    for (const [id, row] of map) {
      let moodTags: string[] = []
      try {
        moodTags = row.moodTags ? (JSON.parse(row.moodTags) as string[]) : []
      } catch {
        moodTags = []
      }
      features[id] = {
        energy: row.energy,
        valence: row.valence,
        tempoClass: row.tempoClass,
        acoustic: row.acoustic,
        eraBucket: row.eraBucket,
        language: row.language,
        moodTags,
        confidence: row.confidence,
        effEnergy: row.effEnergy,
        effValence: row.effValence,
      }
    }
    return Response.json({ features })
  } catch (e) {
    return Response.json({ error: 'features unavailable', detail: String(e).slice(0, 200) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { trackId?: string; completed?: boolean; energyAt?: number }
    | null
  if (!body?.trackId) return Response.json({ error: 'missing trackId' }, { status: 400 })
  try {
    await calibrate(body.trackId, {
      completed: body.completed === true,
      energyAt: Number.isFinite(body.energyAt) ? Number(body.energyAt) : 0.5,
    })
    return Response.json({ ok: true })
  } catch (e) {
    return Response.json({ error: 'calibration failed', detail: String(e).slice(0, 200) }, { status: 500 })
  }
}
