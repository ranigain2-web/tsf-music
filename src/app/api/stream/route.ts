/**
 * TSF Music — /api/stream (v3)
 * Range-aware audio resolver. Resolution order (inside resolveStream):
 *   1. Ranked cache — a full-length row under ANY key always beats a
 *      preview/synth row (fixes the preview-shadowing field report).
 *   2. Wave 1 fail-fast race: JioSaavn (320 kbps, any IP) + InnerTube chain
 *      + relay seeds.
 *   3. yt-dlp subprocess — fair-waited 7s, background cache-warming.
 *   4. iTunes REAL-audio preview (30s clip, honestly labeled).
 *   5. TSF Synth engine — procedural last resort.
 *
 * CRITICAL: For real upstream URLs we 307-redirect the browser DIRECTLY to
 * the resolved URL (desktop). Phones use ?proxy=1 — a same-origin byte
 * stream with Range passthrough (sidesteps WebKit redirect+CORS+IP-bound
 * URL fragility; the Mac fetches from its verified residential IP).
 *
 * SELF-HEAL (new): if a CACHED upstream URL fails to pipe (expired
 * googlevideo signature / IP change mid-session), the row is purged and the
 * stream re-resolved fresh once before giving up — the phone's stale-URL
 * "not playing" reports heal without a manual cache clear.
 *
 * HONESTY HEADERS: X-Stream-Provider / X-Stream-Bitrate / X-Stream-Art on
 * HEAD and redirect responses so the UI can badge real quality and label
 * degraded sources truthfully.
 */
import { NextRequest, NextResponse } from 'next/server'
import { resolveStream, purgeVideoId } from '@/lib/ytm/stream'
import { VIDEO_ID_RE } from '@/lib/ytm/ytdlp'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function isAllowedUpstream(url: string): boolean {
  try {
    const u = new URL(url)
    return (
      u.protocol === 'https:' &&
      (u.hostname.endsWith('.googlevideo.com') ||
        u.hostname.endsWith('.youtube.com') ||
        u.hostname.endsWith('.ytimg.com') ||
        // Apple's audio CDN — REAL studio-recording preview clips
        u.hostname === 'audio-ssl.itunes.apple.com' ||
        u.hostname.endsWith('.itunes.apple.com') ||
        // JioSaavn CDN — full-length 320 kbps AAC (evergreen objects)
        u.hostname.endsWith('.saavncdn.com') ||
        u.hostname.endsWith('.jiosaavn.com') ||
        /(^|\.)pipedproxy\./.test(u.hostname) ||
        /(^|\.)piped\./.test(u.hostname) ||
        u.hostname.endsWith('.adminforge.de') ||
        u.hostname.endsWith('.nadeko.net') ||
        u.hostname.endsWith('.nerdvpn.de') ||
        u.hostname.endsWith('yewtu.be') ||
        u.hostname.endsWith('.projectsegfau.lt') ||
        u.hostname.endsWith('.private.coffee') ||
        u.hostname.endsWith('.drgns.space') ||
        u.hostname.endsWith('.kwiatekmiki.com') ||
        u.hostname.endsWith('.canine.tools') ||
        u.hostname.endsWith('.3kh0.net'))
    )
  } catch {
    return false
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const videoId = searchParams.get('id') || ''
  const clientUrl = searchParams.get('url') || ''
  const range = req.headers.get('range')
  const isHead = req.method === 'HEAD' || searchParams.get('head') === '1'
  const durParam = parseFloat(searchParams.get('dur') || '0') || 0
  const title = searchParams.get('title') || ''
  const artist = searchParams.get('artist') || ''
  // ?fresh=1 → bypass the resolve cache. Used by the player's automatic
  // stale-URL recovery (audio error 2/4 after an IP change mid-session).
  const fresh = searchParams.get('fresh') === '1'
  // ?proxy=1 → stream the bytes THROUGH this server instead of 307-redirecting
  // the browser to the CDN (mobile path).
  const proxy = searchParams.get('proxy') === '1'

  if (!videoId) return new Response('missing id', { status: 400 })
  // Malformed ids never reach a provider or a subprocess argv.
  if (!VIDEO_ID_RE.test(videoId)) return new Response('malformed id', { status: 400 })

  // 1. client-resolved URL passthrough — 307 redirect (audio <audio> fetches directly)
  if (clientUrl && isAllowedUpstream(clientUrl)) {
    if (isHead) {
      const h = new Headers()
      h.set('X-Stream-Provider', 'client')
      h.set('Content-Length', '0')
      return new Response(null, { status: 200, headers: h })
    }
    return NextResponse.redirect(clientUrl, {
      headers: { 'X-Stream-Provider': 'client' },
    })
  }

  // 2. server chain — resolve and dispatch.
  const resolved = await resolveStream(videoId, {
    skipCache: fresh,
    durationSec: durParam,
    title: title || undefined,
    artist: artist || undefined,
  })

  const metaHeaders: Record<string, string> = { 'X-Stream-Provider': resolved.provider }
  if (resolved.bitrate) metaHeaders['X-Stream-Bitrate'] = String(resolved.bitrate)
  if (resolved.artUrl) metaHeaders['X-Stream-Art'] = resolved.artUrl

  // 3. TSF Synth — unique full-length per-track music, rendered inline
  if (resolved.provider === 'tsf-synth') {
    const { buildPlan } = await import('@/lib/synth/arrangement')
    const { synthStreamResponse } = await import('@/lib/synth/render')
    const plan = buildPlan(videoId, durParam)
    return synthStreamResponse(plan, req, { head: isHead })
  }

  // 3b. legacy demo-tone cache entries — serve until they expire
  if (resolved.provider === 'demo-tone') {
    if (isHead) {
      const h = new Headers(metaHeaders)
      h.set('Content-Type', 'audio/wav')
      h.set('Accept-Ranges', 'bytes')
      h.set('Content-Length', '0')
      return new Response(null, { status: 200, headers: h })
    }
    // Forward to the demo generator with the Range header preserved.
    const demoUrl = new URL('/api/stream/demo', req.url)
    demoUrl.searchParams.set('id', videoId)
    const demoReq = new Request(demoUrl.toString(), {
      headers: range ? { range } : {},
    })
    const { GET: demoGET } = await import('./demo/route')
    return demoGET(demoReq as unknown as NextRequest)
  }

  // 4. real upstream URL — redirect… unless the client asked for proxy mode.
  if (isAllowedUpstream(resolved.url)) {
    if (proxy && !isHead) {
      // Same-origin byte stream: kills CORS, redirect chains, and IP-bound
      // URL expiry issues on the phone. SELF-HEAL: a cached URL that fails
      // to pipe (stale signature / IP change) is purged + re-resolved once.
      let piped = await pipeUpstream(resolved.url, range, resolved.provider, resolved.userAgent)
      if (!piped && resolved.fromCache) {
        await purgeVideoId(videoId)
        const retry = await resolveStream(videoId, {
          skipCache: true,
          durationSec: durParam,
          title: title || undefined,
          artist: artist || undefined,
        })
        if (retry.provider !== 'tsf-synth' && retry.provider !== 'demo-tone' && retry.url !== resolved.url) {
          piped = await pipeUpstream(retry.url, range, retry.provider, retry.userAgent)
        }
      }
      if (!piped) return new Response('upstream failed', { status: 502 })
      const headers = new Headers(piped.headers)
      headers.set('X-Stream-Provider', resolved.provider)
      if (resolved.bitrate) headers.set('X-Stream-Bitrate', String(resolved.bitrate))
      return new Response(piped.body, { status: piped.status, headers })
    }
    if (isHead) {
      const h = new Headers(metaHeaders)
      h.set('Content-Length', '0')
      h.set('Accept-Ranges', 'bytes')
      return new Response(null, { status: 200, headers: h })
    }
    const headers = new Headers(metaHeaders)
    headers.set('Cache-Control', 'no-store')
    return NextResponse.redirect(resolved.url, { headers })
  }

  // 5. fallback — unknown upstream host: still try to pipe through us
  if (isHead) {
    const h = new Headers(metaHeaders)
    return new Response(null, { status: 200, headers: h })
  }
  const piped = await pipeUpstream(resolved.url, range, resolved.provider, resolved.userAgent)
  if (!piped) return new Response('upstream failed', { status: 502 })
  return piped
}

export async function HEAD(req: NextRequest) {
  // Re-use GET logic; GET handles the isHead branch and returns no body.
  return GET(req)
}

/**
 * Byte-proxy an upstream media URL to the client. Returns null on failure
 * (instead of a synthetic 502 Response) so the caller can self-heal.
 *
 * Musify-ported fixes (their vendored youtube_explode fork):
 *   1. UA MATCHING — googlevideo URLs resolved by app-style clients are
 *      signed against the resolving client's User-Agent; we send the exact
 *      UA that resolved the URL.
 *   2. RANGE ALWAYS — googlevideo rejects range-less full-file GETs with
 *      403; when the client sends no Range we ask for bytes=0- explicitly.
 *   3. QUERY-PARAM RANGE FALLBACK — googlevideo also accepts `&range=a-b`
 *      as a URL query param; used when header-based ranges get rejected.
 */
async function pipeUpstream(
  url: string,
  range: string | null,
  provider?: string,
  userAgent?: string,
): Promise<Response | null> {
  const ua =
    userAgent ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  const baseHeaders: Record<string, string> = { 'User-Agent': ua }
  if (range) baseHeaders.Range = range

  const doFetch = (headers: Record<string, string>, u: string = url) =>
    fetch(u, {
      headers,
      // Byte streaming must not be cut off by the platform fetch timeout —
      // a 4-minute song at 128 kbps is ~4 MB but the CDN throttles to realtime.
      signal: AbortSignal.timeout(3 * 60 * 1000),
    }).catch(() => null)

  let upstream = await doFetch(range ? baseHeaders : { ...baseHeaders, Range: 'bytes=0-' })

  // Self-heal #1: upstream rejected the request (403/416 — stale signature
  // or a rejected verbatim client range) → retry once with the full byte
  // space requested explicitly.
  if ((!upstream || upstream.status === 403 || upstream.status === 416) && baseHeaders.Range !== 'bytes=0-') {
    upstream = await doFetch({ ...baseHeaders, Range: 'bytes=0-' })
  }

  // Self-heal #2: still rejected → same range expressed as googlevideo's
  // `range` QUERY PARAM instead of the header (different auth path).
  if (!upstream || upstream.status === 403 || upstream.status === 416) {
    try {
      const qUrl = new URL(url)
      const m = /bytes=(\d+)-(\d*)/.exec(baseHeaders.Range || 'bytes=0-')
      if (m) qUrl.searchParams.set('range', `${m[1]}-${m[2] || ''}`.replace(/-$/, ''))
      upstream = await doFetch({ 'User-Agent': ua }, qUrl.toString())
    } catch {
      /* not a parseable URL — give up gracefully */
    }
  }

  if (!upstream || !upstream.ok) {
    return null
  }

  const headers = new Headers()
  headers.set('Content-Type', upstream.headers.get('content-type') || 'audio/mp4')
  headers.set('Accept-Ranges', 'bytes')
  const cr = upstream.headers.get('content-range')
  if (cr) headers.set('Content-Range', cr)
  const cl = upstream.headers.get('content-length')
  if (cl) headers.set('Content-Length', cl)
  headers.set('Cache-Control', 'no-store')
  if (provider) headers.set('X-Stream-Provider', provider)

  return new Response(upstream.body, { status: upstream.status, headers })
}
