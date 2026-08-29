/**
 * MINDBEAT v2.0 — DAYLIST v2 "NOW SOUND" brain (plan §9.4).
 *
 * The Heggli five-block × weekday/weekend model surfaced as a living
 * playlist. On first play (or first app open) within a block it (re)builds
 * from the block's profile matrix cell + the session brain's continuity:
 *   - 22–28 tracks (target 26), mostly trusted artists inside the block's
 *     energy band (cell energyMean when the cell has ≥3 sessions, else the
 *     documented Heggli-style prior from daylist-name.ts),
 *   - exactly 2–3 FRESH_FINDs from the discovery pool (the surface pins its
 *     own exploration budget — the global ε is capped for this surface),
 *   - deterministic name in the verified daylist pattern
 *     ("After Hours Soft Pop" / "Sunday Morning Slow Bollywood"),
 *   - a "Shifts around 5 pm" next-block hint — the daylist mechanic.
 *
 * Re-entries within the same (block, dayKind, profile fingerprint) are
 * served from an in-memory cache (TTL ~20 min) so Home does not re-fan-out
 * searches on every open; a changed fingerprint (profile recompiled) forces
 * a re-rank. The Decision Engine keeps its own 30s read-cache underneath.
 *
 * COLD FALLBACK: a profile with no daypart data (or an engine path that
 * cannot fill the list) falls back to the v2.1 keyword-search builder,
 * tagged mode:'cold' — the app never gets dumber than v2.1.
 *
 * SERVER-ONLY. Read-only: profile + engine + pools + ledger reads. This
 * module never writes memory (no ledger writes, no corrections).
 */

import { db } from '@/lib/db'
import {
  EPSILON,
  REASON_CODES,
  BLOCK_BOUNDARIES,
  currentDaypart,
  DAYPART_BLOCKS,
  type DayKind,
  type DaypartBlock,
  type EnginePick,
} from '@/lib/mindbeat/types'
import { compileProfile, type TasteProfileData } from '@/lib/mindbeat/profile'
import { getSessionContext } from '@/lib/mindbeat/ledger'
import { getFeatures } from '@/lib/mindbeat/features'
import { decide, getEngineReads, type CandidatePool } from '@/lib/mindbeat/decision'
import {
  buildPools,
  withCulturalTag,
  primaryPool,
  featuresOf,
  type PooledCandidate,
  type SeedInput,
} from '@/lib/mindbeat/pools'
import {
  BLOCK_ENERGY_PRIOR,
  daylistName,
  nextShiftHint,
} from '@/lib/mindbeat/daylist-name'
import { filterSafeTracks, isContentSafe } from '@/lib/safety'
import { search as ytmSearch, artist as ytmArtist, radio as ytmRadio, type YtmTrack } from '@/lib/ytm'
import { readProfile, type OnboardingProfile } from '@/app/api/onboarding/route'

// ---------------------------------------------------------------------------
// Tunables (plan §9.4)
// ---------------------------------------------------------------------------

const TARGET_TRACKS = 26          // 22–28 window
const MIN_TRACKS = 22
const FRESH_MIN = 2               // guaranteed FRESH_FINDs
const FRESH_MAX = 3               // cap — the daylist is "mostly trusted artists"
const DAYLIST_EPSILON_CAP = 0.12  // the surface pins its own exploration budget
const ALTERNATE_BUFFER = 12       // extra engine-ranked picks for mix repairs
const FEATURE_CAP = 120           // features are heuristic-instant; cover the whole pool
const POOL_CAP = 120
/**
 * Block-shaping levels. Plan §9.4: the daylist is "mostly trusted artists in
 * the block's energy/valence band, 2–3 FRESH_FINDs" — so the main pool is
 * TRUSTED-artist tracks sliced around the block's energy target (tighter
 * first, widening until the list can be filled), and the discovery pool is
 * reserved for the fresh-find slots. The last resort drops the shaping
 * entirely rather than returning a short list.
 */
const SHAPING_LEVELS: { band: number; trustedOnly: boolean }[] = [
  { band: 0.25, trustedOnly: true },
  { band: 0.4, trustedOnly: true },
  { band: Infinity, trustedOnly: true },
  { band: Infinity, trustedOnly: false }, // last resort: any candidate
]
const TRUSTED_POOL_TAKE = 70  // rank-based slice: nearest the energy target wins
const MIN_POOL_OK = 40
const FRESH_QUEUE_SIZE = 8
const DAYLIST_TTL_MS = 20 * 60 * 1000
const CACHE_CAP = 12

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface NowSoundTrack {
  videoId: string
  title: string
  artistName: string
  artistId?: string
  albumName?: string
  albumId?: string
  duration: number
  thumbnail: string
}

export interface NowSoundPayload {
  id: 'daylist'
  name: string
  /** = name (AiGeneratedView header renders `title`) */
  title: string
  subtitle: string
  block: DaypartBlock
  dayKind: DayKind
  /** "Shifts around 4 pm" — the next block boundary (human hint) */
  nextShift: string
  mode: 'live' | 'cold'
  cover?: string
  tracks: NowSoundTrack[]
  savedAt: string
}

export interface NowSoundOpts {
  /** B5 shadow-testing hook: force the block/dayKind server-side */
  forceBlock?: string | null
  forceDayKind?: string | null
}

// ---------------------------------------------------------------------------
// In-memory cache — keyed by (block, dayKind, profile fingerprint), TTL 20 min
// ---------------------------------------------------------------------------

const daylistCache = new Map<string, { payload: NowSoundPayload; at: number }>()

function cacheGet(key: string): NowSoundPayload | null {
  const hit = daylistCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > DAYLIST_TTL_MS) {
    daylistCache.delete(key)
    return null
  }
  return hit.payload
}

function cachePut(key: string, payload: NowSoundPayload): void {
  daylistCache.set(key, { payload, at: Date.now() })
  while (daylistCache.size > CACHE_CAP) {
    const oldest = daylistCache.keys().next().value
    if (oldest === undefined) break
    daylistCache.delete(oldest)
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const validBlock = (v?: string | null): DaypartBlock | null =>
  v && (DAYPART_BLOCKS as readonly string[]).includes(v) ? (v as DaypartBlock) : null

const validDayKind = (v?: string | null): DayKind | null =>
  v === 'weekday' || v === 'weekend' ? v : null

function hasDaypartData(p: TasteProfileData): boolean {
  return Object.values(p.daypart ?? {}).some(
    (c) => (c?.sessionCount ?? 0) > 0 && Object.keys(c?.artists ?? {}).length > 0
  )
}

/** Cell energyMean (≥3 sessions) wins; otherwise the documented block prior. */
function targetEnergyOf(p: TasteProfileData, block: DaypartBlock, dayKind: DayKind): number {
  const cell = p.daypart[`${block}|${dayKind}`]
  if (cell && cell.sessionCount >= 3 && cell.energyMean !== null && cell.energyMean !== undefined) {
    return cell.energyMean
  }
  return BLOCK_ENERGY_PRIOR[block][dayKind]
}

function topGenreOf(p: TasteProfileData): string | null {
  const top = Object.entries(p.genres ?? {}).sort((a, b) => b[1].w - a[1].w)[0]
  return top ? top[0] : null
}

function topLanguageOf(p: TasteProfileData): string | null {
  const top = Object.entries(p.languages ?? {}).sort((a, b) => b[1].w - a[1].w)[0]
  return top ? top[0] : null
}

/** Safety + (title|artist) dedupe, preserving engine order. */
function cleanPicks(picks: EnginePick[]): EnginePick[] {
  const seen = new Set<string>()
  const out: EnginePick[] = []
  for (const p of picks) {
    if (!p?.track?.videoId || !p.track.title) continue
    if (!isContentSafe({ title: p.track.title, artistName: p.track.artistName })) continue
    const key = `${p.track.title.toLowerCase()}|${p.track.artistName.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

function toTrack(p: EnginePick): NowSoundTrack {
  return {
    videoId: p.track.videoId,
    title: p.track.title,
    artistName: p.track.artistName,
    ...(p.track.artistId ? { artistId: p.track.artistId } : {}),
    duration: p.track.duration ?? 0,
    thumbnail: p.track.thumbnail ?? '',
  }
}

// ---------------------------------------------------------------------------
// Engine path — the block-matrix daylist
// ---------------------------------------------------------------------------

/** Deterministic hash (same contract as decision.ts/daylist-name.ts). */
function hash01(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 0x100000000
}

/**
 * Per-block trusted-artist lead. With only ONE seeded cell the honest
 * block-signal is the energy band + the cell's own artists; to make the
 * daylist actually SHIFT between blocks without fabricating taste evidence,
 * the surface leads with a different (deterministic) two-thirds of the
 * user's top trusted artists per (block, dayKind). Every included artist is
 * still genuinely trusted — reason lines stay truthful. Cell artists are
 * ALWAYS included: the block cell is the daylist's authority.
 */
function trustedArtistKeys(profile: TasteProfileData, block: DaypartBlock, dayKind: DayKind): Set<string> {
  const keys = new Set<string>()
  // the block cell's own artists always pass (daylist authority)
  const cell = profile.daypart[`${block}|${dayKind}`]
  if (cell) for (const k of Object.keys(cell.artists)) keys.add(k)

  const top = Object.entries(profile.artists)
    .filter(([, e]) => e.w > 0)
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, 8)
  if (top.length >= 4) {
    // deterministic per-block shuffle — adjacent blocks lead with a
    // different half of the same taste (the daylist's "living playlist"
    // behavior) without fabricating any taste evidence
    const rotated = shuffled(top, `daylist-rotation|${block}|${dayKind}`)
    const keep = Math.max(2, Math.ceil(top.length / 2))
    for (const [k, e] of rotated.slice(0, keep)) {
      keys.add(k)
      if (e.name) keys.add(e.name)
    }
  } else {
    for (const [k, e] of top) {
      keys.add(k)
      if (e.name) keys.add(e.name)
    }
  }
  return keys
}

function candidateIsTrusted(c: CandidatePool, trusted: Set<string>, profile: TasteProfileData): boolean {
  if (c.artistId && trusted.has(c.artistId)) return true
  if (c.artistName && trusted.has(c.artistName)) return true
  // profile entries are keyed by browseId OR name — resolve via the profile
  if (c.artistId && profile.artists[c.artistId]?.name && trusted.has(profile.artists[c.artistId].name!)) return true
  return false
}

/** keys that look like InnerTube channel browseIds rather than display names */
function looksLikeBrowseId(key: string): boolean {
  return /^[A-Za-z0-9_-]{16,}$/.test(key) && (key.startsWith('UC') || !key.includes(' '))
}

/** Deterministic per-seed shuffle (Fisher–Yates over hash01) — no Math.random. */
function shuffled<T>(arr: readonly T[], seed: string): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(hash01(`${seed}|${i}`) * (i + 1)) % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const TRACK_SELECT = {
  id: true,
  title: true,
  artistName: true,
  artistId: true,
  duration: true,
  thumbnail: true,
} as const

/**
 * Supplemental trusted-artist catalog query. buildPools' affinity take(60)
 * is SHARED across every top artist — a prolific #1 starves the per-block
 * rotation. This tops each rotated artist up so every block actually has
 * its trusted artists' material to rank. Read-only, bounded, tagged
 * 'affinity' (these ARE the profile's own top artists).
 */
async function fetchTrustedExtra(
  profile: TasteProfileData,
  trusted: Set<string>,
  exclude: Set<string>
): Promise<PooledCandidate[]> {
  const mutedArtists = new Set(profile.corrections.mutedArtists)
  const mutedTracks = new Set(profile.corrections.mutedTracks)
  const keys = [...trusted].filter((k) => k && !mutedArtists.has(k)).slice(0, 10)
  const rowsPerKey = await Promise.all(
    keys.map((k) =>
      (
        looksLikeBrowseId(k)
          ? db.track.findMany({ where: { artistId: k }, select: TRACK_SELECT, take: 16 })
          : db.track.findMany({ where: { artistName: k }, select: TRACK_SELECT, take: 16 })
      ).catch(() => [])
    )
  )
  const seen = new Set<string>(exclude)
  const out: PooledCandidate[] = []
  for (const rows of rowsPerKey) {
    for (const t of rows) {
      if (!t?.id || !t.title || seen.has(t.id) || mutedTracks.has(t.id)) continue
      seen.add(t.id)
      out.push({
        videoId: t.id,
        title: t.title,
        artistName: t.artistName,
        ...(t.artistId ? { artistId: t.artistId } : {}),
        ...(t.duration ? { duration: t.duration } : {}),
        ...(t.thumbnail ? { thumbnail: t.thumbnail } : {}),
        pools: ['affinity'],
      })
    }
  }
  return out
}

async function buildEngineDaylist(
  profile: TasteProfileData,
  block: DaypartBlock,
  dayKind: DayKind,
  now: Date
): Promise<{ tracks: NowSoundTrack[]; freshCount: number } | null> {
  const [session, reads] = await Promise.all([getSessionContext(), getEngineReads()])
  const target = targetEnergyOf(profile, block, dayKind)
  const trusted = trustedArtistKeys(profile, block, dayKind)

  // ---- candidate pools: daypart (block cell) + affinity + discovery -------
  const exclude = new Set<string>(session.sessionListens.map((l) => l.trackId))
  const seeds: SeedInput[] = [] // daypart pool fills from the cell itself; affinity from the profile
  const [pooledBase, trustedExtra] = await Promise.all([
    buildPools({ seeds, profile, block: { block, dayKind }, exclude, minPool: POOL_CAP }),
    fetchTrustedExtra(profile, trusted, exclude),
  ])
  // rotated trusted artists first (they own the daylist), then the base pools
  const merged = new Map<string, PooledCandidate>()
  for (const c of [...trustedExtra, ...pooledBase]) {
    if (merged.has(c.videoId)) continue
    merged.set(c.videoId, c)
    if (merged.size >= POOL_CAP) break
  }
  const pooled = [...merged.values()]
  if (!pooled.length) return null

  const featureIds = pooled.slice(0, FEATURE_CAP).map((c) => c.videoId)
  const feats = featureIds.length ? await getFeatures(featureIds) : new Map()
  withCulturalTag(pooled, feats, profile)

  const allPools: CandidatePool[] = pooled.slice(0, FEATURE_CAP).map((c) => {
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

  // The surface pins its own fresh-find budget (plan §9.4): cap the global ε
  // for THIS surface — a cold profile's ε=0.5 would otherwise flood the
  // daylist with exploration instead of the user's trusted block artists.
  const daylistProfile: TasteProfileData = {
    ...profile,
    exploration: {
      ...profile.exploration,
      epsilon: Math.min(profile.exploration?.epsilon ?? EPSILON.established, DAYLIST_EPSILON_CAP),
    },
  }

  // Block shaping: the pool the engine sees is trusted-artist tracks sliced
  // around the block's energy target (rank-based nearest-first when the
  // slice is oversized), tighter first, widening until the list can be
  // filled. "No 9am pool at 11pm" lives here.
  let best: { tracks: NowSoundTrack[]; freshCount: number } | null = null
  for (let li = 0; li < SHAPING_LEVELS.length; li++) {
    const level = SHAPING_LEVELS[li]
    const isLast = li === SHAPING_LEVELS.length - 1
    let inSlice = allPools.filter((c) => {
      const bandOk =
        !Number.isFinite(level.band) ||
        c.features == null ||
        Math.abs(c.features.energy - target) <= level.band
      if (!bandOk) return false
      if (!level.trustedOnly) return true
      if (c.pool === 'discovery') return false // discovery is fresh-find material only
      return candidateIsTrusted(c, trusted, profile)
    })
    // rank-based slice: when the band admits too many, the nearest the
    // block's energy target win the slots
    if (Number.isFinite(level.band) && inSlice.length > TRUSTED_POOL_TAKE) {
      inSlice = [...inSlice]
        .sort((a, b) => {
          const da = Math.abs((a.features?.energy ?? target) - target)
          const db = Math.abs((b.features?.energy ?? target) - target)
          if (da !== db) return da - db
          return a.videoId < b.videoId ? -1 : 1
        })
        .slice(0, TRUSTED_POOL_TAKE)
    }
    if (!isLast && inSlice.length < MIN_POOL_OK) continue // widen — not enough material

    // discovery candidates outside the slice are the FRESH_FIND queue —
    // ordered by a block-stable hash so different blocks surface different
    // fresh finds from the same material
    const inSliceIds = new Set(inSlice.map((c) => c.videoId))
    const reserves = allPools
      .filter((c) => !inSliceIds.has(c.videoId) && c.pool === 'discovery')
      .filter((c) => isContentSafe({ title: c.title, artistName: c.artistName }))
      .sort((a, b) => {
        const ha = hash01(`${block}|${dayKind}|${a.videoId}`)
        const hb = hash01(`${block}|${dayKind}|${b.videoId}`)
        if (ha !== hb) return ha - hb
        return a.videoId < b.videoId ? -1 : 1
      })
      .slice(0, FRESH_QUEUE_SIZE)

    const picks = decide({
      pool: inSlice,
      session,
      profile: daylistProfile,
      block: { block, dayKind },
      count: Math.min(60, TARGET_TRACKS + ALTERNATE_BUFFER),
      opts: {
        surface: 'daylist',
        seed: `daylist|${block}|${dayKind}`,
        reads,
        previewOnly,
        unplayable,
        exclude: session.sessionListens.map((l) => l.trackId),
      },
    })

    const clean = cleanPicks(picks)
    const primary = clean.slice(0, TARGET_TRACKS)
    const alternates = clean.slice(TARGET_TRACKS)

    // ---- fresh-find normalization: guarantee 2–3 FRESH_FINDs --------------
    // (engine-ranked alternates first — in-band fresh finds — then the
    // out-of-band discovery reserves)
    const freshIdx = primary.map((p, i) => (p.explored ? i : -1)).filter((i) => i >= 0)
    const usedIds = new Set(primary.map((p) => p.track.videoId))
    const freshAltQueue = alternates.filter((a) => a.pool === 'discovery' && !usedIds.has(a.track.videoId))
    const reserveQueue: EnginePick[] = reserves
      .filter((c) => !usedIds.has(c.videoId))
      .map((c): EnginePick => ({
        track: {
          videoId: c.videoId,
          title: c.title,
          artistName: c.artistName,
          ...(c.artistId ? { artistId: c.artistId } : {}),
          ...(c.duration !== undefined ? { duration: c.duration } : {}),
          ...(c.thumbnail ? { thumbnail: c.thumbnail } : {}),
        },
        score: 0,
        reasonCode: 'FRESH_FIND',
        reasonLine: REASON_CODES.FRESH_FIND,
        explored: true,
        pool: 'discovery',
      }))
    const otherAltQueue = alternates.filter((a) => a.pool !== 'discovery' && !usedIds.has(a.track.videoId))

    for (let i = primary.length - 1; i >= 1 && freshIdx.length < FRESH_MIN; i--) {
      if (primary[i].explored) continue
      const replacement = freshAltQueue.shift() ?? reserveQueue.shift()
      if (!replacement) break
      primary[i] = replacement
      freshIdx.push(i)
    }
    // surplus fresh finds (a cold ε or storm-fluke could over-explore):
    // swap the tail-most ones for ranked non-fresh alternates, in place.
    while (freshIdx.length > FRESH_MAX) {
      const idx = freshIdx.pop()!
      const replacement = otherAltQueue.shift()
      if (!replacement) break
      primary[idx] = replacement
    }

    const tracks = primary.map(toTrack)
    const result = { tracks, freshCount: freshIdx.length }
    if (tracks.length >= MIN_TRACKS || isLast) return tracks.length ? result : best
    if (!best || tracks.length > best.tracks.length) best = result
  }
  return best
}

// ---------------------------------------------------------------------------
// Cold fallback — the v2.1 keyword-search builder (behavior preserved)
// ---------------------------------------------------------------------------

const LEGACY_TIME_BLOCKS = [
  { start: 4, end: 9, name: 'Rise & Shine', query: 'morning chill feel good' },
  { start: 9, end: 12, name: 'Focus Flow', query: 'focus instrumental deep' },
  { start: 12, end: 15, name: 'Lunch Break', query: 'afternoon hits upbeat' },
  { start: 15, end: 18, name: 'Energy Boost', query: 'energy workout hits' },
  { start: 18, end: 22, name: 'Unwind', query: 'evening chill acoustic' },
  { start: 22, end: 28, name: 'Wind Down', query: 'late night ambient slow' }, // wraps past midnight
]

function legacyBlockFor(hour: number) {
  const block = LEGACY_TIME_BLOCKS.find((b) => {
    if (b.end > 24) return hour >= b.start || hour < b.end - 24
    return hour >= b.start && hour < b.end
  })
  return block || LEGACY_TIME_BLOCKS[5]
}

function legacyTrackToPlayer(t: YtmTrack): NowSoundTrack | null {
  if (!t) return null
  const videoId = t.videoId
  if (!videoId || !t.title) return null
  return {
    videoId,
    title: t.title,
    artistName: t.artistName || '',
    ...(t.artistId ? { artistId: t.artistId } : {}),
    ...(t.albumName ? { albumName: t.albumName } : {}),
    ...(t.albumId ? { albumId: t.albumId } : {}),
    duration: t.duration || 0,
    thumbnail: t.thumbnail || '',
  }
}

async function buildLegacyDaylist(
  onboarding: OnboardingProfile,
  block: DaypartBlock,
  dayKind: DayKind,
  now: Date
): Promise<NowSoundTrack[]> {
  const legacy = legacyBlockFor(now.getHours())
  const seen = new Set<string>()
  const out: NowSoundTrack[] = []
  const pushTrack = (t: NowSoundTrack | null) => {
    if (!t || seen.has(t.videoId)) return
    seen.add(t.videoId)
    out.push(t)
  }

  // 1) mood query + first favorite artist
  if (onboarding.artists.length) {
    try {
      const r = await ytmSearch(`${legacy.query} ${onboarding.artists[0].name}`.trim(), 'songs')
      filterSafeTracks((r.tracks || []).slice(0, 15))
        .map(legacyTrackToPlayer)
        .forEach(pushTrack)
    } catch { /* skip */ }
  }

  // 2) mood + first genre
  if (onboarding.genres.length && out.length < TARGET_TRACKS) {
    try {
      const r = await ytmSearch(`${legacy.query} ${onboarding.genres[0]}`.trim(), 'songs')
      filterSafeTracks((r.tracks || []).slice(0, 10))
        .map(legacyTrackToPlayer)
        .forEach(pushTrack)
    } catch { /* skip */ }
  }

  // 3) radio from a favorite artist (variety)
  if (onboarding.artists.length && out.length < TARGET_TRACKS) {
    const a = onboarding.artists[now.getTime() % Math.min(onboarding.artists.length, 3)]
    try {
      const page = await ytmArtist(a.id)
      const top = (page.topTracks || [])[0]
      if (top) {
        const rad = await ytmRadio(top.videoId)
        for (const t of filterSafeTracks((rad.tracks || []).slice(0, 8))) {
          const m = legacyTrackToPlayer(t)
          if (m) pushTrack(m)
          if (out.length >= TARGET_TRACKS) break
        }
      }
    } catch { /* skip */ }
  }

  // dedupe by title|artist too
  const seenTitles = new Set<string>()
  return out.filter((t) => {
    const k = `${t.title.toLowerCase()}|${t.artistName.toLowerCase()}`
    if (seenTitles.has(k)) return false
    seenTitles.add(k)
    return true
  })
}

// ---------------------------------------------------------------------------
// Featured-card cover support: the featured route reads this ApiCache row to
// give the daylist hub a real cover. Best-effort, never fatal.
// ---------------------------------------------------------------------------

async function writeCoverCacheRow(payload: NowSoundPayload, onboarding: OnboardingProfile, now: Date): Promise<void> {
  try {
    if (!payload.tracks.length) return
    const sig = onboarding.artists.map((a) => a.id).join(',')
    const dateStr = now.toISOString().slice(0, 10)
    const hourBucket = Math.floor(now.getHours() / 6)
    const key = `ai:daylist:${dateStr}:${hourBucket}:${sig}`
    const cover = payload.cover
    await db.apiCache.upsert({
      where: { key },
      update: { payload: JSON.stringify({ ...payload, cover: cover ?? payload.tracks[0].thumbnail }), expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000) },
      create: { key, payload: JSON.stringify({ ...payload, cover: cover ?? payload.tracks[0].thumbnail }), expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000) },
    })
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Public entry — GET/POST /api/ai/daylist and the Home "Now Sound" shelf
// ---------------------------------------------------------------------------

export async function buildNowSound(opts?: NowSoundOpts): Promise<NowSoundPayload> {
  const now = new Date()
  const computed = currentDaypart(now)
  const block = validBlock(opts?.forceBlock) ?? computed.block
  const dayKind = validDayKind(opts?.forceDayKind) ?? computed.dayKind

  const profile = await compileProfile()
  const fingerprint = `${profile.compiledAt}|${topGenreOf(profile) ?? ''}|${topLanguageOf(profile) ?? ''}`
  const cacheKey = `${block}|${dayKind}|${fingerprint}`
  const hit = cacheGet(cacheKey)
  if (hit) return hit

  const onboarding = await readProfile().catch(() => ({ complete: false, artists: [], genres: [] } as unknown as OnboardingProfile))
  // The hint reads the next boundary of the SERVED block: real-clock builds
  // hint from now; shadow-tested builds (?forceBlock=…) hint from the forced
  // block's start hour so the text stays truthful for that surface.
  const i = dayKind === 'weekday' ? 0 : 1
  const hintHour = block === computed.block ? now.getHours() : BLOCK_BOUNDARIES[block][i]
  const nextShift = `Shifts around ${nextShiftHint(now, dayKind, hintHour)}`

  let mode: 'live' | 'cold' = 'live'
  let tracks: NowSoundTrack[] = []
  let freshCount = 0

  const cold = !hasDaypartData(profile)
  if (!cold) {
    try {
      const engine = await buildEngineDaylist(profile, block, dayKind, now)
      if (engine && engine.tracks.length >= MIN_TRACKS) {
        tracks = engine.tracks
        freshCount = engine.freshCount
      }
    } catch { /* engine failure → legacy fallback below */ }
  }
  if (tracks.length < MIN_TRACKS) {
    mode = 'cold'
    tracks = await buildLegacyDaylist(onboarding, block, dayKind, now)
  }

  const name = daylistName({
    block,
    dayKind,
    topGenre: topGenreOf(profile) ?? onboarding.genres?.[0] ?? null,
    topLanguage: topLanguageOf(profile),
    energy: targetEnergyOf(profile, block, dayKind),
    now,
  })
  const payload: NowSoundPayload = {
    id: 'daylist',
    name,
    title: name,
    subtitle: nextShift,
    block,
    dayKind,
    nextShift,
    mode,
    ...(tracks[0]?.thumbnail ? { cover: tracks[0].thumbnail } : {}),
    tracks: tracks.slice(0, TARGET_TRACKS + 2), // 22–28 window hard ceiling
    savedAt: now.toISOString(),
  }
  void freshCount // surfaced via tests; kept out of the wire payload

  if (payload.tracks.length) {
    cachePut(cacheKey, payload)
    void writeCoverCacheRow(payload, onboarding, now)
  }
  return payload
}
