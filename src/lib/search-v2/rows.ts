/**
 * SEARCH V2 · row model — the engine's unified candidate row.
 *
 * Web-adaptation note (see worklog): the reference RN engine had one
 * provider-agnostic `Track` type; the web edition's playable rows are
 * PlayerTrack-shaped (videoId/title/artistName/duration/thumbnail), so
 * every engine row CARRIES those fields as-is (rows are PlayerTrack-
 * compatible for the UI) plus the engine extras (score/matches/reason/
 * clusters/rescue labels). `videoId` is present for playable rows
 * (YT Music catalog + YouTube source); rescue rows that play through a
 * direct URL (iTunes 30 s preview) carry `previewUrl` + previewOnly +
 * `id` outside the videoId space, truthfully labelled.
 */

import type { YtmTrack } from '@/lib/ytm'

export type SearchSource = 'ytm' | 'youtube' | 'saavn' | 'itunes'

export interface SearchRow {
  /** Stable engine id: videoId for catalog/YouTube rows; 'itunes-<trackId>'
   *  for preview rescue rows. Engagement joins on this (ledger trackId). */
  id: string
  /** Playable id for the web player (/api/stream?id=…). Undefined only for
   *  rows that carry a direct stream URL instead (iTunes previews). */
  videoId?: string
  title: string
  artistName: string
  artistId?: string
  albumName?: string
  albumId?: string
  duration: number
  thumbnail: string
  year?: number
  explicit?: boolean
  source: SearchSource
  /** Full primary-artist list for matching/display (S3 + cluster unions) */
  artistsFull?: string[]
  featuredArtists?: string[]
  /** Popularity metric — parsed from the provider's count string/field.
   *  UNKNOWN stays undefined (the reference's unknown-metric rule). */
  playCount?: number
  playsRaw?: string
  has320?: boolean
  language?: string
  previewOnly?: boolean
  previewUrl?: string
  ytKind?: 'song' | 'video'
  /** First lyric line from the provider — free V1 lyric-verify signal */
  lyricsSnippet?: string
  // ---- engine extras (attached by S2/S3/rescue) ----
  pool?: string
  poolRank?: number
  score?: number
  artistMatch?: number
  queryMatch?: number
  reason?: string
  reasonCode?: string
  versionCount?: number
  lyricMatch?: boolean
  matchedLine?: string
  planKind?: string
  rescued?: boolean
  rescueRung?: string
}

// ---------------------------------------------------------------------------
// YTM catalog rows (our search() → YtmTrack) → SearchRow
// ---------------------------------------------------------------------------

/**
 * Parse a humanized count segment into a real number (ported verbatim from
 * the reference youtube.ts): "6.2M views" → 6_200_000 · "93K plays" →
 * 93_000 · "1.2 Cr" → 12_000_000 · "4.5 L" → 450_000. (The naive
 * strip-non-digits turned "6.2M" into 6 — the authority signal must read
 * the truth.)
 */
export function parseHumanCount(text: string | undefined): number | undefined {
  if (!text) return undefined
  const m = text.replace(/,/g, '').match(/([\d.]+)\s*(lakh|crore|cr|k|m|b|l)?/i)
  if (!m || m[1] === '' || m[1] === '.') return undefined
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return undefined
  const unit = (m[2] ?? '').toLowerCase()
  const mult =
    unit === 'k' ? 1e3 :
    unit === 'm' ? 1e6 :
    unit === 'b' ? 1e9 :
    unit === 'l' || unit === 'lakh' ? 1e5 :
    unit === 'cr' || unit === 'crore' ? 1e7 : 1
  return Math.round(n * mult)
}

/** Map one YT Music catalog row (our parse.ts YtmTrack) to an engine row.
 *  `plays` is the InnerTube humanized count string — parsed honestly;
 *  absent → playCount stays UNKNOWN (never zero-faked). */
export function ytmToRow(t: YtmTrack, i = 0): SearchRow {
  const artists = (t.artistName || '')
    .split(/,|&/)
    .map((a) => a.trim())
    .filter(Boolean)
  return {
    id: t.videoId,
    videoId: t.videoId,
    title: t.title,
    artistName: t.artistName || 'Unknown artist',
    artistId: t.artistId,
    albumName: t.albumName,
    albumId: t.albumId,
    duration: t.duration ?? 0,
    thumbnail: t.thumbnail ?? '',
    year: t.year,
    explicit: t.explicit,
    source: 'ytm',
    artistsFull: artists.length ? artists : undefined,
    playCount: parseHumanCount(t.plays),
    playsRaw: t.plays,
    planKind: undefined,
    poolRank: i,
  }
}

/** Map iTunes search results (rescue R1) — 30 s preview rows with a
 *  direct previewUrl. Truthfully previewOnly; NO faked videoId. */
export function itunesToRow(r: {
  trackId: number
  trackName: string
  artistName: string
  collectionName?: string
  previewUrl?: string
  artworkUrl100?: string
  trackTimeMillis?: number
}): SearchRow | null {
  if (!r.previewUrl) return null
  return {
    id: `itunes-${r.trackId}`,
    title: r.trackName,
    artistName: r.artistName,
    albumName: r.collectionName,
    duration: 30,
    thumbnail: (r.artworkUrl100 ?? '').replace('100x100bb', '600x600bb'),
    source: 'itunes',
    previewUrl: r.previewUrl,
    previewOnly: true,
  }
}

/** Map JioSaavn search.getResults rows (authority/verification provider —
 *  the same endpoint our stream resolver uses). These rows are the ONLY
 *  ones carrying a reliable playCount + lyricsSnippet + full credit list,
 *  so they power the AUTHORITY_FLOOR math and V1 lyric verification.
 *  They surface as FINAL ROWS only via the thin-pool fallback, where the
 *  UI's title-based stream resolve plays them (resolveJioSaavn matches by
 *  title/artist). */
export function saavnToRow(raw: any, i = 0): SearchRow | null {
  const id = String(raw?.id ?? '')
  if (!id) return null
  const mi = raw?.more_info ?? {}
  const am = mi.artistMap ?? {}
  const primaryList: any[] = Array.isArray(am.primary_artists) ? am.primary_artists : []
  const featuredList: any[] = Array.isArray(am.featured_artists) ? am.featured_artists : []
  const singers: any[] = Array.isArray(am.singers) ? am.singers : []
  const artistsFull = primaryList
    .map((a) => (typeof a?.name === 'string' ? decodeEntities(a.name) : ''))
    .filter(Boolean)
  const artist =
    artistsFull.length > 0
      ? artistsFull.join(', ')
      : primaryList[0]?.name || singers[0]?.name || mi.primary_artists || raw?.subtitle || 'Unknown artist'
  const art = String(mi.image ?? raw?.image ?? '')
  return {
    id: `saavn-${id}`,
    title: decodeEntities(raw?.title ?? mi?.title ?? 'Unknown'),
    artistName: decodeEntities(String(artist)),
    artistId: primaryList[0]?.id ? String(primaryList[0].id) : undefined,
    albumName: mi?.album ?? raw?.album ?? undefined,
    albumId: String(mi?.album_id ?? '') || undefined,
    duration: parseInt(mi?.duration ?? '0', 10) || 0,
    thumbnail: art.replace(/([_-])(50x50|150x150)\.(jpg|jpeg|png|webp)/, '$1500x500.$3'),
    source: 'saavn',
    artistsFull: artistsFull.length ? artistsFull : undefined,
    featuredArtists: featuredList
      .map((a) => (typeof a?.name === 'string' ? decodeEntities(a.name) : ''))
      .filter(Boolean),
    has320: mi?.['320kbps'] === 'true' || undefined,
    language: String(mi?.language ?? '').toLowerCase() || undefined,
    year: parseInt(mi?.year ?? '0', 10) || undefined,
    playCount: Number(raw?.play_count ?? mi?.play_count ?? 0) || undefined,
    lyricsSnippet:
      typeof mi?.lyrics_snippet === 'string' && mi.lyrics_snippet
        ? decodeEntities(mi.lyrics_snippet)
        : undefined,
    poolRank: i,
  }
}

function decodeEntities(s: string): string {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}
