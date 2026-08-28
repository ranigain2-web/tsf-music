/**
 * TSF Music — Multi-provider stream resolver (v3: tiered race + ranked cache)
 *
 * FIXES THE TWO FIELD REPORTS OF 2026-08-27/28:
 *   1. "Some tracks still 30s preview" — a title-scoped itunes-preview cache
 *      row SHADOWED the bare-videoId yt-dlp full-length row (DB evidence:
 *      `dC9QIUKviJU::to68qjh|itunes-preview` sitting next to
 *      `dC9QIUKviJU|yt-dlp`). The cache is now looked up with PROVIDER-CLASS
 *      RANKING: a full-length row under ANY key for the videoId always beats
 *      a preview row. Additionally, whenever a full-length result resolves,
 *      all preview/synth rows for that videoId are purged — previews can
 *      never creep back.
 *   2. "Some tracks play dummy synth audio" — the resolver now gives yt-dlp
 *      a FAIR WAIT (7s) before settling for a preview, runs it concurrently
 *      with a fail-fast first wave, retries it with a second client list on
 *      per-video bot-walls, and only falls to synth when EVERYTHING failed.
 *
 * RESOLUTION ORDER (tiered):
 *   Wave 1 (fail-fast, ~4s cap, first success wins):
 *     - JioSaavn (title match; Indian/regional catalog, 320 kbps, ANY IP)
 *     - InnerTube clients (VISIONOS → IOS → TVHTML5 → …; circuit-broken)
 *     - Piped / Invidious relay seeds (mostly dead; kept as long-shots)
 *   Concurrent: yt-dlp subprocess (full YouTube extraction power; 25s cap
 *     internally, 7s fair-wait before we settle for a preview; keeps running
 *     in the background to warm the cache even after we answer).
 *   Fallback A: iTunes preview — REAL 30s clip, honestly labeled, 2h TTL.
 *   Fallback B: TSF Synth — last resort, 30min TTL.
 *
 * CACHE DESIGN:
 *   videoId-bound results (innertube-*, yt-dlp, piped-*, invidious-*) are
 *   stored under the bare `videoId` key; title-bound results (jiosaavn,
 *   itunes-preview) under `videoId::<titleHash>`. Lookup scans ALL rows for
 *   the videoId and ranks: full-length > preview > synth.
 *
 * Health tracking (DB), an in-flight dedup map, a memory LRU, and a resolve
 * metrics ring (globalThis — Turbopack dev compiles routes separately) are
 * all part of the resolver surface used by /api/health.
 */
import { CLIENTS } from './clients'
import { db } from '@/lib/db'
import { resolveITunesPreview } from './itunes'
import { resolveJioSaavn } from './jiosaavn'
import { resolveYtDlp, ytDlpBinary, VIDEO_ID_RE } from './ytdlp'
import { recordResolve } from './metrics'

export interface StreamResult {
  url: string
  provider: string
  bitrate: number
  expiresAt: number
  mime: string
  /**
   * User-Agent that MUST accompany byte fetches of `url`. googlevideo
   * URLs resolved by app-style clients (IOS/VISIONOS/ANDROID*) are signed
   * against the resolving client's UA — fetching them with a generic UA
   * can 403. (Fix ported from Musify's youtube_explode fork.)
   */
  userAgent?: string
  /** Hi-res catalog artwork (JioSaavn 500×500) — persisted onto Track.thumbnail. */
  artUrl?: string
  /** True when served from the ranked cache (lets the route self-heal). */
  fromCache?: boolean
}

/** Map a provider name back to the UA that resolved it (for cached rows). */
const PROVIDER_UA: Record<string, string> = {
  ...Object.fromEntries(
    ['VISIONOS', 'IOS', 'TVHTML5', 'ANDROID_VR', 'IOS_MUSIC', 'ANDROID_MUSIC'].map((c) => [
      `innertube-${c.toLowerCase()}`,
      CLIENTS[c].userAgent,
    ]),
  ),
  'yt-dlp':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
}

const CACHE_TTL_MS = 30 * 60 * 1000
const SYNTH_TTL_MS = 30 * 60 * 1000
const WAVE1_CAP_MS = 4000
const YTDLP_FAIR_WAIT_MS = 7000

// Providers whose result is the REAL full-length recording.
const FULL_LENGTH_PROVIDERS = /^(jiosaavn|yt-dlp|innertube-|piped-|invidious-)/
const PREVIEW_PROVIDERS = /^(itunes-preview)$/
const SYNTH_PROVIDERS = /^(tsf-synth|demo-tone)$/

// Circuit-breaker cooldown: providers that failed within this window are
// skipped on subsequent resolutions, then automatically re-probed after it.
const PROVIDER_COOLDOWN_MS = 10 * 60 * 1000

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.drgns.space',
]

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
]

// ---------- health tracking ----------

async function reportHealth(provider: string, ok: boolean, latencyMs: number, error?: string) {
  try {
    await db.providerHealth.upsert({
      where: { provider },
      update: { ok, latencyMs, lastCheck: new Date(), lastError: ok ? null : (error ?? null) },
      create: { provider, ok, latencyMs, lastCheck: new Date(), lastError: error ?? null },
    })
  } catch {
    /* non-fatal */
  }
}

export async function getProviderHealth() {
  try {
    return await db.providerHealth.findMany()
  } catch {
    return []
  }
}

async function getRecentlyFailedProviders(): Promise<Set<string>> {
  try {
    const rows = await db.providerHealth.findMany({
      where: { ok: false, lastCheck: { gte: new Date(Date.now() - PROVIDER_COOLDOWN_MS) } },
    })
    return new Set(rows.map((r) => r.provider))
  } catch {
    return new Set()
  }
}

// ---------- memory LRU (globalThis: Turbopack dev-singleton) ----------

const MEM_MAX = 500

function memMap(): Map<string, StreamResult> {
  const g = globalThis as unknown as { __tsfStreamMem?: Map<string, StreamResult> }
  g.__tsfStreamMem ??= new Map()
  return g.__tsfStreamMem
}

function memSet(videoId: string, r: StreamResult) {
  const m = memMap()
  m.delete(videoId)
  m.set(videoId, r)
  if (m.size > MEM_MAX) {
    const first = m.keys().next().value
    if (first !== undefined) m.delete(first)
  }
}

function memGet(videoId: string): StreamResult | null {
  const m = memMap()
  const hit = m.get(videoId)
  if (!hit) return null
  if (hit.expiresAt <= Date.now() + 1000) {
    m.delete(videoId)
    return null
  }
  // refresh LRU position
  m.delete(videoId)
  m.set(videoId, hit)
  return { ...hit, fromCache: true }
}

// ---------- cache keys ----------

/** Short stable hash of the normalized title+artist (8 chars, base36). */
function titleHash(title: string, artist: string): string {
  const s = `${(title || '').toLowerCase().trim()}|${(artist || '').toLowerCase().trim()}`
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36).slice(0, 8).padStart(8, '0')
}

function cacheKeyFor(provider: string, videoId: string, title?: string, artist?: string): string {
  const titleBound = provider === 'jiosaavn' || provider === 'itunes-preview'
  return titleBound && title ? `${videoId}::${titleHash(title, artist || '')}` : videoId
}

function providerRank(provider: string): number {
  if (FULL_LENGTH_PROVIDERS.test(provider)) return 3
  if (PREVIEW_PROVIDERS.test(provider)) return 2
  if (SYNTH_PROVIDERS.test(provider)) return 1
  return 0
}

interface CacheRow {
  videoId: string
  url: string
  provider: string
  expiresAt: Date
  bitrate: number
  artUrl?: string | null
}

/**
 * RANKED cache lookup — the fix for the preview-shadowing bug.
 * Scans every row for this videoId (bare AND title-scoped) and returns the
 * best valid entry: full-length > preview > synth; higher bitrate wins ties.
 */
async function cacheLookup(videoId: string): Promise<StreamResult | null> {
  let rows: CacheRow[] = []
  try {
    rows = (await db.streamCache.findMany({
      where: {
        OR: [{ videoId }, { videoId: { startsWith: `${videoId}::` } }],
      },
    })) as unknown as CacheRow[]
  } catch {
    return null
  }
  const now = Date.now() + 1000
  let best: { row: CacheRow; rank: number } | null = null
  for (const row of rows) {
    if (new Date(row.expiresAt).getTime() <= now) continue
    const rank = providerRank(row.provider)
    if (
      !best ||
      rank > best.rank ||
      (rank === best.rank && (row.bitrate || 0) > (best.row.bitrate || 0))
    ) {
      best = { row, rank }
    }
  }
  if (!best) return null
  const row = best.row
  const isWav = SYNTH_PROVIDERS.test(row.provider)
  return {
    url: row.url,
    provider: row.provider,
    bitrate: row.bitrate || 0,
    expiresAt: new Date(row.expiresAt).getTime(),
    mime: isWav ? 'audio/wav' : 'audio/mp4',
    userAgent: PROVIDER_UA[row.provider],
    artUrl: row.artUrl ?? undefined,
    fromCache: true,
  }
}

/** Persist a resolved stream + upgrade side-effects (preview purge + catalog art). */
async function cacheResult(
  result: StreamResult,
  videoId: string,
  title?: string,
  artist?: string,
): Promise<void> {
  const key = cacheKeyFor(result.provider, videoId, title, artist)
  const isFull = FULL_LENGTH_PROVIDERS.test(result.provider)
  try {
    // A full-length result UPGRADES the videoId: drop any preview/synth rows
    // under every key so they can never shadow or resurface.
    if (isFull) {
      await db.streamCache.deleteMany({
        where: {
          AND: [
            {
              OR: [{ videoId }, { videoId: { startsWith: `${videoId}::` } }],
            },
            { provider: { in: ['itunes-preview', 'tsf-synth', 'demo-tone'] } },
          ],
        },
      })
    }
    await db.streamCache.upsert({
      where: { videoId: key },
      update: {
        url: result.url,
        provider: result.provider,
        bitrate: result.bitrate,
        expiresAt: new Date(result.expiresAt),
        artUrl: result.artUrl ?? null,
      },
      create: {
        videoId: key,
        url: result.url,
        provider: result.provider,
        bitrate: result.bitrate,
        expiresAt: new Date(result.expiresAt),
        artUrl: result.artUrl ?? null,
      },
    })
  } catch {
    /* cache is best-effort */
  }
  // Upgrade the Track's thumbnail to hi-res catalog art (at most one write
  // per change — guarded by the `not` filter).
  if (result.artUrl) {
    try {
      await db.track.updateMany({
        where: { id: videoId, thumbnail: { not: result.artUrl } },
        data: { thumbnail: result.artUrl },
      })
    } catch {
      /* non-fatal */
    }
  }
  memSet(videoId, { ...result, fromCache: undefined })
}

/** Drop ALL stream-cache rows + the memory LRU. Backs `POST /api/health?purge=1`. */
export async function purgeStreamCache(): Promise<{ db: number; mem: number }> {
  let dbCount = 0
  try {
    const r = await db.streamCache.deleteMany({})
    dbCount = r.count
  } catch {
    /* ignore */
  }
  const m = memMap()
  const memCount = m.size
  m.clear()
  return { db: dbCount, mem: memCount }
}

/** Delete just one videoId's rows (used by the route's stale-URL self-heal). */
export async function purgeVideoId(videoId: string) {
  try {
    await db.streamCache.deleteMany({
      where: { OR: [{ videoId }, { videoId: { startsWith: `${videoId}::` } }] },
    })
  } catch {
    /* ignore */
  }
  memMap().delete(videoId)
}

// ---------- expiry ----------

function computeExpiry(url: string): number {
  const fallback = Date.now() + CACHE_TTL_MS
  try {
    const exp = parseInt(new URL(url).searchParams.get('expire') || '', 10)
    if (Number.isFinite(exp) && exp > Date.now() / 1000) {
      return Math.max(Date.now() + 30_000, Math.min(fallback, (exp - 120) * 1000))
    }
  } catch {
    /* keep default TTL */
  }
  return fallback
}

// ---------- providers ----------

async function withHealth(
  name: string,
  fn: () => Promise<StreamResult | null>,
): Promise<StreamResult | null> {
  const t0 = Date.now()
  try {
    const r = await fn()
    await reportHealth(name, !!r, Date.now() - t0, r ? undefined : 'no result')
    return r
  } catch (e) {
    await reportHealth(name, false, Date.now() - t0, (e as Error).message)
    return null
  }
}

async function resolveInnertube(
  clientName: 'VISIONOS' | 'IOS' | 'TVHTML5' | 'ANDROID_VR' | 'IOS_MUSIC' | 'ANDROID_MUSIC',
  videoId: string,
): Promise<StreamResult | null> {
  const client = CLIENTS[clientName]
  const t0 = Date.now()
  try {
    const res = await fetch(`${client.host}/youtubei/v1/player?key=${client.key}&prettyPrint=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': client.userAgent,
        'X-Goog-Api-Format-Version': '2',
      },
      body: JSON.stringify({
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        context: { client: client.context },
      }),
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j: any = await res.json()
    if (j?.playabilityStatus?.status !== 'OK') throw new Error(j?.playabilityStatus?.status || 'not OK')

    const formats = [...(j.streamingData?.adaptiveFormats || []), ...(j.streamingData?.formats || [])]
    const rank = (m: string) => (m.includes('audio/mp4') ? 2 : m.includes('audio/webm') ? 1 : 0)
    const audio = formats
      .filter((f: any) => rank(f.mimeType || '') > 0 && f.url)
      .sort((a: any, b: any) => rank(b.mimeType) - rank(a.mimeType) || (b.bitrate || 0) - (a.bitrate || 0))[0]

    if (!audio?.url) throw new Error('no audio url')

    await reportHealth(`innertube-${clientName}`, true, Date.now() - t0)
    return {
      url: audio.url,
      provider: `innertube-${clientName.toLowerCase()}`,
      bitrate: audio.bitrate || 128000,
      expiresAt: computeExpiry(audio.url),
      mime: (audio.mimeType || 'audio/mp4').split(';')[0],
      userAgent: client.userAgent,
    }
  } catch (e) {
    await reportHealth(`innertube-${clientName}`, false, Date.now() - t0, (e as Error).message)
    return null
  }
}

async function resolvePiped(
  videoId: string,
  inCooldown?: (key: string) => boolean,
): Promise<StreamResult | null> {
  const instances = PIPED_INSTANCES.filter(
    (base) => !inCooldown || !inCooldown(`piped-${new URL(base).hostname}`),
  )
  if (instances.length === 0) return null
  const attempts = instances.map(async (base) => {
    const t0 = Date.now()
    try {
      const res = await fetch(`${base}/streams/${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(1500),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j: any = await res.json()
      const audio = (j.audioStreams || [])
        .filter((a: any) => a.mimeType?.includes('audio/mp4'))
        .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0]
      if (!audio?.url) throw new Error('no audio')
      await reportHealth(`piped-${new URL(base).hostname}`, true, Date.now() - t0)
      return {
        url: audio.url,
        provider: `piped-${new URL(base).hostname}`,
        bitrate: audio.bitrate || 128000,
        expiresAt: computeExpiry(audio.url),
        mime: 'audio/mp4',
      } as StreamResult
    } catch (e) {
      await reportHealth(`piped-${new URL(base).hostname}`, false, Date.now() - t0, (e as Error).message)
      throw e
    }
  })
  try {
    return await Promise.any(attempts)
  } catch {
    return null
  }
}

async function resolveInvidious(
  videoId: string,
  inCooldown?: (key: string) => boolean,
): Promise<StreamResult | null> {
  const instances = INVIDIOUS_INSTANCES.filter(
    (base) => !inCooldown || !inCooldown(`invidious-${new URL(base).hostname}`),
  )
  if (instances.length === 0) return null
  const attempts = instances.map(async (base) => {
    const t0 = Date.now()
    try {
      const res = await fetch(`${base}/api/v1/videos/${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(1500),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j: any = await res.json()
      const audio = (j.adaptiveFormats || [])
        .filter((a: any) => a.type?.includes('audio/mp4'))
        .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0]
      if (!audio?.url) throw new Error('no audio')
      await reportHealth(`invidious-${new URL(base).hostname}`, true, Date.now() - t0)
      return {
        url: audio.url,
        provider: `invidious-${new URL(base).hostname}`,
        bitrate: audio.bitrate || 128000,
        expiresAt: computeExpiry(audio.url),
        mime: 'audio/mp4',
      } as StreamResult
    } catch (e) {
      await reportHealth(`invidious-${new URL(base).hostname}`, false, Date.now() - t0, (e as Error).message)
      throw e
    }
  })
  try {
    return await Promise.any(attempts)
  } catch {
    return null
  }
}

// ---------- synth ----------

export function synthStreamUrl(videoId: string, durationSec: number): string {
  const dur = isFinite(durationSec) && durationSec > 0 ? `&dur=${Math.round(durationSec)}` : ''
  return `/api/stream/synth?id=${encodeURIComponent(videoId)}${dur}`
}

// ---------- helpers ----------

/** Resolve with the first non-null result, or null once all settle / cap hits. */
function firstSuccess<T>(promises: Promise<T | null>[], capMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    if (promises.length === 0) {
      resolve(null)
      return
    }
    let settled = false
    let pending = promises.length
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (v: T | null) => {
      if (settled) return
      if (v !== null) {
        settled = true
        if (timer) clearTimeout(timer)
        resolve(v)
      } else if (--pending <= 0) {
        settled = true
        if (timer) clearTimeout(timer)
        resolve(null)
      }
    }
    timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve(null)
      }
    }, capMs)
    for (const p of promises) {
      p.then(done, () => done(null))
    }
  })
}

/** Await a promise but give up (null) after capMs — never rejects. */
function raceTimeout<T>(p: Promise<T | null>, capMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), capMs)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

// ---------- in-flight dedup (globalThis) ----------

function inflightMap(): Map<string, Promise<StreamResult>> {
  const g = globalThis as unknown as { __tsfResolveInflight?: Map<string, Promise<StreamResult>> }
  g.__tsfResolveInflight ??= new Map()
  return g.__tsfResolveInflight
}

// ---------- main resolver ----------

export async function resolveStream(
  videoId: string,
  opts: { skipCache?: boolean; durationSec?: number; title?: string; artist?: string } = {}
): Promise<StreamResult> {
  if (!VIDEO_ID_RE.test(videoId)) {
    // Malformed id — synth guard (the route also 400s these).
    return {
      url: synthStreamUrl(videoId, opts.durationSec || 0),
      provider: 'tsf-synth',
      bitrate: 705600,
      expiresAt: Date.now() + SYNTH_TTL_MS,
      mime: 'audio/wav',
    }
  }

  // Join an identical in-flight resolve (burst of HEAD preflight + GET).
  const map = inflightMap()
  const existing = map.get(videoId)
  if (existing && !opts.skipCache) return existing

  const t0 = Date.now()
  const run = doResolve(videoId, opts)
  map.set(videoId, run)
  const cleanup = () => map.delete(videoId)
  run.then(cleanup, cleanup)
  return run

  async function doResolve(
    videoId: string,
    opts: { skipCache?: boolean; durationSec?: number; title?: string; artist?: string },
  ): Promise<StreamResult> {
    const { skipCache, durationSec = 0, title, artist } = opts
    const record = (r: StreamResult) => {
      recordResolve({
        ts: Date.now(),
        videoId,
        provider: r.provider,
        ms: Date.now() - t0,
        ok: !SYNTH_PROVIDERS.test(r.provider),
      })
      return r
    }

    // 1. Ranked cache lookup — full-length (any key) beats preview beats synth.
    if (!skipCache) {
      const hit = (await cacheLookup(videoId)) || memGet(videoId)
      if (hit) return record(hit)
    }

    // 2. Circuit breaker.
    const cooldownSet = await getRecentlyFailedProviders()
    const inCooldown = (key: string) => cooldownSet.has(key)

    let innertubeClients: Array<'VISIONOS' | 'IOS' | 'TVHTML5' | 'ANDROID_VR' | 'IOS_MUSIC' | 'ANDROID_MUSIC'> =
      (['VISIONOS', 'IOS', 'TVHTML5', 'ANDROID_VR', 'IOS_MUSIC', 'ANDROID_MUSIC'] as const).filter(
        (c) => !inCooldown(`innertube-${c}`),
      )
    if (innertubeClients.length === 0) innertubeClients = ['VISIONOS', 'IOS']
    if (!innertubeClients.includes('IOS') && !innertubeClients.includes('VISIONOS')) {
      innertubeClients = ['IOS', ...innertubeClients]
    }

    // 3. yt-dlp — started concurrently with wave 1. Even if wave 1 or the
    //    fair-wait window answers first, the background .then() warms the
    //    cache so the NEXT play of this track is full-length instantly.
    const ytdlpPromise = withHealth('yt-dlp', () => resolveYtDlp(videoId))
    const ytdlpWarm = ytdlpPromise.then(
      (r) => {
        if (r) cacheResult(r, videoId, title, artist)
        return r
      },
      () => null,
    )

    // 4. Wave 1 — fail-fast full-length race.
    const wave1 = firstSuccess(
      [
        ...(title
          ? [
              withHealth('jiosaavn', () =>
                resolveJioSaavn(videoId, title, artist || '', durationSec),
              ),
            ]
          : []),
        ...innertubeClients.map((c) => resolveInnertube(c, videoId)),
        resolvePiped(videoId, inCooldown),
        resolveInvidious(videoId, inCooldown),
      ],
      WAVE1_CAP_MS,
    )

    let full = await wave1

    // 5. Fair wait for yt-dlp before settling for a preview (fix #2).
    if (!full) {
      full = await raceTimeout(ytdlpWarm, YTDLP_FAIR_WAIT_MS)
    }

    if (full) {
      await cacheResult(full, videoId, title, artist)
      return record(full)
    }

    // 6. iTunes preview — REAL 30s clip, honestly labeled, short TTL.
    if (title) {
      try {
        const hit = await resolveITunesPreview(videoId, title, artist || '')
        if (hit) {
          await cacheResult(hit.stream, videoId, title, artist)
          return record(hit.stream)
        }
      } catch {
        /* fall through to synth */
      }
    }

    // 7. TSF Synth — last resort, short TTL so real providers re-probe.
    const synthResult: StreamResult = {
      url: synthStreamUrl(videoId, durationSec),
      provider: 'tsf-synth',
      bitrate: 705600,
      expiresAt: Date.now() + SYNTH_TTL_MS,
      mime: 'audio/wav',
    }
    await cacheResult(synthResult, videoId, title, artist)
    return record(synthResult)
  }
}

// ---------- provider probe (health dashboard "fresh") ----------

/**
 * Re-probe every provider with known reference tracks (8s cap). JioSaavn is
 * probed with an Indian reference (its catalog zone); everything else with
 * Rick Astley. Writes ProviderHealth rows for the dashboard.
 */
export async function probeAllProviders(): Promise<void> {
  const probe = async (name: string, fn: () => Promise<StreamResult | null>) => {
    try {
      await withHealth(name, fn)
    } catch {
      /* reported inside withHealth */
    }
  }
  const tasks: Promise<void>[] = [
    probe('jiosaavn', () => resolveJioSaavn('NJAv_7lHUIU', 'Kesariya', 'Arijit Singh', 269)),
    probe('itunes-preview', () =>
      resolveITunesPreview('dQw4w9WgXcQ', 'Never Gonna Give You Up', 'Rick Astley').then(
        (r) => r?.stream ?? null,
      ),
    ),
    probe('yt-dlp', () => resolveYtDlp('dQw4w9WgXcQ')),
    ...(['VISIONOS', 'IOS', 'TVHTML5', 'ANDROID_VR', 'IOS_MUSIC', 'ANDROID_MUSIC'] as const).map(
      (c) => probe(`innertube-${c}`, () => resolveInnertube(c, 'dQw4w9WgXcQ')),
    ),
  ]
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>((resolve) => setTimeout(resolve, 8000)),
  ])
}

// Re-export for the health route's ytdlp status block.
export { ytDlpBinary }
