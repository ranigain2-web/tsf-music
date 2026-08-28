/**
 * TSF Music — JioSaavn provider (REAL full-length 320 kbps audio)
 *
 * WHY THIS EXISTS:
 *   YouTube's SABR migration + per-IP bot-walling made every InnerTube client
 *   unreliable from many networks. JioSaavn's official web API (api.php) is
 *   keyless, stable, NOT bot-walled, and serves the FULL Indian/regional
 *   catalog as direct, range-capable, evergreen CDN URLs (aac.saavncdn.com)
 *   at 320 kbps AAC — verified full-length via ffprobe (268.165s for a
 *   269s YTM track) and 206 Partial Content from ANY IP (datacenter
 *   included).
 *
 * HOW MATCHING WORKS (anti-masquerade gates — each learned from a live bug):
 *   1. ARTIST GATE — only primary_artists + featured_artists + singers count.
 *      The generic artistMap.artists list carries songwriter/music credits
 *      ("Ed Sheeran" listed as composer on a Chill Darling COVER made the
 *      cover look like a match). A cover fails this gate.
 *   2. LANGUAGE GATE — language ∈ {english, instrumental} is rejected:
 *      that's the cover/remake zone for Indian songs. The real Indian
 *      recording is tagged hindi/punjabi/tamil/telugu/…
 *   3. DURATION GATE — |jiosaavn duration − YTM duration| ≤ 15s. Kills
 *      re-recordings (a haryanvi "Queen" re-recording of Bohemian Rhapsody
 *      was 45s+ off); legit catalog matches land within a few seconds.
 *   4. TITLE GATE — token-overlap ≥ 0.6 after junk stripping.
 *
 * URL DECRYPTION:
 *   api.php v4 returns encrypted_media_url = base64(DES-ECB(url, '38346591')).
 *   Node's OpenSSL build lacks des-ecb (legacy cipher), so we use des.js
 *   (pure JS). The _96 suffix is swapped to _320 when the 320kbps flag is
 *   set; the URL is then verified live with a 1-byte range probe (Azure
 *   sometimes omits content-type on HEAD, so a ranged GET is used and the
 *   content-type check is relaxed) before it is ever returned.
 *
 * URLs are evergreen static CDN objects (Last-Modified years old) — cached
 * for 7 days. Album art is upgraded to 500×500 (both _50x50.jpg and
 * -150x150.jpg suffix styles).
 */

import DES from 'des.js'
import type { StreamResult } from './stream'

const API = 'https://www.jiosaavn.com/api.php'
const DES_KEY = Buffer.from('38346591', 'utf8')
const SEARCH_TIMEOUT_MS = 3500
const PROBE_TIMEOUT_MS = 3000
const MATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days — evergreen CDN objects

const LANGUAGE_BLOCKLIST = new Set(['english', 'instrumental'])

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
}

// In-memory result cache (title+artist → StreamResult | null)
// null = "searched, no acceptable match" (negative cache, 30 min)
const MEM = new Map<string, StreamResult | null>()
const MEM_MAX = 2000
const NEG_TTL_MS = 30 * 60 * 1000
const memTs = new Map<string, number>()

function memGet(key: string): StreamResult | null | undefined {
  const ts = memTs.get(key) ?? 0
  const neg = MEM.get(key) === null
  if (Date.now() - ts > (neg ? NEG_TTL_MS : MATCH_TTL_MS)) return undefined
  return MEM.get(key)
}

function memSet(key: string, val: StreamResult | null) {
  if (MEM.size > MEM_MAX) {
    const firstKey = MEM.keys().next().value
    if (firstKey !== undefined) {
      MEM.delete(firstKey)
      memTs.delete(firstKey)
    }
  }
  MEM.set(key, val)
  memTs.set(key, Date.now())
}

// ---------- decryption ----------

export function decryptMediaUrl(enc: string): string {
  try {
    const data = Buffer.from(enc, 'base64')
    const d = (DES as any).DES.create({ type: 'decrypt', key: DES_KEY })
    const out = Buffer.from(d.update(data).concat(d.final()))
    return out.toString('utf8').replace(/[\u0000-\u001f\s]+$/g, '')
  } catch {
    return ''
  }
}

function upgradeBitrate(url: string, allow320: boolean): string {
  if (!allow320) return url
  return url.replace(/_96\.mp4$/, '_320.mp4')
}

/** 50x50 / 150x150 → 500x500 catalog art (handles _ and - separators). */
export function upgradeArt(url: string): string {
  if (!url) return url
  return url.replace(/([_-])(50x50|150x150)\.(jpg|jpeg|png|webp)/, '$1500x500.$3')
}

// ---------- matching ----------

function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/(official|video|audio|lyrics?|full song|lyrical|video song|music video|hd|4k)/g, ' ')
    .replace(/[^a-z0-9\u0900-\u097F\u0980-\u09FF\u0B80-\u0BFF\u0C00-\u0C7F\u0D00-\u0D7F\u0A00-\u0A7F\u0E00-\u0E7F ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .trim()
}

function tokens(s: string): string[] {
  return norm(s)
    .split(/\s+/)
    .filter((t) => t.length > 1)
}

function overlap(hayTokens: string[], needleTokens: string[]): number {
  if (needleTokens.length === 0) return 0
  let hit = 0
  for (const n of needleTokens) {
    if (hayTokens.some((h) => h === n || (h.length > 3 && n.length > 3 && (h.includes(n) || n.includes(h))))) hit++
  }
  return hit / needleTokens.length
}

/** Performers = primary_artists + featured_artists + singers (NOT the songwriter list). */
function performersOf(song: any): string[] {
  const am = song?.more_info?.artistMap ?? {}
  const names: string[] = []
  for (const key of ['primary_artists', 'featured_artists', 'singers']) {
    for (const a of am[key] ?? []) if (a?.name) names.push(String(a.name))
  }
  return names
}

interface MatchCandidate {
  song: any
  score: number
}

function bestMatch(songs: any[], title: string, artist: string, durationSec: number): MatchCandidate | null {
  const titleT = tokens(title)
  const artistT = tokens(artist)
  let best: MatchCandidate | null = null
  for (const song of songs) {
    const mi = song?.more_info ?? {}
    // Gate 2 — language
    const lang = String(mi.language ?? '').toLowerCase()
    if (LANGUAGE_BLOCKLIST.has(lang)) continue
    // Gate 1 — artist must be among PERFORMERS
    const performers = performersOf(song)
    const performerTokens = tokens(performers.join(' '))
    const artistScore = artistT.length > 0 ? overlap(performerTokens, artistT) : 0.5
    if (artistT.length > 0 && artistScore < 0.5) continue
    // Gate 4 — title
    const songTitleT = tokens(String(song?.title ?? ''))
    const titleScore =
      titleT.length > 0 ? Math.max(overlap(songTitleT, titleT), overlap(titleT, songTitleT)) : 0
    if (titleScore < 0.6) continue
    // Gate 3 — duration
    const jsDur = parseInt(String(mi.duration ?? '0'), 10) || 0
    const durDelta = durationSec > 0 && jsDur > 0 ? Math.abs(jsDur - durationSec) : 0
    if (durationSec > 0 && jsDur > 0 && durDelta > 15) continue
    // Composite score (duration as a scoring signal, not just a gate)
    const durScore = durationSec > 0 && jsDur > 0 ? Math.max(0, 1 - durDelta / 20) : 0.5
    const score = titleScore * 0.45 + artistScore * 0.35 + durScore * 0.2
    if (!best || score > best.score) best = { song, score }
  }
  return best
}

// ---------- URL verification ----------

async function verifyUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { ...HEADERS, Range: 'bytes=0-1' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    // Azure Blob omits content-type on HEAD; a ranged GET returning 206/200
    // with any body is proof enough the object exists.
    return res.status === 206 || res.status === 200
  } catch {
    return false
  }
}

// ---------- provider entry ----------

export async function resolveJioSaavn(
  videoId: string,
  title: string,
  artist: string,
  durationSec: number,
): Promise<StreamResult | null> {
  const key = `${videoId}|${norm(title)}|${norm(artist)}`
  const memo = memGet(key)
  if (memo !== undefined) return memo

  if (!title) return null
  try {
    const q = new URLSearchParams({
      __call: 'search.getResults',
      q: `${title} ${artist}`.trim(),
      _format: 'json',
      _marker: '0',
      api_version: '4',
      ctx: 'web6dot0',
    })
    const res = await fetch(`${API}?${q.toString()}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j: any = await res.json()
    const songs: any[] = j?.results ?? []
    if (!Array.isArray(songs) || songs.length === 0) {
      memSet(key, null)
      return null
    }

    const match = bestMatch(songs, title, artist, durationSec)
    if (!match) {
      memSet(key, null)
      return null
    }

    const mi = match.song.more_info ?? {}
    const enc = String(mi.encrypted_media_url ?? '')
    if (!enc) {
      memSet(key, null)
      return null
    }
    const base = decryptMediaUrl(enc)
    if (!base.startsWith('http')) {
      memSet(key, null)
      return null
    }

    const allow320 = String(mi['320kbps'] ?? '') === 'true' || mi['320kbps'] === true
    let url = upgradeBitrate(base, allow320)
    if (url !== base && !(await verifyUrl(url))) url = base // 320 tier missing → fall back to the signed 96 URL
    if (!(await verifyUrl(url))) {
      memSet(key, null)
      return null
    }

    const bitrate = url.includes('_320.') ? 320000 : 96000
    const artUrl = upgradeArt(String(match.song?.image ?? ''))

    const result: StreamResult = {
      url,
      provider: 'jiosaavn',
      bitrate,
      expiresAt: Date.now() + MATCH_TTL_MS,
      mime: 'audio/mp4',
      artUrl: artUrl || undefined,
    }
    memSet(key, result)
    return result
  } catch {
    // Negative-cache only hard no-match; network errors should retry next time.
    return null
  }
}
