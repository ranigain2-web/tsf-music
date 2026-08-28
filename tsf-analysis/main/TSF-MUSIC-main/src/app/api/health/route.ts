/**
 * TSF Music — /api/health (v3)
 *
 * GET                → provider table + ytdlp status + resolve metrics
 *                       + recent-resolve feed (last 20)
 * GET  ?fresh=1      → re-probe every provider (8s cap), then same payload
 * GET  ?feed=1       → paginated resolve feed (?offset=N&limit=M, cap 200)
 * POST ?purge=1      → purge ALL stream-cache rows + memory LRU
 * POST ?refresh-instances=1 → light relay re-probe (seeds only)
 *
 * Shape kept compatible with the Provider Health Dashboard.
 */
import {
  getProviderHealth,
  purgeStreamCache,
  probeAllProviders,
  ytDlpBinary,
} from '@/lib/ytm/stream'
import { summarizeMetrics, resolveMetricsSnapshot } from '@/lib/ytm/metrics'
import { aiStatus } from '@/lib/ai/engine'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const fresh = searchParams.get('fresh') === '1'
  const feed = searchParams.get('feed') === '1'

  if (feed) {
    const offset = Math.max(0, parseInt(searchParams.get('offset') || '0', 10) || 0)
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '20', 10) || 20))
    const snap = resolveMetricsSnapshot().reverse().slice(offset, offset + limit)
    return Response.json({ offset, limit, total: resolveMetricsSnapshot().length, feed: snap })
  }

  if (fresh) {
    await probeAllProviders()
  }

  const providers = await getProviderHealth()
  const bin = await ytDlpBinary()
  const metrics = summarizeMetrics()

  // Relay registry snapshot (if the RelayInstance table exists in this DB).
  let relayInstances: unknown = null
  try {
    const rows: any[] = await (db as any).relayInstance.findMany({ orderBy: { latencyMs: 'asc' } })
    const lastRefresh = rows.reduce<number>(
      (acc, r) => Math.max(acc, new Date(r.lastCheck ?? 0).getTime()),
      0,
    )
    relayInstances = {
      lastRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : null,
      ageMs: lastRefresh ? Date.now() - lastRefresh : null,
      rows,
    }
  } catch {
    relayInstances = null
  }

  return Response.json({
    ok: true,
    time: new Date().toISOString(),
    providers,
    anyLive: providers.some((p: any) => p.ok && !p.provider.startsWith('demo')),
    ytdlp: bin ? { available: true, path: bin.path, version: bin.version } : { available: false },
    ai: aiStatus(),
    resolveMetrics: metrics,
    recentResolves: resolveMetricsSnapshot().slice(-20).reverse(),
    relayInstances,
  })
}

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url)
  if (searchParams.get('purge') === '1') {
    const result = await purgeStreamCache()
    return Response.json({ ok: true, ...result })
  }
  if (searchParams.get('refresh-instances') === '1') {
    // Light relay refresh: re-probe the static seeds (auto-discovery of
    // public registries is intentionally not part of this swap set).
    await probeAllProviders()
    return Response.json({ ok: true, note: 'seed relays re-probed' })
  }
  return Response.json({ ok: false, error: 'unknown action' }, { status: 400 })
}
