import { NextRequest } from 'next/server'
import { RADIO, REASON_CODES, currentDaypart, type EnginePick } from '@/lib/mindbeat/types'
import { compileProfile } from '@/lib/mindbeat/profile'
import { getSessionContext } from '@/lib/mindbeat/ledger'
import { getFeatures } from '@/lib/mindbeat/features'
import { decide, computeVibe, getEngineReads, type CandidatePool, type PoolKind } from '@/lib/mindbeat/decision'
import { buildPools, withCulturalTag, primaryPool, featuresOf, type SeedInput } from '@/lib/mindbeat/pools'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * MINDBEAT RADIO V2 — POST /api/mindbeat/radio
 *
 * body: { seedTrack: { videoId, title?, artistName?, artistId?, duration?, thumbnail? },
 *         count?: number (default 25), exclude?: string[],
 *         flags?: { recsOff?: boolean, noExplore?: boolean, noReasons?: boolean } }
 *         (device kill switches from surfaceFlags() — recsOff answers an
 *          empty pick set so callers fall back to legacy radio; noExplore
 *          zeroes ε inside decide())
 *
 * → { picks: EnginePick[], vibe, epsilon }
 *
 * Multi-seed = the seed + its artist (affinity pool keys) + the session
 * window's recent listens. Picks come from the Decision Engine with DRIFT
 * CONTROL (constitution RADIO): every driftEvery-th slot is a drift track
 * from an ADJACENT mood band, labeled FRESH_FIND, never 2 consecutive,
 * never cross-language unless profile.languages is empty. A 7-day TRACK_START
 * dedup blocklist (cap RADIO.dedupServes ids) is hard-excluded before scoring.
 *
 * The client leads playback with the seed itself; these picks follow it.
 */

const DEFAULT_COUNT = 25
const MAX_COUNT = 50
const DRIFT_BUFFER = 8
const FEATURE_CAP = 80

interface RadioBody {
  seedTrack?: {
    videoId?: string
    title?: string
    artistName?: string
    artistId?: string
    duration?: number
    thumbnail?: string
  }
  count?: number
  exclude?: string[]
  flags?: {
    recsOff?: boolean
    noExplore?: boolean
    noReasons?: boolean
  }
}

/** Manual parse with defaults — an absent/garbled flags object means all-off. */
function parseFlags(raw: RadioBody['flags']): {
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

function bandOf(energy: number): 'calm' | 'mid' | 'energetic' {
  if (energy < 0.35) return 'calm'
  if (energy <= 0.65) return 'mid'
  return 'energetic'
}

/** adjacent band on the calm ↔ mid ↔ energetic chain (drift never jumps 2) */
function adjacentBand(band: 'calm' | 'mid' | 'energetic'): 'calm' | 'mid' | 'energetic' {
  if (band === 'calm') return 'mid'
  if (band === 'energetic') return 'mid'
  return 'calm'
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as RadioBody | null
  const seedTrack = body?.seedTrack
  if (!seedTrack || typeof seedTrack.videoId !== 'string' || !seedTrack.videoId) {
    return Response.json({ error: 'missing seedTrack.videoId' }, { status: 400 })
  }
  const count = Math.max(5, Math.min(MAX_COUNT, Math.floor(body?.count ?? DEFAULT_COUNT)))
  const excludeBody = Array.isArray(body?.exclude) ? body.exclude.filter((v) => typeof v === 'string') : []
  const flags = parseFlags(body?.flags)

  // KILL SWITCH (plan §10.4): 'tsf-mindbeat-off' → the personalized engine
  // never runs. Empty picks send callers to the legacy non-personalized radio.
  if (flags.recsOff) {
    return Response.json({ picks: [], vibe: 'OFF', epsilon: 0 })
  }

  try {
    const [profile, sessionCtx] = await Promise.all([compileProfile(), getSessionContext()])
    const block = currentDaypart()

    // multi-seed: seed + its artist + the session window (last 3 listens)
    const sessionSeeds: SeedInput[] = sessionCtx.sessionListens
      .slice(-3)
      .map((l) => ({ videoId: l.trackId, ...(l.artistName ? { artistName: l.artistName } : {}) }))
    const seeds: SeedInput[] = [
      {
        videoId: seedTrack.videoId,
        ...(seedTrack.title ? { title: seedTrack.title } : {}),
        ...(seedTrack.artistName ? { artistName: seedTrack.artistName } : {}),
        ...(seedTrack.artistId ? { artistId: seedTrack.artistId } : {}),
      },
      ...sessionSeeds.filter((s) => s.videoId !== seedTrack.videoId),
    ]

    // 7-day dedup blocklist: distinct TRACK_START trackIds, cap RADIO.dedupServes
    const since = new Date(Date.now() - RADIO.dedupTtlDays * 24 * 60 * 60 * 1000)
    const servedRows = await db.ledgerEvent
      .findMany({
        where: { type: 'TRACK_START', ts: { gte: since }, trackId: { not: null } },
        select: { trackId: true },
        distinct: ['trackId'],
        take: RADIO.dedupServes,
      })
      .catch(() => [])
    const servedBlocklist = servedRows.map((r) => r.trackId as string).filter(Boolean)

    const exclude = new Set<string>([
      ...excludeBody,
      ...servedBlocklist,
      seedTrack.videoId,
      ...profile.corrections.mutedTracks,
    ])

    const pooled = await buildPools({
      seeds,
      profile,
      block,
      exclude,
      minPool: Math.max(18, (count + DRIFT_BUFFER) * 3),
    })

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

    const reads = await getEngineReads()
    // over-ask so the drift pass can swap slots without shorting the output
    const rawPicks = decide({
      pool: pools,
      session: sessionCtx,
      profile,
      block,
      count: count + DRIFT_BUFFER,
      opts: {
        surface: 'radio',
        seed: sessionCtx.sessionId ?? seedTrack.videoId,
        reads,
        neighborAnchors: [{ videoId: seedTrack.videoId, ...(seedTrack.title ? { title: seedTrack.title } : {}) }],
        exploreOff: flags.noExplore,
      },
    })

    // ---- drift control (constitution RADIO.driftEvery) ---------------------
    const knownLanguages = new Set(Object.keys(profile.languages))
    const blockCell = profile.daypart[`${block.block}|${block.dayKind}`]
    const currentBand = bandOf(
      blockCell?.energyMean ?? (profile.proxy.energyPref.n > 0 ? profile.proxy.energyPref.mean : 0.5)
    )
    const wantBand = adjacentBand(currentBand)

    const isDriftEligible = (p: EnginePick): boolean => {
      // never cross-language unless the profile has no language evidence
      if (knownLanguages.size > 0) {
        const lang = feats.get(p.track.videoId)?.language
        if (!lang || !knownLanguages.has(lang)) return false
      }
      // adjacent mood band only (energy from the same feature rows)
      const f = feats.get(p.track.videoId)
      const energy = f?.effEnergy ?? f?.energy
      if (energy === null || energy === undefined) return false
      return bandOf(energy) === wantBand
    }

    const picks: EnginePick[] = []
    const consumed = new Set<string>()
    let lastWasDrift = false

    for (let slot = 0; picks.length < count && consumed.size < rawPicks.length; slot++) {
      // drift slots are FRESH_FIND-labeled novelty serves → disabled entirely
      // when the user killed exploration (plan §10.4: no FRESH_FIND anywhere)
      const isDriftSlot =
        !flags.noExplore && slot > 0 && (slot + 1) % RADIO.driftEvery === 0 && !lastWasDrift

      if (isDriftSlot) {
        // drift prefers exploration pools; any pool is a fallback so the slot
        // still lands on an adjacent-band track rather than breaking rhythm
        const exploreFirst = (kind: PoolKind) =>
          rawPicks.find((p) => !consumed.has(p.track.videoId) && p.pool === kind && isDriftEligible(p))
        const driftPick =
          exploreFirst('discovery') ??
          exploreFirst('cultural') ??
          rawPicks.find((p) => !consumed.has(p.track.videoId) && isDriftEligible(p))
        if (driftPick) {
          consumed.add(driftPick.track.videoId)
          picks.push({
            ...driftPick,
            reasonCode: 'FRESH_FIND',
            reasonLine: REASON_CODES.FRESH_FIND,
            explored: true,
          })
          lastWasDrift = true
          continue
        }
      }

      // normal slot: next unconsumed raw pick
      const next = rawPicks.find((p) => !consumed.has(p.track.videoId))
      if (!next) break
      consumed.add(next.track.videoId)
      picks.push(next)
      lastWasDrift = false
    }

    const vibe = computeVibe(sessionCtx, { surface: 'radio' })
    // report the EFFECTIVE budget: noExplore zeroes ε exactly as decide() saw it
    const epsilon = flags.noExplore ? 0 : vibe === 'SKIP_STORM' ? 0 : profile.exploration.epsilon

    return Response.json({ picks, vibe, epsilon, seed: seedTrack.videoId })
  } catch (e) {
    return Response.json(
      { error: 'radio failed', detail: String(e).slice(0, 200), picks: [], vibe: 'WARMUP', epsilon: 0.15 },
      { status: 500 }
    )
  }
}

export async function GET() {
  return Response.json({ ok: true })
}
