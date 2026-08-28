/**
 * MINDBEAT v2.0 — Candidate-pool builder (L3→L4 feeder).
 *
 * Builds the ≥3× candidate pools the Decision Engine scores. DB-FIRST by
 * contract (catalog cache rows only; no network search in the hot path —
 * the pool may be smaller when the catalog is cold, the guaranteed top-up
 * keeps it usable).
 *
 * Pools (constitution §8.3):
 *   affinity     — the profile's top artists' catalog tracks (+ seed artists)
 *   neighborhood — coplay-graph neighbors of the seeds ("plays this next to")
 *   daypart      — the current daypart cell's artists
 *   discovery    — known-language / top-mood catalog tracks + catalog top-up
 *   cultural     — tagged post-features: moodTags intersect the profile's top moods
 *
 * SERVER-ONLY (Prisma). Read-only: never writes memory.
 */

import { db } from '@/lib/db'
import type { TrackFeature } from '@prisma/client'
import type { TasteProfileData } from './profile'
import type { PoolKind } from './decision'
import type { DayKind, DaypartBlock } from './types'

export interface SeedInput {
  videoId: string
  title?: string
  artistName?: string
  artistId?: string
}

export interface PooledCandidate {
  videoId: string
  title: string
  artistName: string
  artistId?: string
  duration?: number
  thumbnail?: string
  /** every pool this track surfaced in, in priority order (affinity first) */
  pools: PoolKind[]
}

const TRACK_SELECT = {
  id: true,
  title: true,
  artistName: true,
  artistId: true,
  duration: true,
  thumbnail: true,
} as const

type TrackLite = {
  id: string
  title: string
  artistName: string
  artistId: string | null
  duration: number
  thumbnail: string | null
}

const safe = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback)

/** keys that look like InnerTube channel browseIds rather than display names */
function looksLikeBrowseId(key: string): boolean {
  return /^[A-Za-z0-9_-]{16,}$/.test(key) && (key.startsWith('UC') || !key.includes(' '))
}

function toPooled(t: TrackLite, pool: PoolKind, map: Map<string, PooledCandidate>): void {
  if (!t?.id || !t.title) return
  const prev = map.get(t.id)
  if (prev) {
    if (!prev.pools.includes(pool)) prev.pools.push(pool)
    return
  }
  map.set(t.id, {
    videoId: t.id,
    title: t.title,
    artistName: t.artistName,
    ...(t.artistId ? { artistId: t.artistId } : {}),
    ...(t.duration ? { duration: t.duration } : {}),
    ...(t.thumbnail ? { thumbnail: t.thumbnail } : {}),
    pools: [pool],
  })
}

export interface BuildPoolsOpts {
  seeds: SeedInput[]
  profile: TasteProfileData
  block: { block: DaypartBlock; dayKind: DayKind }
  /** hard-excluded videoIds (queue, recents, muted, radio blocklist…) */
  exclude: Set<string>
  /** guaranteed minimum candidate count (callers pass ≥ 3× their output) */
  minPool: number
}

/**
 * Build the candidate pools. All queries are bounded, parallel and
 * failure-tolerant (a cold DB yields an empty pool, never a throw).
 */
export async function buildPools(opts: BuildPoolsOpts): Promise<PooledCandidate[]> {
  const { profile, block, exclude, minPool } = opts
  const seeds = opts.seeds.filter((s) => s?.videoId)

  // ---- artist keys: top profile artists + the seeds' own artists ----------
  const topArtists = Object.entries(profile.artists)
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, 12)
  const idKeys = new Set<string>()
  const nameKeys = new Set<string>()
  for (const [key, e] of topArtists) {
    if (looksLikeBrowseId(key)) idKeys.add(key)
    else nameKeys.add(key)
    if (e.name && e.name !== key) nameKeys.add(e.name)
  }
  for (const s of seeds) {
    if (s.artistId) idKeys.add(s.artistId)
    if (s.artistName) nameKeys.add(s.artistName)
  }

  // ---- neighborhood: coplay neighbors of the seeds ------------------------
  const neighborIds: string[] = []
  for (const s of seeds) {
    const nbrs = profile.coplayTracks[s.videoId]
    if (!nbrs) continue
    const top = Object.entries(nbrs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id]) => id)
    neighborIds.push(...top)
  }

  // ---- daypart cell artists ----------------------------------------------
  const cell = profile.daypart[`${block.block}|${block.dayKind}`]
  const cellKeys = cell
    ? Object.entries(cell.artists)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k]) => k)
    : []
  const cellIdKeys = cellKeys.filter(looksLikeBrowseId)
  const cellNameKeys = cellKeys
    .filter((k) => !looksLikeBrowseId(k))
    .map((k) => profile.artists[k]?.name ?? k)

  // ---- discovery: known languages + top moods -----------------------------
  const langKeys = Object.entries(profile.languages)
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, 3)
    .map(([k]) => k)
  const moodKeys = Object.entries(profile.moods)
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, 3)
    .map(([k]) => k)

  // ---- fire the queries (bounded, parallel, tolerant) ---------------------
  const affinityWhere = [
    ...(idKeys.size ? [{ artistId: { in: [...idKeys] } }] : []),
    ...(nameKeys.size ? [{ artistName: { in: [...nameKeys] } }] : []),
  ]
  const daypartWhere = [
    ...(cellIdKeys.length ? [{ artistId: { in: cellIdKeys } }] : []),
    ...(cellNameKeys.length ? [{ artistName: { in: cellNameKeys } }] : []),
  ]

  const [affinityTracks, neighborTracks, daypartTracks, featureRows, topUpTracks] = await Promise.all([
    affinityWhere.length
      ? safe(db.track.findMany({ where: { OR: affinityWhere }, select: TRACK_SELECT, take: 60 }), [] as TrackLite[])
      : Promise.resolve([] as TrackLite[]),
    neighborIds.length
      ? safe(db.track.findMany({ where: { id: { in: [...new Set(neighborIds)] } }, select: TRACK_SELECT, take: 40 }), [] as TrackLite[])
      : Promise.resolve([] as TrackLite[]),
    daypartWhere.length
      ? safe(db.track.findMany({ where: { OR: daypartWhere }, select: TRACK_SELECT, take: 40 }), [] as TrackLite[])
      : Promise.resolve([] as TrackLite[]),
    langKeys.length || moodKeys.length
      ? safe(
          db.trackFeature.findMany({
            where: {
              OR: [
                ...(langKeys.length ? [{ language: { in: langKeys } }] : []),
                ...moodKeys.map((m) => ({ moodTags: { contains: m } })),
              ],
            },
            select: { trackId: true },
            take: 60,
          }),
          [] as { trackId: string }[]
        )
      : Promise.resolve([] as { trackId: string }[]),
    safe(
      db.track.findMany({ orderBy: { updatedAt: 'desc' }, select: TRACK_SELECT, take: 40 }),
      [] as TrackLite[]
    ),
  ])

  const discoveryFeatureIds = featureRows.map((f) => f.trackId)
  const discoveryTracks = discoveryFeatureIds.length
    ? await safe(db.track.findMany({ where: { id: { in: discoveryFeatureIds } }, select: TRACK_SELECT, take: 60 }), [] as TrackLite[])
    : ([] as TrackLite[])

  // ---- assemble (dedupe by videoId, pool tags in priority order) ----------
  const map = new Map<string, PooledCandidate>()
  for (const t of affinityTracks) toPooled(t as TrackLite, 'affinity', map)
  for (const t of neighborTracks) toPooled(t as TrackLite, 'neighborhood', map)
  for (const t of daypartTracks) toPooled(t as TrackLite, 'daypart', map)
  for (const t of discoveryTracks) toPooled(t as TrackLite, 'discovery', map)

  // catalog top-up ALWAYS feeds the discovery pool — on cold profiles
  // (no language/mood evidence yet) it is the only exploration material,
  // and constitution §8.3 lists "random chart cache rows" as a discovery source.
  for (const t of topUpTracks) toPooled(t as TrackLite, 'discovery', map)

  // pre-filter: exclusions + muted (defense in depth — decide() re-checks)
  const mutedTracks = new Set(profile.corrections.mutedTracks)
  const mutedArtists = new Set(profile.corrections.mutedArtists)
  const out: PooledCandidate[] = []
  for (const c of map.values()) {
    if (exclude.has(c.videoId) || mutedTracks.has(c.videoId)) continue
    if (c.artistId && mutedArtists.has(c.artistId)) continue
    if (c.artistName && mutedArtists.has(c.artistName)) continue
    out.push(c)
    if (out.length >= Math.max(minPool, 120)) break
  }
  return out
}

/**
 * Post-features pass: tag candidates whose moodTags intersect the profile's
 * top moods as `cultural` (the LLM-prior mood space). Mutates `pools`.
 */
export function withCulturalTag(
  pools: PooledCandidate[],
  features: Map<string, TrackFeature>,
  profile: TasteProfileData
): void {
  const topMoods = new Set(
    Object.entries(profile.moods)
      .sort((a, b) => b[1].w - a[1].w)
      .slice(0, 6)
      .map(([k]) => k)
  )
  if (!topMoods.size) return
  for (const c of pools) {
    if (c.pools.includes('cultural')) continue
    const row = features.get(c.videoId)
    if (!row?.moodTags) continue
    try {
      const tags = JSON.parse(row.moodTags) as string[]
      if (Array.isArray(tags) && tags.some((t) => topMoods.has(t))) c.pools.push('cultural')
    } catch {
      /* malformed moodTags — skip */
    }
  }
}

/** Pick the primary pool tag (highest priority = earliest in PoolKind order). */
export function primaryPool(pools: PoolKind[]): PoolKind {
  const order: PoolKind[] = ['affinity', 'neighborhood', 'daypart', 'cultural', 'discovery']
  for (const p of order) if (pools.includes(p)) return p
  return 'discovery'
}

/** Map a TrackFeature row onto the engine's CandidateFeatures shape. */
export function featuresOf(row: TrackFeature | undefined): { energy: number; valence: number; tempoClass?: string; moodTags?: string[]; language?: string } | undefined {
  if (!row) return undefined
  let moodTags: string[] = []
  try {
    moodTags = row.moodTags ? (JSON.parse(row.moodTags) as string[]) : []
  } catch {
    moodTags = []
  }
  return {
    energy: row.effEnergy ?? row.energy ?? 0.5,
    valence: row.effValence ?? row.valence ?? 0.5,
    ...(row.tempoClass ? { tempoClass: row.tempoClass } : {}),
    ...(moodTags.length ? { moodTags } : {}),
    ...(row.language ? { language: row.language } : {}),
  }
}
