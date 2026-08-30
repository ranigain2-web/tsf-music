/**
 * SEARCH V2 · iTunes Search provider — RESCUE-ONLY (R1). Ported from the
 * reference engine (TSF-MUSIC v3.4 src/api/itunes.ts): Apple's public
 * search API needs no key and returns 30-second AAC previews plus
 * high-res artwork. Rows are truthfully `previewOnly` with a direct
 * `previewUrl` — "iTunes preview · 30 s", never masquerading as the full
 * recording. The official store carries no play metric, so rescue
 * authority is exempt for this rung (reference rule).
 */

import { itunesToRow, type SearchRow } from './rows'

const ITUNES = 'https://itunes.apple.com/search'
const SEARCH_TIMEOUT_MS = 3500

interface ITunesResult {
  trackId: number
  trackName: string
  artistName: string
  collectionName?: string
  previewUrl?: string
  artworkUrl100?: string
  trackTimeMillis?: number
}

export async function searchItunesRescue(
  query: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<SearchRow[]> {
  try {
    if (signal?.aborted) return []
    const qs = new URLSearchParams({
      term: query,
      media: 'music',
      entity: 'song',
      limit: String(limit),
    })
    const res = await fetch(`${ITUNES}?${qs.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })
    if (!res.ok) return []
    const data: { results?: ITunesResult[] } = await res.json()
    return (data.results ?? [])
      .map(itunesToRow)
      .filter((r): r is SearchRow => !!r)
  } catch {
    return [] // degraded is fine
  }
}
