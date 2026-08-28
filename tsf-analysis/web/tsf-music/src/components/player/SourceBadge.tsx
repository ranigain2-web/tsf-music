/**
 * TSF Music — SourceBadge
 *
 * HONEST TRANSPARENCY in the player UI:
 *   - Full-length real audio → emerald quality chip with the provider + the
 *     RESOLVER-REPORTED bitrate (never a marketing number: jiosaavn reports
 *     320000 when the 320 tier validated, or honestly 96000 when only the
 *     96 tier did).
 *   - iTunes preview → amber "30s preview" badge. Never masquerades as a
 *     full track.
 *   - TSF Synth → slate "offline synth" badge. The dummy-audio era is over,
 *     but if synth EVER fires the UI says so.
 *
 * Reads the player store's streamProvider/streamBitrate (populated by the
 * AudioEngine's HEAD preflight from X-Stream-* headers). Before the
 * preflight lands, a neutral inference renders instantly.
 */
import { usePlayer } from '@/store/player'

function fmtBitrate(bps: number): string {
  if (!bps || bps <= 0) return ''
  const kbps = Math.round(bps / 1000)
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`
  return `${kbps} kbps`
}

export default function SourceBadge({ compact = false }: { compact?: boolean }) {
  const provider = usePlayer((s) => s.streamProvider)
  const bitrate = usePlayer((s) => s.streamBitrate)

  if (!provider) return null

  // ---- degraded modes: ALWAYS visible, honestly labeled ----
  if (provider === 'itunes-preview') {
    return (
      <span
        title="Real 30-second clip of the studio recording — full-length source unavailable right now"
        className={`inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-300 ${
          compact ? '' : 'whitespace-nowrap'
        }`}
      >
        <span className="inline-block size-1.5 rounded-full bg-amber-400" />
        30s preview
      </span>
    )
  }
  if (provider === 'tsf-synth' || provider === 'demo-tone') {
    return (
      <span
        title="Procedurally generated offline audio — no real recording was reachable"
        className={`inline-flex items-center gap-1 rounded-full border border-slate-400/30 bg-slate-400/10 px-2 py-0.5 text-[10px] font-medium text-slate-300 ${
          compact ? '' : 'whitespace-nowrap'
        }`}
      >
        <span className="inline-block size-1.5 rounded-full bg-slate-400" />
        offline synth
      </span>
    )
  }

  // ---- full-length real audio: emerald quality chip ----
  let label = 'HD audio'
  let title = 'Real full-length audio'
  if (provider === 'jiosaavn') {
    label = 'JioSaavn'
    title = 'Real full-length audio from JioSaavn'
  } else if (provider === 'yt-dlp' || provider.startsWith('innertube-')) {
    label = 'HD audio'
    title = 'Real full-length audio from YouTube'
  } else if (provider.startsWith('piped-') || provider.startsWith('invidious-')) {
    label = 'Relay'
    title = 'Real full-length audio via relay'
  } else if (provider === 'client') {
    label = 'HD audio'
    title = 'Real full-length audio'
  }

  const br = fmtBitrate(bitrate)
  const shown = br ? (compact ? br : `${label} · ${br}`) : label

  return (
    <span
      title={br ? `${title} at ${br}` : title}
      className={`inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300 ${
        compact ? '' : 'whitespace-nowrap'
      }`}
    >
      <span className="inline-block size-1.5 rounded-full bg-emerald-400" />
      {shown}
    </span>
  )
}
