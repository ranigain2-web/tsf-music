import { NextRequest } from 'next/server'
import { searchMusicV2, engineDeps, type SearchV2Result, type SearchRow } from '@/lib/search-v2'
import { ytSearchMusic, ytAvailable } from '@/lib/search-v2/ytmusic'
import { isShelfTitleSafe } from '@/lib/safety'
import { POST as vibeSearchPost } from '@/app/api/ai/vibe-search/route'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ytm/search-v2?q=&source=catalog|youtube&vibe=0|1&learn=0
 *
 * NDJSON STREAMING (established pattern — see ai/playlist-generator):
 *   line 1  {"type":"early",  rows:[...], ...meta}   progressive paint —
 *            fired the moment the primary ranked pool exists (may be
 *            skipped on a cache hit; the final line follows instantly)
 *   line 2  {"type":"final", result:{...}}           the full declared
 *            SearchV2Result (rows + plan + sigState + stages)
 *
 * source=youtube → the raw YT Music catalog source (reference v3.4):
 * Song entities first, then videos ≤15 min, junk-filtered, with the
 * kill-switch honesty flag (ytUnavailable) — 3 consecutive failures
 * soft-disable the source for 1 h.
 * vibe=1 → delegates IN-PROCESS to the existing /api/ai/vibe-search
 * handler (imported, not re-fetched) and wraps the rows in the same
 * stream contract.
 */

type Ndjson = Record<string, unknown>

function ndjsonLine(obj: Ndjson): string {
  return `${JSON.stringify(obj)}\n`
}

/** The final result may carry non-JSON bits (frozen plan) — JSON.stringify
 *  handles plain structures; rows are plain by construction. */
function serializeResult(result: SearchV2Result): Ndjson {
  return {
    rows: result.rows,
    plan: {
      raw: result.plan.raw,
      normalized: result.plan.normalized,
      kind: result.plan.kind,
      tokens: result.plan.tokens,
      titleTokens: result.plan.titleTokens,
      artistTokens: result.plan.artistTokens,
      connectorTokens: result.plan.connectorTokens,
      variants: result.plan.variants,
      windows: result.plan.windows,
      corrections: result.plan.corrections,
      titleKey: result.plan.titleKey,
    },
    topReason: result.topReason,
    corrected: result.corrected,
    relaxedFrom: result.relaxedFrom,
    relaxedQuery: result.relaxedQuery,
    latencyMs: result.latencyMs,
    correlationId: result.correlationId,
    probes: result.probes,
    sigState: result.sigState,
    partialArtists: result.partialArtists,
    rescueRung: result.rescueRung,
    stages: result.stages,
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') || '').trim()
  const source = searchParams.get('source') || 'catalog'
  const vibe = searchParams.get('vibe') === '1'
  // kill-switch plumbing: the UI passes surfaceFlags().recsOff through
  // (?learn=0) so S5 learning honors the same switch the client shows
  const learnParam = searchParams.get('learn')
  const learnDisabled = learnParam === '0'

  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      const send = (o: Ndjson) => {
        if (!closed) {
          try {
            controller.enqueue(enc.encode(ndjsonLine(o)))
          } catch {
            closed = true
          }
        }
      }
      // the client disconnecting kills every in-flight provider probe
      req.signal?.addEventListener('abort', () => {
        closed = true
        try { controller.close() } catch { /* already closed */ }
      }, { once: true })

      const startedAt = Date.now()
      try {
        if (!q) {
          send({ type: 'final', result: { rows: [], latencyMs: Date.now() - startedAt, correlationId: null, stages: null } })
        } else if (!isShelfTitleSafe(q)) {
          send({ type: 'final', error: 'Query blocked by content safety filter' })
        } else if (source === 'youtube') {
          // ── YT Music source (raw catalog rows, reference v3.4) ──
          const wasAvailable = ytAvailable()
          const out = await ytSearchMusic(q, 30, req.signal)
          const rows: SearchRow[] = out.tracks.map((t, i) => ({
            ...t,
            poolRank: i,
            pool: 'youtube',
            reasonCode: 'PROVIDER_TOP',
            reason: 'Top result from the catalog',
          }))
          send({
            type: 'final',
            result: {
              rows,
              latencyMs: Date.now() - startedAt,
              ytUnavailable: !wasAvailable || out.unavailable,
              source: 'youtube',
            },
          })
        } else if (vibe) {
          // ── vibe search (in-process delegation — no HTTP re-fetch) ──
          try {
            const inner = new NextRequest(
              new URL('/api/ai/vibe-search', 'http://internal'),
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: q }),
              },
            )
            const res = await vibeSearchPost(inner)
            const j = (await res.json().catch(() => ({}))) as {
              tracks?: Array<{ videoId: string; title?: string; artistName?: string; artistId?: string; albumName?: string; duration?: number; thumbnail?: string; year?: number }>
              vibePlaylistShortcut?: { prompt: string }
              artistsLike?: Array<{ id?: string; name: string }>
              intentConfidence?: number
              error?: string
            }
            if (j.error) {
              send({ type: 'final', error: j.error })
            } else {
              const rows: SearchRow[] = (j.tracks ?? []).map((t, i) => ({
                id: t.videoId,
                videoId: t.videoId,
                title: t.title ?? '',
                artistName: t.artistName ?? 'Unknown artist',
                artistId: t.artistId,
                albumName: t.albumName,
                duration: t.duration ?? 0,
                thumbnail: t.thumbnail ?? '',
                year: t.year,
                source: 'ytm',
                poolRank: i,
                pool: 'vibe',
                reasonCode: 'PROVIDER_TOP',
                reason: 'Top result from the catalog',
              }))
              send({
                type: 'final',
                result: {
                  rows,
                  latencyMs: Date.now() - startedAt,
                  vibe: {
                    shortcut: j.vibePlaylistShortcut ?? { prompt: q },
                    artistsLike: j.artistsLike ?? [],
                    intentConfidence: j.intentConfidence,
                  },
                },
              })
            }
          } catch {
            send({ type: 'final', result: { rows: [], latencyMs: Date.now() - startedAt, vibe: { shortcut: { prompt: q }, artistsLike: [] } } })
          }
        } else {
          // ── the S0→S5 engine (catalog) ──
          const deps = await engineDeps(learnDisabled)
          const result = await searchMusicV2(q, {
            signal: req.signal,
            deps,
            onEarly: (r) => {
              send({
                type: 'early',
                rows: r.rows,
                corrected: r.corrected,
                planKind: r.plan.kind,
                latencyMs: r.latencyMs,
                correlationId: r.correlationId,
              })
            },
            onStages: (stages) => {
              console.info(
                `[search-v2] q="${q.slice(0, 60)}" s0=${stages.s0PlanMs}ms s1=${stages.s1RetrieveMs}ms s2=${stages.s2VerifyMs}ms s3=${stages.s3RankMs}ms rescue=${stages.rescueMs}ms recover=${stages.recoverMs}ms total=${stages.totalMs}ms`,
              )
            },
          })
          if (!closed) {
            send({ type: 'final', result: serializeResult(result) })
          }
        }
      } catch (e) {
        // honest failure: the stream always answers
        send({ type: 'final', error: e instanceof Error ? e.message : 'search failed', result: { rows: [], latencyMs: Date.now() - startedAt } })
      } finally {
        if (!closed) {
          closed = true
          try { controller.close() } catch { /* already closed */ }
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
