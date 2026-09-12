/**
 * TSF Music — /api/download
 * "Save a copy" — streams the track's audio as a downloadable attachment.
 *
 * Resolution:
 *   1. `saavn-<id>` rows resolve through JioSaavn's catalog DIRECTLY (those ids
 *      are not YouTube ids, so the normal chain would treat them as malformed
 *      and fall back to the synth — which used to mean every paginated search
 *      row downloaded as a fabricated track).
 *   2. Everything else goes through the same provider chain as /api/stream
 *      (full YouTube chain in parallel FIRST → iTunes preview → TSF Synth).
 *   3. On a clean residential IP that is the FULL-LENGTH official audio
 *      (googlevideo m4a, ~128 kbps AAC).
 *
 * The upstream body is passed STRAIGHT THROUGH. Buffering it first meant the
 * client saw no Content-Length and no bytes until the server held the whole
 * file (and googlevideo can trickle at ~realtime), so a download looked like a
 * dead button for a minute and then silently produced a file. Streaming gives
 * the client a real length up front and real progress from the first byte.
 */
import { NextRequest } from 'next/server'
import { resolveStream, noteUserResolve, type StreamResult } from '@/lib/ytm/stream'
import { resolveSaavnById } from '@/lib/ytm/jiosaavn'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** F1 pagination rows: `saavn-<id>` resolves by catalog id (no YT wall). */
const SAAVN_ID_RE = /^saavn-[a-zA-Z0-9_-]{4,20}$/

/** Fallback UA when a cached row did not carry the resolving client's. */
const DEFAULT_UA = 'Mozilla/5.0 (TSF Music)'

function sanitizeFilename(s: string): string {
  return (s || 'track').replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'track'
}

/**
 * RFC 6266 / RFC 5987 Content-Disposition.
 *
 * The old code put `encodeURIComponent(name)` inside a plain quoted
 * `filename=`, so a real title landed on disk as "Arijit%20Singh%20-%20…".
 * A quoted-ASCII fallback plus the UTF-8 `filename*` form is the correct pair:
 * the fallback is for legacy clients, `filename*` is what browsers use.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function extFor(mime: string): string {
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  return 'm4a'
}

function normalizeMime(mime: string): string {
  if (mime.includes('wav')) return 'audio/wav'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'audio/mpeg'
  return 'audio/mp4'
}

/**
 * Resolve a track for download. `saavn-<id>` first: those ids fail the
 * YouTube id shape, so `resolveStream` would degrade them to the synthesizer
 * and hand the user a generated song instead of the one they asked for.
 */
async function resolveForDownload(
  videoId: string,
  title: string,
  artist: string,
  durationSec: number,
): Promise<StreamResult> {
  if (SAAVN_ID_RE.test(videoId)) {
    // Foreground stamp: this branch answers from the catalog without going
    // through resolveStream, and a download is unambiguously user-initiated.
    noteUserResolve()
    const saavn = await resolveSaavnById(videoId).catch(() => null)
    if (saavn) return saavn
  }
  return resolveStream(videoId, {
    durationSec,
    title: title || undefined,
    artist: artist || undefined,
  })
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const videoId = searchParams.get('id') || ''
  const title = searchParams.get('title') || 'track'
  const artist = searchParams.get('artist') || ''
  const durParam = parseFloat(searchParams.get('dur') || '0') || 0

  if (!videoId) return new Response('missing id', { status: 400 })

  const resolved = await resolveForDownload(videoId, title, artist, durParam)
  const safe = sanitizeFilename(artist ? `${artist} - ${title}` : title)

  if (resolved.provider === 'tsf-synth') {
    // Render the full-length synth track and stream it as an attachment.
    const { buildPlan } = await import('@/lib/synth/arrangement')
    const { synthStreamResponse } = await import('@/lib/synth/render')
    const plan = buildPlan(videoId, durParam)
    // Build a plain Request so range parsing sees a full-file request
    const res = synthStreamResponse(plan, new Request(req.url, { method: 'GET' }))
    const headers = new Headers(res.headers)
    headers.set('Content-Disposition', contentDisposition(`${safe}.wav`))
    headers.set('Content-Type', 'audio/wav')
    headers.set('X-Download-Duration', String(plan.durationSec))
    headers.set('X-Download-Genre', plan.genre)
    return new Response(res.body, { status: res.status, headers })
  }

  if (resolved.provider === 'demo-tone') {
    // Legacy cached demo-tone entry — serve until it expires.
    const demoUrl = new URL('/api/stream/demo', req.url)
    demoUrl.searchParams.set('id', videoId)
    const demoReq = new Request(demoUrl.toString())
    const { GET: demoGET } = await import('../stream/demo/route')
    const demoRes = await demoGET(demoReq as unknown as NextRequest)
    const body = await demoRes.arrayBuffer()
    const headers = new Headers(demoRes.headers)
    headers.set('Content-Disposition', contentDisposition(`${safe}.wav`))
    headers.set('Content-Type', 'audio/wav')
    return new Response(body, { status: 200, headers })
  }

  // Real audio (JioSaavn / googlevideo / iTunes preview) — stream it through.
  // NOTE: googlevideo rejects range-less full-file GETs with 403, so always ask
  // for the FULL byte space explicitly (Range: bytes=0-), and carry the UA of
  // the client that resolved the URL (googlevideo signatures are UA-tied for
  // app-style InnerTube clients; a generic UA triggers 403s).
  try {
    const upstream = await fetch(resolved.url, {
      headers: {
        'User-Agent': resolved.userAgent || DEFAULT_UA,
        Range: 'bytes=0-',
      },
      // googlevideo can throttle to ~realtime — allow a full song to trickle.
      signal: AbortSignal.timeout(15 * 60 * 1000),
    }).catch(() => null)

    if (!upstream || !upstream.ok || !upstream.body) {
      return new Response('upstream failed', { status: 502 })
    }

    const mime = normalizeMime(upstream.headers.get('content-type') || 'audio/mp4')
    const headers = new Headers()
    headers.set('Content-Type', mime)
    const upstreamLen = upstream.headers.get('content-length')
    if (upstreamLen) headers.set('Content-Length', upstreamLen)
    headers.set('Content-Disposition', contentDisposition(`${safe}.${extFor(mime)}`))
    headers.set('X-Stream-Provider', resolved.provider)
    headers.set('X-Stream-Bitrate', String(resolved.bitrate || 0))
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Cache-Control', 'no-store')
    return new Response(upstream.body, { status: 200, headers })
  } catch (e) {
    return new Response(`download failed: ${(e as Error).message}`, { status: 502 })
  }
}

export async function HEAD(req: NextRequest) {
  // Cheap headers-only probe (curl -I / link checkers): resolve the stream and
  // ask the upstream for a single byte instead of buffering the whole song.
  const { searchParams } = new URL(req.url)
  const videoId = searchParams.get('id') || ''
  if (!videoId) return new Response(null, { status: 400 })
  try {
    const resolved = await resolveForDownload(
      videoId,
      searchParams.get('title') || 'track',
      searchParams.get('artist') || '',
      parseFloat(searchParams.get('dur') || '0') || 0,
    )
    const h = new Headers()
    h.set('Accept-Ranges', 'bytes')
    h.set('X-Stream-Provider', resolved.provider)
    if (resolved.provider === 'tsf-synth' || resolved.provider === 'demo-tone') {
      return new Response(null, { status: 200, headers: h })
    }
    const upstream = await fetch(resolved.url, {
      headers: { 'User-Agent': resolved.userAgent || DEFAULT_UA, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null)
    if (!upstream || !upstream.ok) return new Response(null, { status: 502 })
    const cr = upstream.headers.get('content-range') // "bytes 0-0/<total>"
    if (cr) h.set('X-Content-Range', cr)
    return new Response(null, { status: 200, headers: h })
  } catch {
    return new Response(null, { status: 502 })
  }
}
