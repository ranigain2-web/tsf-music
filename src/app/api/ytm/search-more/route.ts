/**
 * TSF Music — /api/ytm/search-more (F1 · search infinite pagination)
 *
 * Ported from the reference repo's v3.4.1: catalog keyword searches append
 * JioSaavn `search.getResults` pages (p=2,3,…) as the listener approaches
 * the end — THE REFERENCE'S EXACT DATA SOURCE, adapted so every appended
 * row is PLAYABLE in the web edition: rows carry `saavn-<id>` as their
 * videoId and /api/stream resolves catalog ids deterministically
 * (song.getDetails → DES decrypt → 320 kbps, no YouTube wall involved).
 *
 * Reference honest-pagination rules, kept intact:
 *   • rows deduped against caller-seen ids AND internally
 *   • <25% fresh page ⇒ end (their searchHasMore)
 *   • muted-artist parity (engine taste corrections)
 *   • language gate parity with the stream resolver (english/instrumental
 *     cover zone rows never appear — the resolver couldn't play them well)
 *   • a FAILED page is a transient error ({error:true}), never the end
 */
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const API = 'https://www.jiosaavn.com/api.php'
const FRESH_PAGE_RATIO = 0.25
const PAGE_SIZE = 30
const FETCH_TIMEOUT_MS = 3500

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
}

function decodeEntities(s: unknown): string {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

export interface MoreRow {
  id: string
  videoId: string
  title: string
  artistName: string
  albumName?: string
  duration: number
  thumbnail: string
  source: 'saavn'
  artistsFull?: string[]
  year?: number
  playCount?: number
  poolRank: number
}

export async function POST(req: NextRequest) {
  let body: { query?: string; page?: number; seenIds?: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ rows: [], end: true, note: 'bad request' }, { status: 400 })
  }
  const query = String(body.query ?? '').trim()
  const page = Math.max(2, Math.min(20, Math.round(Number(body.page ?? 2)) || 2))
  if (!query) return NextResponse.json({ rows: [], end: true })

  let raw: any[] = []
  try {
    const qs = new URLSearchParams({
      __call: 'search.getResults',
      q: query,
      p: String(page),
      n: '30',
      _format: 'json',
      _marker: '0',
      api_version: '4',
      ctx: 'web6dot0',
    })
    const res = await fetch(`${API}?${qs.toString()}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    raw = Array.isArray(j?.results) ? j.results : []
  } catch {
    // transient network death — honest retry, NOT the end (reference P1-1)
    return NextResponse.json({ rows: [], end: false, error: true })
  }

  // Muted-artist parity with the engine (S5 taste corrections).
  let muted: Set<string> | null = null
  try {
    const { loadCorrections } = await import('@/lib/mindbeat/profile')
    const corrections = await loadCorrections()
    if (corrections?.mutedArtists?.length) {
      muted = new Set(corrections.mutedArtists.map((m: string) => m.toLowerCase()))
    }
  } catch {
    muted = null
  }

  const seen = new Set<string>(Array.isArray(body.seenIds) ? body.seenIds.slice(0, 2000) : [])
  const rows: MoreRow[] = []
  for (const r of raw) {
    const id = String(r?.id ?? '')
    if (!id || seen.has(`saavn-${id}`)) continue
    const mi = r?.more_info ?? {}
    const lang = String(mi.language ?? '').toLowerCase()
    if (lang === 'english' || lang === 'instrumental') continue // resolver gate parity
    const primary: any[] = Array.isArray(mi.artistMap?.primary_artists) ? mi.artistMap.primary_artists : []
    const singers: any[] = Array.isArray(mi.artistMap?.singers) ? mi.artistMap.singers : []
    const artistsFull = primary.map((a) => (typeof a?.name === 'string' ? decodeEntities(a.name) : '')).filter(Boolean)
    const artist =
      artistsFull.length > 0
        ? artistsFull.join(', ')
        : decodeEntities(primary[0]?.name || singers[0]?.name || mi.primary_artists || r?.subtitle || 'Unknown artist')
    if (muted && (muted.has(artist.toLowerCase()) || artistsFull.some((a) => muted?.has(a.toLowerCase())))) continue
    const title = decodeEntities(r?.title ?? mi?.title ?? '')
    if (!title) continue
    rows.push({
      id: `saavn-${id}`,
      videoId: `saavn-${id}`, // playable — /api/stream?id=saavn-<id>
      title,
      artistName: artist,
      albumName: mi.album ? decodeEntities(mi.album) : undefined,
      duration: parseInt(mi.duration ?? '0', 10) || 0,
      thumbnail: String(mi.image ?? r?.image ?? '').replace(/([_-])(50x50|150x150)\.(jpg|jpeg|png|webp)/, '$1500x500.$3'),
      source: 'saavn',
      artistsFull: artistsFull.length ? artistsFull : undefined,
      year: parseInt(mi.year ?? '0', 10) || undefined,
      playCount: Number(r?.play_count ?? mi?.play_count ?? 0) || undefined,
      poolRank: rows.length,
    })
    if (rows.length >= PAGE_SIZE) break
  }

  const freshRatio = raw.length > 0 ? rows.length / raw.length : 0
  const end = raw.length === 0 || freshRatio < FRESH_PAGE_RATIO

  return NextResponse.json({
    rows,
    page,
    end,
    note: end && raw.length > 0 ? 'End of results' : undefined,
  })
}
