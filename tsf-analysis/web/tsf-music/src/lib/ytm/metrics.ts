/**
 * TSF Music — resolve metrics ring
 *
 * A bounded ring buffer of recent stream resolutions, surfaced via
 * /api/health (total, ok-rate, p50/p95, per-provider breakdown) so the
 * ops dashboard and the QA gauntlet can trend resolver health.
 *
 * IMPORTANT (Turbopack dev quirk): each API route compiles as its own module
 * graph in dev, so a module-level array here would be a DIFFERENT object in
 * /api/stream's bundle vs /api/health's bundle — metrics would read total=0.
 * The ring therefore lives on globalThis (the standard Next.js dev-singleton
 * pattern).
 */

export interface ResolveMetric {
  ts: number
  videoId: string
  provider: string
  ms: number
  ok: boolean
}

const RING_MAX = 200

function ring(): ResolveMetric[] {
  const g = globalThis as unknown as { __tsfResolveRing?: ResolveMetric[] }
  g.__tsfResolveRing ??= []
  return g.__tsfResolveRing
}

export function recordResolve(m: ResolveMetric) {
  const r = ring()
  r.push(m)
  if (r.length > RING_MAX) r.splice(0, r.length - RING_MAX)
}

export function resolveMetricsSnapshot(): ResolveMetric[] {
  return ring().slice()
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return Math.round(sorted[Math.max(0, idx)])
}

export interface MetricsSummary {
  total: number
  okRate: number
  p50: number
  p95: number
  byProvider: Array<{ provider: string; count: number; ok: number; p50: number; p95: number }>
}

export function summarizeMetrics(): MetricsSummary {
  const snap = resolveMetricsSnapshot()
  const ok = snap.filter((m) => m.ok)
  const times = snap.map((m) => m.ms).sort((a, b) => a - b)
  const byName = new Map<string, ResolveMetric[]>()
  for (const m of snap) {
    const list = byName.get(m.provider) ?? []
    list.push(m)
    byName.set(m.provider, list)
  }
  return {
    total: snap.length,
    okRate: snap.length === 0 ? 0 : Math.round((ok.length / snap.length) * 100),
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    byProvider: [...byName.entries()]
      .map(([provider, list]) => {
        const t = list.map((m) => m.ms).sort((a, b) => a - b)
        return {
          provider,
          count: list.length,
          ok: list.filter((m) => m.ok).length,
          p50: percentile(t, 50),
          p95: percentile(t, 95),
        }
      })
      .sort((a, b) => b.count - a.count),
  }
}
