'use client'

/**
 * TSF Music — Engine health
 *
 * THE TRANSPARENCY SURFACE FOR THE PLAYBACK CHAIN.
 *
 * The resolver already reports the truth in headers (`X-Stream-Provider` /
 * `X-Stream-Bitrate`) and /api/health already returns the whole provider table,
 * resolve metrics, yt-dlp status and the AI gateway probe — but until now that
 * lived only in curl. This view puts it on screen and gives you the three
 * actions that actually fix a stuck engine:
 *
 *   1. Re-probe every provider (bypasses the circuit breaker's cooldown)
 *   2. Purge the stream cache  (forces a genuinely fresh resolve)
 *   3. Test one track live     (head=1 → provider + bitrate, no audio download)
 *
 * Deliberately honest: a degraded result is labelled degraded, never hidden.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Zap,
  Trash2,
  FlaskConical,
  Clock3,
  Cpu,
  Sparkles,
  ArrowDownUp,
  Gauge,
} from 'lucide-react'
import { api } from '@/store/nav'

// ── wire types (mirror /api/health) ────────────────────────────────────────
interface ProviderRow {
  provider: string
  ok: boolean
  lastCheck: string | null
  lastError: string | null
  latencyMs: number | null
}
interface ByProvider {
  provider: string
  count: number
  ok: number
  p50: number
  p95: number
}
interface ResolveRow {
  ts: number
  videoId: string
  provider: string
  ms: number
  ok: boolean
}
interface Health {
  ok: boolean
  time: string
  providers: ProviderRow[]
  anyLive: boolean
  ytdlp: { available: boolean; path?: string; version?: string }
  ai: { provider?: string; fastAvailable?: boolean }
  resolveMetrics: {
    total: number
    okRate: number
    p50: number
    p95: number
    byProvider: ByProvider[]
  }
  recentResolves: ResolveRow[]
}

type Kind = 'full' | 'preview' | 'synth' | 'unknown'

/** Same honesty semantics as the player's SourceBadge — never over-claim. */
function classify(provider: string | null | undefined): Kind {
  if (!provider) return 'unknown'
  if (provider === 'tsf-synth' || provider === 'demo-tone') return 'synth'
  if (provider === 'itunes-preview') return 'preview'
  return 'full'
}

const KIND_STYLE: Record<Kind, { dot: string; text: string; label: string }> = {
  full: { dot: 'bg-emerald-400', text: 'text-emerald-300', label: 'full-length' },
  preview: { dot: 'bg-amber-400', text: 'text-amber-300', label: '30s preview' },
  synth: { dot: 'bg-slate-400', text: 'text-slate-300', label: 'offline synth' },
  unknown: { dot: 'bg-[#6a6a6a]', text: 'text-[#a7a7a7]', label: 'unresolved' },
}

function fmtBitrate(bps: number): string {
  if (!bps || bps <= 0) return '—'
  const kbps = Math.round(bps / 1000)
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`
}

function fmtAgo(iso: string | number | null | undefined): string {
  if (!iso) return '—'
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const SAMPLE_TRACK = 'dQw4w9WgXcQ'

export function EngineHealthView() {
  const [health, setHealth] = useState<Health | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [auto, setAuto] = useState(false)
  const [probeId, setProbeId] = useState(SAMPLE_TRACK)
  const [probe, setProbe] = useState<{
    state: 'idle' | 'running' | 'done' | 'error'
    provider?: string
    bitrate?: number
    ms?: number
    message?: string
  }>({ state: 'idle' })
  const alive = useRef(true)

  const load = useCallback(async (fresh = false) => {
    try {
      const r = await api<Health>(`/api/health${fresh ? '?fresh=1' : ''}`)
      if (!alive.current) return
      setHealth(r)
      setError(null)
    } catch (e) {
      if (alive.current) setError(String(e))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
    }
  }, [load])

  useEffect(() => {
    if (!auto) return
    const t = setInterval(() => void load(), 10_000)
    return () => clearInterval(t)
  }, [auto, load])

  const flash = (msg: string) => {
    setNote(msg)
    window.setTimeout(() => setNote((n) => (n === msg ? null : n)), 4000)
  }

  const reprobe = async () => {
    setBusy('probe')
    try {
      await load(true)
      flash('All providers re-probed.')
    } catch {
      flash('Re-probe failed — the engine may be busy.')
    } finally {
      setBusy(null)
    }
  }

  const purge = async () => {
    if (!window.confirm('Purge every cached stream URL? The next play will resolve from scratch (a few seconds slower).')) return
    setBusy('purge')
    try {
      const r = await api<{ ok: boolean }>('/api/health?purge=1', { method: 'POST' })
      await load()
      flash(r?.ok ? 'Stream cache purged.' : 'Purge returned an unexpected result.')
    } catch {
      flash('Purge failed.')
    } finally {
      setBusy(null)
    }
  }

  /** head=1 resolves and reports headers WITHOUT downloading audio — cheap + honest. */
  const runProbe = async () => {
    const id = probeId.trim()
    if (!id) return
    setProbe({ state: 'running' })
    const t0 = performance.now()
    try {
      const res = await fetch(`/api/stream?id=${encodeURIComponent(id)}&head=1&fresh=1`, {
        signal: AbortSignal.timeout(60_000),
      })
      const ms = Math.round(performance.now() - t0)
      if (!res.ok) {
        setProbe({ state: 'error', ms, message: `HTTP ${res.status}` })
        return
      }
      setProbe({
        state: 'done',
        provider: res.headers.get('x-stream-provider') || undefined,
        bitrate: Number(res.headers.get('x-stream-bitrate') || 0) || undefined,
        ms,
      })
      void load()
    } catch (e) {
      setProbe({ state: 'error', message: String(e) })
    }
  }

  // ── render ───────────────────────────────────────────────────────────────
  const providers = health?.providers ?? []
  const liveCount = providers.filter((p) => p.ok).length
  const metrics = health?.resolveMetrics
  const feed = health?.recentResolves ?? []

  if (loading && !health) {
    return (
      <div className="px-4 lg:px-6 py-8">
        <div className="h-8 w-56 bg-white/5 rounded animate-pulse mb-6" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-white/5 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="px-4 lg:px-6 py-6 pb-16 max-w-[1100px]">
      {/* header */}
      <header className="flex flex-wrap items-center gap-4 mb-6">
        <div className="w-14 h-14 rounded-full bg-[#1ed760]/15 text-[#1ed760] flex items-center justify-center shrink-0">
          <Activity size={26} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl lg:text-3xl font-extrabold text-white tracking-tight">Engine health</h1>
          <p className="text-[13px] text-[#b3b3b3]">
            What the playback chain is really doing — providers, timings and honest fallbacks.
          </p>
        </div>
        <button
          onClick={() => void load(true)}
          disabled={busy === 'probe'}
          className="flex items-center gap-2 px-4 h-9 rounded-full bg-[#1f1f1f] hover:bg-[#2a2a2a] text-sm text-white transition-colors disabled:opacity-50"
        >
          <RefreshCw size={15} className={busy === 'probe' ? 'animate-spin' : ''} />
          Re-probe
        </button>
        <label className="flex items-center gap-2 text-[12px] text-[#b3b3b3] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
            className="accent-[#1ed760]"
          />
          auto 10s
        </label>
      </header>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20 text-[13px] text-red-300">
          Could not reach <code className="text-red-200">/api/health</code> — {error}
        </div>
      )}
      {note && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-[#1ed760]/10 border border-[#1ed760]/20 text-[13px] text-[#1ed760]">
          {note}
        </div>
      )}

      {/* stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Stat
          icon={<ShieldCheck size={16} className={liveCount > 0 ? 'text-emerald-400' : 'text-amber-400'} />}
          label="Providers live"
          value={`${liveCount}/${providers.length}`}
          hint={health?.anyLive ? 'at least one full-length source' : 'all cooling down'}
        />
        <Stat
          icon={<Gauge size={16} className="text-[#1ed760]" />}
          label="Resolve success"
          value={metrics ? `${metrics.okRate}%` : '—'}
          hint={metrics ? `${metrics.total} resolves recorded` : 'no data yet'}
        />
        <Stat
          icon={<Clock3 size={16} className="text-[#1ed760]" />}
          label="Latency"
          value={metrics ? `${metrics.p50} ms` : '—'}
          hint={metrics ? `p95 ${metrics.p95} ms` : 'no data yet'}
        />
        <Stat
          icon={<Cpu size={16} className={health?.ytdlp?.available ? 'text-emerald-400' : 'text-red-400'} />}
          label="yt-dlp"
          value={health?.ytdlp?.available ? 'ready' : 'missing'}
          hint={health?.ytdlp?.version || (health?.ytdlp?.available ? 'installed' : 'full-length fallback lost')}
        />
      </div>

      {/* the chain, in the order the resolver actually walks it */}
      <Panel
        icon={<ArrowDownUp size={15} />}
        title="Resolution order"
        subtitle="The resolver races these and keeps the best result it gets."
      >
        <ol className="text-[13px] text-[#b3b3b3] space-y-1.5 leading-relaxed">
          <li><span className="text-white font-medium">1. Cache</span> — a real full-length hit beats a preview, every time.</li>
          <li><span className="text-white font-medium">2. yt-dlp + BotGuard tokens</span> — primary full-length source.</li>
          <li><span className="text-white font-medium">3. JioSaavn 320 kbps</span> — exact-match only; refuses masquerades.</li>
          <li><span className="text-white font-medium">4. InnerTube clients</span> — rotated, with per-provider circuit breakers.</li>
          <li><span className="text-white font-medium">5. Relay instances</span> — Piped / Invidious.</li>
          <li><span className="text-amber-300 font-medium">6. iTunes preview</span> — honest 30 s clip, clearly labelled.</li>
          <li><span className="text-slate-300 font-medium">7. Offline synth</span> — generated audio so playback never dies.</li>
        </ol>
      </Panel>

      {/* live test */}
      <Panel
        icon={<FlaskConical size={15} />}
        title="Test a track"
        subtitle="Resolves without downloading audio (head=1) and reports exactly what you'd get."
      >
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input
            value={probeId}
            onChange={(e) => setProbeId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void runProbe()}
            placeholder="video id or saavn-… id"
            className="flex-1 min-w-[200px] h-10 px-3 rounded-md bg-[#1f1f1f] border border-white/10 text-sm text-white placeholder:text-[#6a6a6a] focus:outline-none focus:border-[#1ed760]/50"
          />
          <button
            onClick={() => void runProbe()}
            disabled={probe.state === 'running' || !probeId.trim()}
            className="flex items-center gap-2 px-5 h-10 rounded-full bg-[#1ed760] text-black text-sm font-bold hover:scale-[1.02] active:scale-95 transition-transform disabled:opacity-50 disabled:hover:scale-100"
          >
            <Zap size={15} />
            {probe.state === 'running' ? 'Resolving…' : 'Test playback'}
          </button>
        </div>
        {probe.state !== 'idle' && (
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            {probe.state === 'running' && <span className="text-[#b3b3b3]">Walking the provider chain…</span>}
            {probe.state === 'error' && <span className="text-red-300">Failed — {probe.message}</span>}
            {probe.state === 'done' && (() => {
              const kind = classify(probe.provider)
              const st = KIND_STYLE[kind]
              return (
                <>
                  <span className={`inline-flex items-center gap-1.5 font-medium ${st.text}`}>
                    <span className={`inline-block size-2 rounded-full ${st.dot}`} />
                    {st.label}
                  </span>
                  <span className="text-[#b3b3b3]">
                    via <span className="text-white font-medium">{probe.provider ?? 'unknown'}</span>
                    {probe.bitrate ? ` · ${fmtBitrate(probe.bitrate)}` : ''}
                  </span>
                  <span className="text-[#6a6a6a] tabular-nums">{probe.ms} ms</span>
                </>
              )
            })()}
          </div>
        )}
      </Panel>

      {/* provider table */}
      <Panel
        icon={<ShieldAlert size={15} />}
        title={`Providers (${liveCount}/${providers.length} live)`}
        subtitle="A provider that fails is cooled down for 10 minutes, then retried automatically."
      >
        <div className="divide-y divide-white/5">
          {providers.map((p) => (
            <div key={p.provider} className="flex items-center gap-3 py-2 text-[13px]">
              <span className={`inline-block size-2 rounded-full shrink-0 ${p.ok ? 'bg-emerald-400' : 'bg-[#535353]'}`} />
              <span className="text-white font-medium w-[190px] truncate shrink-0">{p.provider}</span>
              <span className="text-[#6a6a6a] tabular-nums w-[70px] shrink-0">
                {p.latencyMs != null ? `${p.latencyMs} ms` : '—'}
              </span>
              <span className="text-[#6a6a6a] w-[90px] shrink-0">{fmtAgo(p.lastCheck)}</span>
              <span className="text-[#a7a7a7] truncate min-w-0 flex-1">{p.lastError || (p.ok ? '' : 'no error recorded')}</span>
            </div>
          ))}
          {!providers.length && <p className="py-3 text-[13px] text-[#a7a7a7]">No provider rows yet.</p>}
        </div>
      </Panel>

      {/* per-provider breakdown */}
      {metrics && metrics.byProvider.length > 0 && (
        <Panel
          icon={<Gauge size={15} />}
          title="Who is actually serving your music"
          subtitle={`${metrics.total} resolves · ${metrics.okRate}% succeeded · p50 ${metrics.p50} ms · p95 ${metrics.p95} ms`}
        >
          <div className="space-y-2.5">
            {metrics.byProvider.map((b) => {
              const rate = b.count ? Math.round((b.ok / b.count) * 100) : 0
              const kind = classify(b.provider)
              return (
                <div key={b.provider} className="text-[13px]">
                  <div className="flex items-center gap-3 mb-1">
                    <span className={`inline-block size-2 rounded-full ${KIND_STYLE[kind].dot}`} />
                    <span className="text-white font-medium w-[190px] truncate">{b.provider}</span>
                    <span className="text-[#6a6a6a] tabular-nums">{b.ok}/{b.count} ok</span>
                    <span className="text-[#6a6a6a] tabular-nums ml-auto">p50 {b.p50} ms</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                    <div
                      className={`h-full rounded-full ${kind === 'full' ? 'bg-[#1ed760]' : kind === 'preview' ? 'bg-amber-400' : 'bg-slate-400'}`}
                      style={{ width: `${rate}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </Panel>
      )}

      {/* recent resolves */}
      <Panel
        icon={<Activity size={15} />}
        title="Recent resolves"
        subtitle="The last 20 resolutions, newest first — this is the raw truth."
      >
        <div className="divide-y divide-white/5 max-h-[320px] overflow-y-auto">
          {feed.map((r, i) => {
            const kind = classify(r.provider)
            return (
              <div key={`${r.ts}-${i}`} className="flex items-center gap-3 py-1.5 text-[12px]">
                <span className={`inline-block size-1.5 rounded-full shrink-0 ${r.ok ? KIND_STYLE[kind].dot : 'bg-red-500'}`} />
                <span className="text-[#a7a7a7] font-mono w-[130px] truncate shrink-0">{r.videoId}</span>
                <span className={`w-[180px] truncate shrink-0 ${KIND_STYLE[kind].text}`}>{r.provider}</span>
                <span className="text-[#6a6a6a] tabular-nums w-[70px]">{r.ms} ms</span>
                <span className="text-[#535353] ml-auto">{fmtAgo(r.ts)}</span>
              </div>
            )
          })}
          {!feed.length && <p className="py-3 text-[13px] text-[#a7a7a7]">Nothing resolved yet — play something.</p>}
        </div>
      </Panel>

      {/* AI gateway + maintenance */}
      <Panel
        icon={<Sparkles size={15} />}
        title="AI gateway"
        subtitle="AI features fall back to a keyless chain when the local gateway is unavailable."
      >
        <div className="flex items-center gap-3 text-[13px]">
          <span className={`inline-block size-2 rounded-full ${health?.ai?.fastAvailable ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          <span className="text-white font-medium">
            {health?.ai?.fastAvailable ? 'Local gateway ready' : 'Keyless fallback active'}
          </span>
          <span className="text-[#6a6a6a]">{health?.ai?.provider || 'unknown provider'}</span>
        </div>
      </Panel>

      <Panel
        icon={<Trash2 size={15} />}
        title="Maintenance"
        subtitle="Use these when playback feels stuck or stale."
      >
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void reprobe()}
            disabled={busy !== null}
            className="flex items-center gap-2 px-4 h-9 rounded-full bg-[#1f1f1f] hover:bg-[#2a2a2a] text-sm text-white transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={busy === 'probe' ? 'animate-spin' : ''} />
            Re-probe providers
          </button>
          <button
            onClick={() => void purge()}
            disabled={busy !== null}
            className="flex items-center gap-2 px-4 h-9 rounded-full bg-[#1f1f1f] hover:bg-[#2a2a2a] text-sm text-white transition-colors disabled:opacity-50"
          >
            <Trash2 size={14} />
            Purge stream cache
          </button>
        </div>
        <p className="mt-3 text-[11px] text-[#6a6a6a]">
          Snapshot {health ? fmtAgo(health.time) : '—'} · raw JSON at{' '}
          <code className="text-[#a7a7a7]">/api/health</code>
        </p>
      </Panel>
    </div>
  )
}

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-lg bg-[#181818] p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-[#a7a7a7] mb-2">
        {icon}
        {label}
      </div>
      <div className="text-xl font-extrabold text-white tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-[#6a6a6a] truncate mt-0.5">{hint}</div>}
    </div>
  )
}

function Panel({
  icon,
  title,
  subtitle,
  children,
}: {
  icon?: React.ReactNode
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-5 rounded-lg bg-[#181818] p-4 lg:p-5">
      <div className="flex items-center gap-2 mb-1">
        {icon && <span className="text-[#1ed760]">{icon}</span>}
        <h2 className="text-[15px] font-bold text-white">{title}</h2>
      </div>
      {subtitle && <p className="text-[12px] text-[#a7a7a7] mb-3">{subtitle}</p>}
      {children}
    </section>
  )
}
