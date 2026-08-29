/**
 * MINDBEAT v2.0 — "ON THE RISE" (plan §9.6) — the Discover Weekly analog,
 * built ONLY from the user's own evidence.
 *
 * Weekly (rolling-7-day) playlist, anchored by the SEED OF THE WEEK: the
 * best-performing FRESH_FIND of the past week — the highest-completion
 * track that was first introduced by a rec surface (REC_EXPOSURE ledger
 * evidence) and then listened to within 7 days. Cold profiles fall back to
 * the top discovery-pool artist, tagged mode:'cold'.
 *
 * Mix budget (plan §9.6):
 *   - ~70% adjacent-to-taste (neighborhood/cultural/affinity pools around
 *     the seed),
 *   - ~30% far exploration (candidates whose TrackFeature language sits
 *     outside the profile's languages — honest adventure),
 *   - ≥60% never-before-played (no ledger listen in the 90d window);
 *     tracks played in the last 7d never count toward that budget.
 *
 * Every pick carries a discovery chain derived from REAL data only — the
 * pool it came from + the seed artist + the track's language. No invented
 * social proof (plan §8.5).
 *
 * SERVER-ONLY. Read-only: ledger reads via 13-a's helpers, profile, engine.
 * Never writes memory.
 */

import { db } from '@/lib/db'
import { currentDaypart, type EnginePick } from '@/lib/mindbeat/types'
import { compileProfile, type TasteProfileData } from '@/lib/mindbeat/profile'
import { getSessionContext, getRecentListens } from '@/lib/mindbeat/ledger'
import { getFeatures } from '@/lib/mindbeat/features'
import { decide, getEngineReads, type CandidatePool } from '@/lib/mindbeat/decision'
import {
  buildPools,
  withCulturalTag,
  primaryPool,
  featuresOf,
  type SeedInput,
} from '@/lib/mindbeat/pools'
import { prettyLanguage } from '@/lib/mindbeat/daylist-name'
import { isContentSafe } from '@/lib/safety'

// ---------------------------------------------------------------------------
// Tunables (plan §9.6)
// ---------------------------------------------------------------------------

const DEFAULT_COUNT = 25
const ALTERNATE_BUFFER = 12
const FEATURE_CAP = 80
const ADJACENT_PCT = 0.7   // neighborhood + cultural + affinity around the seed
const FAR_PCT = 0.3        // two languages over
const NEVER_PLAYED_PCT = 0.6
const WEEK_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_CAP = 4

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface OnTheRiseTrack {
  videoId: string
  title: string
  artistName: string
  artistId?: string
  duration: number
  thumbnail: string
  /** human discovery chain — real pool/seed/language evidence only */
  chain: string
}

export interface OnTheRisePayload {
  id: 'on-the-rise'
  name: string
  tracks: OnTheRiseTrack[]
  seed: { videoId: string; title: string; artistName: string }
  mode: 'live' | 'cold'
  builtAt: string
  /** verification stats (plan §9.6 acceptance) */
  stats: { adjacent: number; far: number; neverPlayed: number; total: number }
}

export interface OnTheRiseOpts {
  count?: number
}

interface SeedTrack {
  videoId: string
  title: string
  artistName: string
  artistId?: string
}

// ---------------------------------------------------------------------------
// In-memory cache — keyed by (weekBucket, seed), TTL ~6h
// ---------------------------------------------------------------------------

const otrCache = new Map<string, { payload: OnTheRisePayload; at: number }>()

function cacheGet(key: string): OnTheRisePayload | null {
  const hit = otrCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > WEEK_TTL_MS) {
    otrCache.delete(key)
    return null
  }
  return hit.payload
}

function cachePut(key: string, payload: OnTheRisePayload): void {
  otrCache.set(key, { payload, at: Date.now() })
  while (otrCache.size > CACHE_CAP) {
    const oldest = otrCache.keys().next().value
    if (oldest === undefined) break
    otrCache.delete(oldest)
  }
}

// ---------------------------------------------------------------------------
// Seed of the week — the best-performing FRESH_FIND of the past week
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Reads the ledger (read-only) for REC_EXPOSURE events of the past 7 days,
 * then ranks the exposed tracks by their best graded listen in the window.
 * "Newly introduced" is verified against the 90d ledger: every recorded
 * listen must have happened at/after the first exposure — a track the user
 * already played before we served it is not a discovery.
 */
async function findSeedOfWeek(): Promise<SeedTrack | null> {
  const nowMs = Date.now()
  const since7 = new Date(nowMs - 7 * DAY_MS)

  const exposures = await db.ledgerEvent
    .findMany({
      where: { type: 'REC_EXPOSURE', ts: { gte: since7 }, trackId: { not: null } },
      select: { trackId: true, ts: true },
      take: 2000,
      orderBy: { ts: 'asc' },
    })
    .catch(() => [])
  if (!exposures.length) return null

  const firstExposure = new Map<string, number>()
  for (const ev of exposures) {
    if (!ev.trackId) continue
    const t = ev.ts.getTime()
    const prev = firstExposure.get(ev.trackId)
    if (prev === undefined || t < prev) firstExposure.set(ev.trackId, t)
  }

  const listens = await getRecentListens(90 * DAY_MS).catch(() => [])
  interface SeedCand {
    trackId: string
    artistName?: string
    completion: number
    listenedMs: number
    gradeRank: number
  }
  const GRADE_RANK: Record<string, number> = {
    COMPLETED: 3, LATE_SKIP: 2, MID_SKIP: 1, EARLY_SKIP: 0, INSTANT_REJECT: -1,
  }
  const cands = new Map<string, SeedCand>()

  for (const l of listens) {
    const firstTs = firstExposure.get(l.trackId)
    if (firstTs === undefined) continue
    const startedMs = Date.parse(l.startedTs)
    if (!Number.isFinite(startedMs)) continue
    // "newly introduced": nothing before we first served it
    if (startedMs < firstTs) {
      cands.delete(l.trackId)
      continue
    }
    if (startedMs < nowMs - 7 * DAY_MS) continue // listen must be inside the week
    const prev = cands.get(l.trackId)
    const better =
      !prev ||
      (GRADE_RANK[l.grade] ?? 0) > prev.gradeRank ||
      ((GRADE_RANK[l.grade] ?? 0) === prev.gradeRank && l.completionRatio > prev.completion)
    if (better) {
      cands.set(l.trackId, {
        trackId: l.trackId,
        artistName: l.artistName,
        completion: l.completionRatio,
        listenedMs: l.listenedMs,
        gradeRank: GRADE_RANK[l.grade] ?? 0,
      })
    }
  }
  if (!cands.size) return null

  const ranked = [...cands.values()].sort((a, b) => {
    if (b.gradeRank !== a.gradeRank) return b.gradeRank - a.gradeRank
    if (b.completion !== a.completion) return b.completion - a.completion
    if (b.listenedMs !== a.listenedMs) return b.listenedMs - a.listenedMs
    return a.trackId < b.trackId ? -1 : 1
  })

  // resolve catalog metadata (title) for the ranked candidates
  const rows = await db.track
    .findMany({
      where: { id: { in: ranked.slice(0, 10).map((c) => c.trackId) } },
      select: { id: true, title: true, artistName: true, artistId: true },
    })
    .catch(() => [])
  const byId = new Map(rows.map((r): [string, (typeof rows)[number]] => [r.id, r]))
  for (const c of ranked) {
    const row = byId.get(c.trackId)
    if (!row?.title) continue
    return {
      videoId: c.trackId,
      title: row.title,
      artistName: row.artistName || c.artistName || '',
      ...(row.artistId ? { artistId: row.artistId } : {}),
    }
  }
  return null
}

/** Cold fallback: the top discovery-pool track's artist anchors the build. */
async function coldSeed(profile: TasteProfileData): Promise<SeedTrack | null> {
  const block = currentDaypart()
  const pooled = await buildPools({
    seeds: [],
    profile,
    block,
    exclude: new Set(profile.corrections.mutedTracks),
    minPool: 60,
  }).catch(() => [])
  const discovery = pooled
    .filter((c) => primaryPool(c.pools) === 'discovery' && c.artistName)
    .sort((a, b) => (a.videoId < b.videoId ? -1 : 1)) // deterministic
  const pickRow = discovery[0]
  if (!pickRow) return null
  return {
    videoId: pickRow.videoId,
    title: pickRow.title,
    artistName: pickRow.artistName,
    ...(pickRow.artistId ? { artistId: pickRow.artistId } : {}),
  }
}

// ---------------------------------------------------------------------------
// Discovery chains — real evidence only (plan §8.5: no social proof)
// ---------------------------------------------------------------------------

function chainFor(
  p: EnginePick,
  ctx: { seedArtist: string; language?: string; isFar: boolean; block: string }
): string {
  const artist = p.track.artistName
  if (ctx.isFar && ctx.language) {
    return `Two languages over — ${prettyLanguage(ctx.language) ?? ctx.language} pick`
  }
  if (p.explored && p.reasonCode === 'FRESH_FIND') {
    return 'A fresh find — see if it sticks'
  }
  switch (p.pool) {
    case 'neighborhood':
      return `Neighbor of ${ctx.seedArtist} — you play them side by side`
    case 'affinity':
      return artist && artist === ctx.seedArtist
        ? `Found via your ${ctx.seedArtist} radio runs`
        : `Because you play ${artist || 'this artist'}`
    case 'cultural':
      return `Same mood family as ${ctx.seedArtist}`
    case 'daypart':
      return `Fits your ${ctx.block} sound`
    default:
      return `Discovered digging around ${ctx.seedArtist}`
  }
}

// ---------------------------------------------------------------------------
// Mix repair — deterministic ratio enforcement over engine-ranked alternates
// ---------------------------------------------------------------------------

function enforceRatios(
  primary: EnginePick[],
  alternates: EnginePick[],
  isFarOf: (p: EnginePick) => boolean,
  neverPlayedOf: (p: EnginePick) => boolean,
  farTarget: number,
  neverTarget: number
): void {
  const usedIds = new Set(primary.map((p) => p.track.videoId))
  const counts = () => {
    let far = 0
    let never = 0
    for (const p of primary) {
      if (isFarOf(p)) far++
      if (neverPlayedOf(p)) never++
    }
    return { far, never }
  }

  const altNever = alternates.filter((a) => !usedIds.has(a.track.videoId) && neverPlayedOf(a))
  const altNeverFar = altNever.filter((a) => isFarOf(a))
  const altNeverAdj = altNever.filter((a) => !isFarOf(a))

  // 1) top the never-played budget up (60%)
  for (let i = primary.length - 1; i >= 1 && counts().never < neverTarget; i--) {
    if (neverPlayedOf(primary[i])) continue
    const keepFar = isFarOf(primary[i])
    const replacement = keepFar ? altNeverFar.shift() : altNeverAdj.shift()
    if (!replacement) break
    usedIds.delete(primary[i].track.videoId)
    primary[i] = replacement
    usedIds.add(replacement.track.videoId)
  }

  // 2) top the far-exploration budget up (30%), preserving the never budget
  for (let i = primary.length - 1; i >= 1 && counts().far < farTarget; i--) {
    if (isFarOf(primary[i])) continue
    const replacement = altNeverFar.find((a) => !usedIds.has(a.track.videoId))
    const fallback = alternates.find((a) => isFarOf(a) && !usedIds.has(a.track.videoId))
    const chosen = replacement ?? fallback
    if (!chosen) break
    usedIds.delete(primary[i].track.videoId)
    primary[i] = chosen
    usedIds.add(chosen.track.videoId)
  }

  // 3) cap runaway far shares (keep the adjacent-to-taste majority)
  const farCap = farTarget + 3
  for (let i = primary.length - 1; i >= 1 && counts().far > farCap; i--) {
    if (!isFarOf(primary[i])) continue
    const replacement = altNeverAdj.find((a) => !usedIds.has(a.track.videoId))
    if (!replacement) break
    usedIds.delete(primary[i].track.videoId)
    primary[i] = replacement
    usedIds.add(replacement.track.videoId)
  }
}

// ---------------------------------------------------------------------------
// Public entry — POST /api/ai/on-the-rise and the Home shelf
// ---------------------------------------------------------------------------

export async function buildOnTheRise(opts?: OnTheRiseOpts): Promise<OnTheRisePayload> {
  const now = new Date()
  const count = Math.max(10, Math.min(40, Math.floor(opts?.count ?? DEFAULT_COUNT)))

  // week bucket = the Monday that starts this chart week
  const dow = (now.getDay() + 6) % 7 // 0 = Monday
  const monday = new Date(now)
  monday.setDate(now.getDate() - dow)
  monday.setHours(0, 0, 0, 0)
  const weekBucket = monday.toISOString().slice(0, 10)
  const monLabel = `${monday.toLocaleString('en-US', { month: 'short' })} ${monday.getDate()}`

  const profile = await compileProfile()

  const seedTrack = await findSeedOfWeek()
  let mode: 'live' | 'cold' = 'live'
  let seed = seedTrack
  if (!seed) {
    mode = 'cold'
    seed = await coldSeed(profile)
  }
  if (!seed) {
    // catalog is empty — honest empty payload
    return {
      id: 'on-the-rise',
      name: `On the Rise — week of ${monLabel}`,
      tracks: [],
      seed: { videoId: '', title: '', artistName: '' },
      mode: 'cold',
      builtAt: now.toISOString(),
      stats: { adjacent: 0, far: 0, neverPlayed: 0, total: 0 },
    }
  }

  const cacheKey = `${weekBucket}|${seed.videoId}`
  const hit = cacheGet(cacheKey)
  if (hit) return hit

  const block = currentDaypart()
  const [session, reads] = await Promise.all([getSessionContext(), getEngineReads()])

  const exclude = new Set<string>([seed.videoId, ...profile.corrections.mutedTracks])
  const seedInput: SeedInput = {
    videoId: seed.videoId,
    title: seed.title,
    artistName: seed.artistName,
    ...(seed.artistId ? { artistId: seed.artistId } : {}),
  }
  const pooled = await buildPools({ seeds: [seedInput], profile, block, exclude, minPool: 110 })
  if (!pooled.length) {
    return {
      id: 'on-the-rise',
      name: `On the Rise — week of ${monLabel}`,
      tracks: [],
      seed: { videoId: seed.videoId, title: seed.title, artistName: seed.artistName },
      mode,
      builtAt: now.toISOString(),
      stats: { adjacent: 0, far: 0, neverPlayed: 0, total: 0 },
    }
  }

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

  // cheap StreamCache knowledge (same contract as /api/mindbeat/next-up)
  const previewOnly: string[] = []
  const unplayable: string[] = []
  if (featureIds.length) {
    const rows = await db.streamCache
      .findMany({ where: { videoId: { in: featureIds } }, select: { videoId: true, provider: true } })
      .catch(() => [])
    for (const r of rows) {
      const prov = String(r.provider || '')
      if (prov.includes('synth') || prov.includes('demo')) unplayable.push(r.videoId)
      else if (prov.includes('preview') || prov.includes('itunes')) previewOnly.push(r.videoId)
    }
  }

  const picks = decide({
    pool: pools,
    session,
    profile,
    block,
    count: Math.min(60, count + ALTERNATE_BUFFER),
    opts: {
      surface: 'discovery',
      seed: `on-the-rise|${weekBucket}|${seed.videoId}`,
      reads,
      previewOnly,
      unplayable,
      exclude: [...exclude],
    },
  })

  // safety + (title|artist) dedupe, preserving engine order
  const seen = new Set<string>()
  const clean: EnginePick[] = []
  for (const p of picks) {
    if (!p?.track?.videoId || !p.track.title) continue
    if (!isContentSafe({ title: p.track.title, artistName: p.track.artistName })) continue
    const key = `${p.track.title.toLowerCase()}|${p.track.artistName.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    clean.push(p)
  }

  const primary = clean.slice(0, count)
  const alternates = clean.slice(count)

  const profileLangs = new Set(
    Object.entries(profile.languages ?? {}).filter(([, v]) => v.w > 0).map(([k]) => k.toLowerCase())
  )
  if (!profileLangs.size) profileLangs.add('en') // default market when no evidence
  const isFarOf = (p: EnginePick): boolean => {
    const lang = feats.get(p.track.videoId)?.language
    return !!lang && !profileLangs.has(lang.toLowerCase())
  }
  const neverPlayedOf = (p: EnginePick): boolean => !reads.lastListenByTrack.has(p.track.videoId)

  const farTarget = Math.round(count * FAR_PCT)
  const neverTarget = Math.ceil(count * NEVER_PLAYED_PCT)
  enforceRatios(primary, alternates, isFarOf, neverPlayedOf, farTarget, neverTarget)

  const tracks: OnTheRiseTrack[] = primary.map((p) => {
    const lang = feats.get(p.track.videoId)?.language
    return {
      videoId: p.track.videoId,
      title: p.track.title,
      artistName: p.track.artistName,
      ...(p.track.artistId ? { artistId: p.track.artistId } : {}),
      duration: p.track.duration ?? 0,
      thumbnail: p.track.thumbnail ?? '',
      chain: chainFor(p, {
        seedArtist: seed.artistName,
        ...(lang ? { language: lang } : {}),
        isFar: isFarOf(p),
        block: block.block,
      }),
    }
  })

  const far = tracks.filter((_, i) => isFarOf(primary[i])).length
  const neverPlayed = tracks.filter((_, i) => neverPlayedOf(primary[i])).length

  const payload: OnTheRisePayload = {
    id: 'on-the-rise',
    name: `On the Rise — week of ${monLabel}`,
    tracks,
    seed: { videoId: seed.videoId, title: seed.title, artistName: seed.artistName },
    mode,
    builtAt: now.toISOString(),
    stats: {
      adjacent: tracks.length - far,
      far,
      neverPlayed,
      total: tracks.length,
    },
  }
  if (payload.tracks.length) cachePut(cacheKey, payload)
  return payload
}
