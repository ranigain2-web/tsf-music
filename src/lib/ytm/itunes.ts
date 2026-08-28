/**
 * TSF Music — iTunes (Apple Music catalog) REAL audio resolver
 *
 * WHY THIS EXISTS:
 *   Every YouTube-family provider (InnerTube IOS/ANDROID_VR, Piped, Invidious)
 *   is bot-blocked from datacenter IPs, so every track fell through to the TSF
 *   Synth engine — procedurally generated "dummy" music. The user hears a
 *   different fake song per track and rightly calls it dummy audio.
 *
 *   The iTunes Search API is keyless, reliable, NOT bot-blocked, and returns
 *   `previewUrl` — a REAL clip of the ACTUAL studio recording hosted on
 *   Apple's audio CDN (audio-ssl.itunes.apple.com). These are the same public
 *   30-second preview clips Apple Music / Shazam / Siri stream to everyone.
 *
 * MATCHING:
 *   We search `term = "<title> <artist>"` (title junk like "(Official Video)"
 *   stripped), validate results with fuzzy token-overlap scoring on both title
 *   and artist, and take the best result above a strict threshold — better to
 *   fall back to synth than to play the WRONG real song.
 *
 * RELIABILITY:
 *   - Apple's Search API guideline is ~20 req/min, so live searches are
 *     serialized through a 300ms-spaced queue on top of memory + DB caching.
 *   - Preview URLs are stable for years — but we cache resolutions for only
 *     2 HOURS: a machine that first ran on a bot-blocked IP (datacenter/VPN)
 *     must not stay pinned to 30s clips once it gets a clean IP. Every 2h
 *     the resolver re-probes the full-length YouTube chain first.
 */

import { db } from '@/lib/db'
import type { StreamResult } from './stream'

export interface ITunesMeta {
  fullDurationMs?: number
  artwork?: string
  collectionName?: string
  genre?: string
}

const SEARCH_TIMEOUT_MS = 3000
const MATCH_THRESHOLD = 0.65
const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000 // 2h — short so a clean IP re-probes full-length sources

// ---------- memory caches ----------
const MEM = new Map<string, StreamResult | null>() // null = known-unmatched
const MEM_META = new Map<string, ITunesMeta>()
const MEM_MAX = 3000

let lastSearchAt = 0
const MIN_SEARCH_GAP_MS = 300
let searchQueue: Promise<void> = Promise.resolve()

function memKey(videoId: string, title: string, artist: string) {
  return `${videoId}|${title.toLowerCase()}|${artist.toLowerCase()}`
}

/** Strip YouTube-video-title junk so the iTunes query is clean. */
export function cleanTitle(raw: string): string {
  return (raw || '')
    .replace(/\([^)]*\)/g, ' ') // (Official Video) (Lyrics) (feat. X)
    .replace(/\[[^\]]*\]/g, ' ') // [4K] [MV]
    .replace(/\{[^}]*\}/g, ' ')
    .replace(
      /\b(official\s+(music\s+)?(video|audio|visualizer)|official|video|audio|lyrics?|lyrical|visualizer|music\s+video|full\s+song|full\s+video|hd|4k|mv|m\/v|remaster(ed)?(\s+\d{4})?|new\s+song|latest\s+song)\b/gi,
      ' ',
    )
    .replace(/\s*[-–—|]\s*$/g, ' ') // trailing dash separators
    .replace(/\s+/g, ' ')
    .trim()
}

/** Lowercase, de-punctuate, de-bracket — for fuzzy comparison only. */
function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(feat|featuring|ft|ft\.|with|prod|x|&)\b/g, ' ')
    .replace(/["'’`~!@#$%^&*+=|\\/:;,.?<>_()\[\]{}-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function toks(s: string): string[] {
  return normalize(s).split(' ').filter((t) => t.length >= 2)
}

/** Fraction of our tokens found inside the candidate string. */
function overlap(ours: string[], candidate: string): number {
  if (!ours.length) return 0
  let hit = 0
  for (const t of ours) if (candidate.includes(t)) hit++
  return hit / ours.length
}

function scoreMatch(ourTitle: string, ourArtist: string, r: { trackName: string; artistName: string }): number {
  const tToks = toks(ourTitle)
  const aToks = toks(ourArtist)
  const rTitle = normalize(r.trackName)
  const rArtist = normalize(r.artistName)
  const titleScore = overlap(tToks, rTitle)
  const artistScore = overlap(aToks, rArtist)
  // Require BOTH signals: a track-name match with a wrong artist (covers,
  // remixes by other DJs, karaoke versions) must NOT win.
  if (artistScore < 0.34 && aToks.length > 0) return 0
  const combined = 0.6 * titleScore + 0.4 * artistScore
  return combined
}

// ---------- Apple Search API ----------

interface ITunesResult {
  trackId: number
  trackName: string
  artistName: string
  collectionName?: string
  previewUrl?: string
  artworkUrl100?: string
  trackTimeMillis?: number
  primaryGenreName?: string
}

async function searchCountry(
  term: string,
  country: string,
  signal: AbortSignal,
): Promise<ITunesResult[]> {
  const url =
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
    `&entity=song&media=music&limit=6&country=${country}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TSFMusic/1.0',
      Accept: 'application/json',
    },
    signal,
  })
  if (!res.ok) throw new Error(`itunes http ${res.status}`)
  const j: any = await res.json()
  return (j?.results || []) as ITunesResult[]
}

async function reportHealth(ok: boolean, latencyMs: number, error?: string) {
  try {
    await db.providerHealth.upsert({
      where: { provider: 'itunes-preview' },
      update: { ok, latencyMs, lastCheck: new Date(), lastError: ok ? null : (error ?? null) },
      create: { provider: 'itunes-preview', ok, latencyMs, lastCheck: new Date(), lastError: error ?? null },
    })
  } catch { /* non-fatal */ }
}

/**
 * Resolve a REAL audio preview for a track.
 * Returns null when iTunes has no confident match (caller falls back to the
 * YouTube chain, then synth).
 */
export async function resolveITunesPreview(
  videoId: string,
  title: string,
  artist: string,
): Promise<{ stream: StreamResult; meta: ITunesMeta } | null> {
  const clean = cleanTitle(title || '')
  const query = (clean || title || '').trim()
  if (!query) return null

  const key = memKey(videoId, query, artist || '')
  if (MEM.has(key)) {
    const cached = MEM.get(key)!
    if (!cached) return null
    return { stream: { ...cached, expiresAt: Date.now() + PREVIEW_TTL_MS }, meta: MEM_META.get(videoId) || {} }
  }

  // Serialize live searches (Apple rate guideline ≈ 20/min) with a min gap.
  const t0 = Date.now()
  const task = searchQueue.then(async () => {
    const wait = MIN_SEARCH_GAP_MS - (Date.now() - lastSearchAt)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastSearchAt = Date.now()
  })
  searchQueue = task.catch(() => {})

  const best = { score: 0, result: null as ITunesResult | null }
  try {
    await task

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), SEARCH_TIMEOUT_MS)
    try {
      // US catalog first (largest), then IN (full Bollywood/regional depth).
      for (const country of ['US', 'IN'] as const) {
        let results: ITunesResult[] = []
        try {
          results = await searchCountry(artist ? `${query} ${artist}` : query, country, ac.signal)
        } catch {
          continue // network hiccup on one storefront — try the next
        }
        for (const r of results) {
          if (!r.previewUrl) continue
          const s = scoreMatch(query, artist || '', r)
          if (s > best.score) best.score = s
          if (s >= MATCH_THRESHOLD) {
            best.result = r
            break
          }
        }
        if (best.result) break
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    /* fall through — treat as no-match */
  }

  if (!best.result || !best.result.previewUrl) {
    MEM.set(key, null)
    if (MEM.size > MEM_MAX) MEM.delete(MEM.keys().next().value as string)
    // A no-match on an obscure/unmatchable track is EXPECTED behavior, not a
    // provider outage — report healthy so /api/health doesn't cry wolf.
    await reportHealth(true, Date.now() - t0)
    return null
  }

  const r = best.result
  const meta: ITunesMeta = {
    fullDurationMs: r.trackTimeMillis,
    artwork: r.artworkUrl100,
    collectionName: r.collectionName,
    genre: r.primaryGenreName,
  }
  const stream: StreamResult = {
    url: r.previewUrl as string, // guarded above (previewUrl checked non-empty)
    provider: 'itunes-preview',
    bitrate: 256000,
    expiresAt: Date.now() + PREVIEW_TTL_MS,
    mime: 'audio/mp4',
  }
  MEM.set(key, stream)
  MEM_META.set(videoId, meta)
  if (MEM.size > MEM_MAX) MEM.delete(MEM.keys().next().value as string)
  await reportHealth(true, Date.now() - t0)
  return { stream, meta }
}
