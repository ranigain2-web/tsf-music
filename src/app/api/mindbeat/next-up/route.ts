import { NextRequest } from 'next/server'
import { EPSILON, currentDaypart, type SourceSurface } from '@/lib/mindbeat/types'
import { compileProfile } from '@/lib/mindbeat/profile'
import { getSessionContext } from '@/lib/mindbeat/ledger'
import { getFeatures } from '@/lib/mindbeat/features'
import { decide, computeVibe, getEngineReads, type CandidatePool } from '@/lib/mindbeat/decision'
import { buildPools, withCulturalTag, primaryPool, featuresOf, type SeedInput } from '@/lib/mindbeat/pools'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * MINDBEAT L4 → surfaces: POST /api/mindbeat/next-up
 *
 * body: {
 *   seeds:   { videoId, artistName?, artistId?, title? }[]   (≤5)
 *   count:   number                                         (1–30, default 10)
 *   surface: 'smart_shuffle_rec' | 'radio' | 'daily_mix'
 *   exclude: string[]                                       (videoIds)
 *   session?: { recent: { videoId, artistName?, energy? }[],
 *               completionRate?, skipStormCount? }          (client payload)
 *   flags?:  { recsOff?: boolean, noExplore?: boolean, noReasons?: boolean }
 *            (device kill switches from surfaceFlags() — the device owns
 *             them; the server never reads localStorage. recsOff answers
 *             immediately with an empty pick set; noExplore zeroes ε.)
 * }
 *
 * → { picks: EnginePick[], vibe: VibeState, epsilon: number }
 *
 * Pipeline: compileProfile + getSessionContext → candidate pools (DB-first,
 * ≥3× count) → TrackFeature getFeatures on ≤80 ids (heuristics instant, LLM
 * enrichment fires in background) → decide(). The engine reads memory; it
 * never writes it.
 */

const VALID_SURFACES: readonly string[] = ['smart_shuffle_rec', 'radio', 'daily_mix']
const MAX_SEEDS = 5
const MAX_COUNT = 30
const FEATURE_CAP = 80

interface NextUpBody {
  seeds?: SeedInput[]
  count?: number
  surface?: string
  exclude?: string[]
  flags?: {
    recsOff?: boolean
    noExplore?: boolean
    noReasons?: boolean
  }
  session?: {
    recent?: { videoId?: string; artistName?: string; energy?: number }[]
    completionRate?: number
    skipStormCount?: number
  }
}

/** Manual parse with defaults — an absent/garbled flags object means all-off. */
function parseFlags(raw: NextUpBody['flags']): {
  recsOff: boolean
  noExplore: boolean
  noReasons: boolean
} {
  return {
    recsOff: raw?.recsOff === true,
    noExplore: raw?.noExplore === true,
    noReasons: raw?.noReasons === true,
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as NextUpBody | null
  if (!body || !Array.isArray(body.seeds)) {
    return Response.json({ error: 'missing seeds' }, { status: 400 })
  }

  const seeds = body.seeds
    .filter((s) => s && typeof s.videoId === 'string' && s.videoId.length > 0)
    .slice(0, MAX_SEEDS)
  const count = Math.max(1, Math.min(MAX_COUNT, Math.floor(body.count ?? 10)))
  const surface: SourceSurface = (VALID_SURFACES as readonly string[]).includes(body.surface ?? '')
    ? (body.surface as SourceSurface)
    : 'smart_shuffle_rec'
  const excludeBody = Array.isArray(body.exclude) ? body.exclude.filter((v) => typeof v === 'string') : []
  const flags = parseFlags(body.flags)

  // KILL SWITCH (plan §10.4): 'tsf-mindbeat-off' → recommendations are OFF.
  // Zero picks, no pools, no engine call — classic shuffle is the only source.
  if (flags.recsOff) {
    return Response.json({ picks: [], vibe: 'OFF', epsilon: 0 })
  }

  try {
    const [profile, sessionCtx] = await Promise.all([compileProfile(), getSessionContext()])
    const block = currentDaypart()

    // client session payload (client-side energies are optional hints)
    const clientEnergies = (body.session?.recent ?? [])
      .map((r) => (typeof r?.energy === 'number' ? r.energy : NaN))
      .filter((e) => Number.isFinite(e))
    const sessionEnergy =
      clientEnergies.length > 0
        ? clientEnergies.reduce((a, b) => a + b, 0) / clientEnergies.length
        : undefined
    // trust the client's storm counter when it is louder than the ledger's
    const clientStorm = typeof body.session?.skipStormCount === 'number' ? body.session.skipStormCount : 0
    const mergedSession = {
      ...sessionCtx,
      vibeInputs: {
        ...sessionCtx.vibeInputs,
        skipStormCount: Math.max(sessionCtx.vibeInputs.skipStormCount, clientStorm),
      },
    }

    // ---- candidate pools (DB-first, ≥3× count) ----------------------------
    const exclude = new Set<string>([
      ...excludeBody,
      ...seeds.map((s) => s.videoId),
      ...sessionCtx.sessionListens.map((l) => l.trackId),
      ...profile.corrections.mutedTracks,
    ])
    const pooled = await buildPools({
      seeds,
      profile,
      block,
      exclude,
      minPool: Math.max(12, count * 3),
    })

    // ---- features on ≤80 candidate ids (heuristics instant; LLM in bg) ----
    const featureIds = pooled.slice(0, FEATURE_CAP).map((c) => c.videoId)
    const feats = featureIds.length ? await getFeatures(featureIds) : new Map()
    withCulturalTag(pooled, feats, profile)

    const pools: CandidatePool[] = pooled.slice(0, FEATURE_CAP).map((c) => {
      const f = featuresOf(feats.get(c.videoId))
      return {
        videoId: c.videoId,
        title: c.title,
        artistName: c.artistName,
        ...(c.artistId ? { artistId: c.artistId } : {}),
        ...(c.duration !== undefined ? { duration: c.duration } : {}),
        ...(c.thumbnail ? { thumbnail: c.thumbnail } : {}),
        pool: primaryPool(c.pools),
        ...(f ? { features: f } : {}),
      }
    })

    // cheap StreamCache knowledge: preview-only −0.8, synth providers hard-blocked
    const previewOnly: string[] = []
    const unplayable: string[] = []
    if (featureIds.length) {
      const rows = await db.streamCache
        .findMany({
          where: { videoId: { in: featureIds } },
          select: { videoId: true, provider: true },
        })
        .catch(() => [])
      for (const r of rows) {
        const p = String(r.provider || '')
        if (p.includes('synth') || p.includes('demo')) unplayable.push(r.videoId)
        else if (p.includes('preview') || p.includes('itunes')) previewOnly.push(r.videoId)
      }
    }

    const reads = await getEngineReads()
    const picks = decide({
      pool: pools,
      session: mergedSession,
      profile,
      block,
      count,
      opts: {
        surface,
        seed: sessionCtx.sessionId ?? undefined,
        previewOnly,
        unplayable,
        reads,
        sessionEnergy,
        energies: clientEnergies,
        neighborAnchors: seeds.map((s) => ({ videoId: s.videoId, ...(s.title ? { title: s.title } : {}) })),
        exploreOff: flags.noExplore,
      },
    })

    const vibe = computeVibe(mergedSession, { energies: clientEnergies, surface })
    // report the EFFECTIVE budget: noExplore zeroes ε exactly as decide() saw it
    const epsilon = flags.noExplore
      ? 0
      : vibe === 'SKIP_STORM'
        ? EPSILON.storm
        : profile.exploration.epsilon

    return Response.json({ picks, vibe, epsilon })
  } catch (e) {
    return Response.json(
      { error: 'next-up failed', detail: String(e).slice(0, 200), picks: [], vibe: 'WARMUP', epsilon: EPSILON.established },
      { status: 500 }
    )
  }
}

export async function GET() {
  return Response.json({ ok: true })
}
