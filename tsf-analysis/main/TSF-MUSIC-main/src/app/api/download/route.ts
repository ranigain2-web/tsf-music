/**
 * TSF Music — /api/download
 * Spotify-style "Download" — streams the track's audio as a downloadable
 * attachment so the browser saves it to disk.
 *
 * Resolution:
 *   1. Resolve via the same provider chain as /api/stream (full YouTube
 *      chain in parallel FIRST → iTunes preview → TSF Synth).
 *   2. On a clean residential IP this is the FULL-LENGTH official audio
 *      (googlevideo m4a, typically 128kbps AAC) fetched server-side and
 *      streamed as an .m4a attachment.
 *   3. On bot-blocked IPs: iTunes 30s real clip as .m4a, or the TSF Synth
 *      full-length track as .wav (rendered progressively).
 *
 * The filename is built from ?title= + ?artist= (sanitised). ?dur= (track
 * duration in seconds) is forwarded so the synth engine renders the track's
 * real length.
 */
import { NextRequest } from 'next/server'
import { resolveStream } from '@/lib/ytm/stream'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function sanitizeFilename(s: string): string {
  return (s || 'track').replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'track'
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const videoId = searchParams.get('id') || ''
  const title = searchParams.get('title') || 'track'
  const artist = searchParams.get('artist') || ''
  const durParam = parseFloat(searchParams.get('dur') || '0') || 0

  if (!videoId) return new Response('missing id', { status: 400 })

  const resolved = await resolveStream(videoId, {
    durationSec: durParam,
    title: title || undefined,
    artist: artist || undefined,
  })
  const safe = sanitizeFilename(artist ? `${artist} - ${title}` : title)

  if (resolved.provider === 'tsf-synth') {
    // Render the full-length synth track and stream it as an attachment.
    const { buildPlan } = await import('@/lib/synth/arrangement')
    const { synthStreamResponse } = await import('@/lib/synth/render')
    const plan = buildPlan(videoId, durParam)
    // Build a plain Request so range parsing sees a full-file request
    const res = synthStreamResponse(plan, new Request(req.url, { method: 'GET' }))
    const headers = new Headers(res.headers)
    headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(safe)}.wav"`)
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
    headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(safe)}.wav"`)
    headers.set('Content-Type', 'audio/wav')
    return new Response(body, { status: 200, headers })
  }

  // iTunes REAL-audio preview (or any real upstream) — fetch server-side and
  // stream as an .m4a attachment. This is the ACTUAL studio recording.
  // NOTE: googlevideo rejects range-less full-file GETs with 403, so we always
  // ask for the FULL byte space explicitly (Range: bytes=0-). And the fetch
  // MUST carry the User-Agent of the client that resolved the URL —
  // googlevideo signatures are UA-tied for app-style InnerTube clients
  // (Musify-ported fix; generic UAs trigger 403s).
  try {
    const upstream = await fetch(resolved.url, {
      headers: {
        'User-Agent': resolved.userAgent || 'Mozilla/5.0 (TSF Music)',
        Range: 'bytes=0-',
      },
      // googlevideo can throttle to ~realtime — allow a full song to trickle.
      signal: AbortSignal.timeout(15 * 60 * 1000),
    }).catch(() => null)

    if (!upstream || !upstream.ok) {
      return new Response('upstream failed', { status: 502 })
    }

    const buf = await upstream.arrayBuffer()
    const headers = new Headers()
    headers.set('Content-Type', 'audio/mp4')
    headers.set('Content-Length', String(buf.byteLength))
    headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(safe)}.m4a"`)
    headers.set('X-Stream-Provider', resolved.provider)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(buf, { status: 200, headers })
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
    const resolved = await resolveStream(videoId, {
      durationSec: parseFloat(searchParams.get('dur') || '0') || 0,
      title: searchParams.get('title') || undefined,
      artist: searchParams.get('artist') || undefined,
    })
    const h = new Headers()
    h.set('Accept-Ranges', 'bytes')
    h.set('X-Stream-Provider', resolved.provider)
    if (resolved.provider === 'tsf-synth' || resolved.provider === 'demo-tone') {
      return new Response(null, { status: 200, headers: h })
    }
    const upstream = await fetch(resolved.url, {
      headers: { 'User-Agent': resolved.userAgent || 'Mozilla/5.0 (TSF Music)', Range: 'bytes=0-0' },
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
