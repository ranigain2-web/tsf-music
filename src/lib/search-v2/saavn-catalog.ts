/**
 * SEARCH V2 · JioSaavn catalog client — the AUTHORITY + VERIFICATION
 * provider. Ported from the reference engine (TSF-MUSIC v3.4
 * src/api/saavn.ts search/album sections), adapted to the web edition:
 *
 * Our primary catalog is YT Music (playable videoIds); JioSaavn's
 * search.getResults is the ONLY reachable source of (a) reliable
 * playCount numbers (AUTHORITY_FLOOR math), (b) lyrics snippets (V1
 * lyric verification), (c) the full primary-artist credit list (version
 * clustering unions). Rows ALSO serve as the thin-pool fallback where
 * the player's title-based stream resolve (resolveJioSaavn) plays them.
 *
 * Failure contract: every call degrades to [] — never throws outward.
 */

const API = 'https://www.jiosaavn.com/api.php'
const SEARCH_TIMEOUT_MS = 3500

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
}

/** LRU-40 result cache (5 min) — probe fan-outs repeat strings often. */
const CACHE_MAX = 40
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; rows: SearchRow[] }>()

import { saavnToRow, type SearchRow } from './rows'

function cacheGet(key: string): SearchRow[] | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  cache.delete(key)
  cache.set(key, hit) // refresh recency
  return hit.rows
}

function cacheSet(key: string, rows: SearchRow[]): void {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, { at: Date.now(), rows })
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

async function saavnGet(params: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const qs = new URLSearchParams({ _format: 'json', _marker: '0', api_version: '4', ctx: 'web6dot0', ...params })
  const res = await fetch(`${API}?${qs.toString()}`, {
    headers: HEADERS,
    signal: signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`saavn http ${res.status}`)
  return res.json()
}

/** search.getResults → mapped rows (skip language-blocked english/
 *  instrumental — the cover/remake zone, same gate as the stream resolver). */
export async function searchSaavnCatalog(
  query: string,
  limit = 30,
  signal?: AbortSignal,
): Promise<SearchRow[]> {
  const key = `s:${query.toLowerCase()}|${limit}`
  const hit = cacheGet(key)
  if (hit) return hit
  try {
    const data = await saavnGet({ __call: 'search.getResults', q: query, p: '1', n: String(limit) }, signal)
    const results = Array.isArray(data?.results) ? data.results : []
    const rows = results
      .map((r: any, i: number) => {
        const row = saavnToRow(r, i)
        if (!row) return null
        const lang = String(row.language ?? '').toLowerCase()
        if (lang === 'english' || lang === 'instrumental') return null
        return row
      })
      .filter((r: SearchRow | null): r is SearchRow => !!r)
    cacheSet(key, rows)
    return rows
  } catch {
    return [] // degraded is fine — the caller decides thin/zero honestly
  }
}

/** Album search (rescue R2 route). */
export interface SaavnAlbum {
  id: string
  title: string
  subtitle?: string
  thumbnail?: string
}

export async function searchAlbumResults(
  query: string,
  limit = 3,
  signal?: AbortSignal,
): Promise<SaavnAlbum[]> {
  try {
    const data = await saavnGet({ __call: 'search.getAlbumResults', q: query, p: '1', n: String(limit) }, signal)
    const results = Array.isArray(data?.results) ? data.results : []
    return results
      .map((r: any) => ({
        id: String(r?.id ?? ''),
        title: String(r?.title ?? ''),
        subtitle: String(r?.more_info?.primary_artists ?? r?.sub_title ?? '') || undefined,
        thumbnail: String(r?.image ?? ''),
      }))
      .filter((a: SaavnAlbum) => a.id && a.title)
  } catch {
    return []
  }
}

/** Album detail → its tracks (rescue R2; the exists-but-not-in-song-
 *  search class). */
export async function getAlbumTracks(
  albumId: string,
  signal?: AbortSignal,
): Promise<SearchRow[]> {
  try {
    const data = await saavnGet({ __call: 'content.getAlbumDetails', albumid: albumId }, signal)
    const songs: any[] = Array.isArray(data?.songs) ? data.songs : []
    return songs
      .map((s: any, i: number) => saavnToRow({ ...s, play_count: s?.play_count ?? s?.more_info?.play_count }, i))
      .filter((r: SearchRow | null): r is SearchRow => !!r)
  } catch {
    return []
  }
}
