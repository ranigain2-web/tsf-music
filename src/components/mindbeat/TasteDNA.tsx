'use client'

/**
 * TSF Music — Taste DNA (MINDBEAT transparency surface)
 *
 * A full Dialog that shows exactly what the taste engine has learned and
 * hands the listener the levers: per-item Boost / Mute / "You got me wrong",
 * profile export, taste-model reset, and the MindBeat kill switches.
 *
 * Data comes only from the documented profile API:
 *   GET  /api/mindbeat/profile        → compact summary (top lists, daypart, ε)
 *   GET  /api/mindbeat/profile?full=1 → full profile (exploration counters, export)
 *   POST /api/mindbeat/profile        → { action: 'mute'|'boost'|'wrong'|'reset' }
 *
 * Weight bars are normalized to the list max and labelled with the RAW
 * evidence weight — no opaque percentages.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Dna,
  TrendingUp,
  VolumeX,
  Flag,
  Download,
  RotateCcw,
  RefreshCw,
  Moon,
  Compass,
  Sparkles,
  Check,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api } from '@/store/nav'
import { currentDaypart, type DaypartBlock, type DayKind } from '@/lib/mindbeat/types'

// ---------------------------------------------------------------------------
// Types (local mirrors of the profile route payloads — the profile module is
// server-only, so we never import it from the client)
// ---------------------------------------------------------------------------

interface WeightedItem {
  id: string
  name?: string
  weight: number
}

interface CompactProfile {
  topArtists: WeightedItem[]
  topGenres: WeightedItem[]
  topLanguages: WeightedItem[]
  topMoods: WeightedItem[]
  daypart: {
    block: DaypartBlock
    dayKind: DayKind
    topArtists: WeightedItem[]
    energyMean: number | null
  }
  sessionCount: number
  epsilon: number
  corrections: {
    mutedArtists: string[]
    mutedTracks: string[]
    boosts: Record<string, number>
    wrongLabels: string[]
  }
}

interface ExplorationCounts {
  noveltyServed: number
  noveltyConverted: number
}

// ---------------------------------------------------------------------------
// Kill-switch storage keys (enforcement lives elsewhere — this surface only
// persists + reflects them):
//   tsf-mindbeat-off      'on'  → recommendations/capture off (client.ts reads this)
//   tsf-mindbeat-reasons  'off' → explanation lines hidden
//   tsf-mindbeat-noexplore 'on' → exploration budget zeroed
// ---------------------------------------------------------------------------

const KEY_REC = 'tsf-mindbeat-off'
const KEY_REASONS = 'tsf-mindbeat-reasons'
const KEY_NOEXPLORE = 'tsf-mindbeat-noexplore'

function readSwitch(key: string, disabledValue: string): boolean {
  try {
    return localStorage.getItem(key) === disabledValue
  } catch {
    return false
  }
}

function writeSwitch(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode — the toggle still applies for this session */
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const BLOCK_LABEL: Record<DaypartBlock, string> = {
  morning: 'morning',
  afternoon: 'afternoon',
  evening: 'evening',
  night: 'night',
  lateNight: 'late-night',
}

function fmtWeight(w: number): string {
  return w >= 100 ? Math.round(w).toString() : w.toFixed(1)
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Horizontal evidence-weight bar (∝ normalized weight) + per-item actions. */
function WeightRow({
  item,
  rank,
  max,
  pending,
  onBoost,
  onMute,
  onWrongOpen,
  wrongOpen,
  children,
}: {
  item: WeightedItem
  rank: number
  max: number
  pending: boolean
  onBoost: () => void
  onMute: () => void
  onWrongOpen: () => void
  wrongOpen?: boolean
  children?: React.ReactNode
}) {
  const pct = max > 0 ? Math.max(4, (item.weight / max) * 100) : 0
  const label = item.name ?? item.id
  return (
    <div className="group">
      <div className="flex items-center gap-3">
        <span className="w-5 text-right text-[12px] tabular-nums text-[#6a6a6a] shrink-0">{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[14px] font-medium text-white truncate">{label}</span>
            <span className="text-[11px] tabular-nums text-[#a7a7a7] shrink-0" title="Evidence weight">
              {fmtWeight(item.weight)}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full rounded-full bg-white/[0.07] overflow-hidden">
            <div
              className={`h-full rounded-full bg-gradient-to-r from-[#1ed760] to-[#1ed760]/45 transition-[width] duration-500 ${
                pending ? 'animate-pulse' : ''
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
          <button
            onClick={onBoost}
            disabled={pending}
            className="w-7 h-7 rounded-full flex items-center justify-center text-[#1ed760] hover:bg-[#1ed760]/15 transition-colors disabled:opacity-40"
            title={`Boost ${label} (×2 weight)`}
            aria-label={`Boost ${label}`}
          >
            <TrendingUp size={14} />
          </button>
          <button
            onClick={onMute}
            disabled={pending}
            className="w-7 h-7 rounded-full flex items-center justify-center text-[#a7a7a7] hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40"
            title={`Mute ${label} — the engine forgets them`}
            aria-label={`Mute ${label}`}
          >
            <VolumeX size={14} />
          </button>
          <button
            onClick={onWrongOpen}
            disabled={pending}
            className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors disabled:opacity-40 ${
              wrongOpen ? 'text-white bg-white/10' : 'text-[#a7a7a7] hover:text-white hover:bg-white/10'
            }`}
            title={`You got me wrong — ${label}`}
            aria-label={`You got me wrong about ${label}`}
            aria-expanded={wrongOpen}
          >
            <Flag size={14} />
          </button>
        </div>
      </div>
      {children}
    </div>
  )
}

/** Inline "You got me wrong" correction flow — pick genre/mood, post it. */
function WrongFlow({
  label,
  onSubmit,
  onCancel,
  busy,
}: {
  label: string
  onSubmit: (pick: 'genre' | 'mood') => void
  onCancel: () => void
  busy: boolean
}) {
  const [pick, setPick] = useState<'genre' | 'mood'>('genre')
  return (
    <div className="mt-2 ml-8 rounded-lg bg-white/[0.04] border border-white/[0.06] p-3">
      <div className="text-[12px] text-[#a7a7a7] mb-2">
        What did the engine get wrong about <span className="text-white font-medium">{label}</span>?
      </div>
      <div className="flex items-center gap-2">
        <Select value={pick} onValueChange={(v) => setPick(v as 'genre' | 'mood')}>
          <SelectTrigger
            size="sm"
            className="bg-[#2a2a2a] border-white/10 text-white text-[12px] h-8 flex-1"
            aria-label="Pick what the engine got wrong"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-[#282828] border-white/10 text-white">
            <SelectItem value="genre" className="text-[13px] focus:bg-white/10 focus:text-white">
              Its genre read is off
            </SelectItem>
            <SelectItem value="mood" className="text-[13px] focus:bg-white/10 focus:text-white">
              Its mood read is off
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onSubmit(pick)}
          className="h-8 rounded-full bg-[#1ed760] text-black text-[12px] font-bold hover:scale-[1.03] px-4"
        >
          Send
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          className="h-8 rounded-full text-[#a7a7a7] hover:text-white hover:bg-white/10 text-[12px] px-3"
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}

/** Section heading inside the dialog. */
function SectionTitle({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {icon && <span className="text-[#1ed760]">{icon}</span>}
      <h3 className="text-[13px] font-bold uppercase tracking-wider text-[#a7a7a7]">{children}</h3>
      <span className="flex-1 h-px bg-white/[0.06]" />
    </div>
  )
}

/** One kill-switch row. checked = the feature is disabled (red when killed). */
function KillSwitch({
  title,
  description,
  hint,
  checked,
  onChange,
}: {
  title: string
  description: string
  /** optional subtitle rendered under the description (e.g. effect timing) */
  hint?: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-white">{title}</div>
        <div className="text-[12px] text-[#a7a7a7] mt-0.5 leading-relaxed">{description}</div>
        {hint && <div className="text-[11px] text-[#1ed760]/80 mt-1">{hint}</div>}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={title}
        className="data-[state=checked]:bg-[#e91429] mt-0.5 shrink-0"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TasteDNA({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [profile, setProfile] = useState<CompactProfile | null>(null)
  const [exploration, setExploration] = useState<ExplorationCounts | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [wrongKey, setWrongKey] = useState<string | null>(null)
  const [resetArmed, setResetArmed] = useState(false)
  const [recOff, setRecOff] = useState(false)
  const [reasonsOff, setReasonsOff] = useState(false)
  const [exploreOff, setExploreOff] = useState(false)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // kill switches hydrate from localStorage after mount (SSR-safe)
  useEffect(() => {
    setRecOff(readSwitch(KEY_REC, 'on'))
    setReasonsOff(readSwitch(KEY_REASONS, 'off'))
    setExploreOff(readSwitch(KEY_NOEXPLORE, 'on'))
  }, [open])

  const flashNote = useCallback((msg: string) => {
    setNote(msg)
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(null), 4200)
  }, [])

  const fetchProfile = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      // compact summary drives the surface; the full profile only adds the
      // exploration counters — if it fails we degrade to ε alone.
      const [compact, full] = await Promise.all([
        api<CompactProfile>('/api/mindbeat/profile'),
        api<{ exploration?: ExplorationCounts }>('/api/mindbeat/profile?full=1').catch(
          () => null
        ),
      ])
      setProfile(compact)
      if (full?.exploration) setExploration(full.exploration)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  // fetch on open
  useEffect(() => {
    if (open) void fetchProfile()
  }, [open, fetchProfile])

  // disarm the reset button when the dialog closes
  useEffect(() => {
    if (!open) {
      setResetArmed(false)
      setWrongKey(null)
    }
  }, [open])

  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current)
      if (resetTimer.current) clearTimeout(resetTimer.current)
    },
    []
  )

  /** POST a correction; the route replies with the fresh compact summary. */
  const act = useCallback(
    async (
      action: 'mute' | 'boost' | 'wrong' | 'reset',
      opts?: { target?: string; kind?: 'artist' | 'genre' | 'mood' }
    ) => {
      const key = opts?.target ?? action
      setPendingKey(key)
      try {
        const res = await api<{ ok: boolean; profile?: CompactProfile }>('/api/mindbeat/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ...opts }),
        })
        if (res.profile) setProfile(res.profile)
        else void fetchProfile()
      } catch {
        flashNote('That correction didn\u2019t land — try again.')
      } finally {
        setPendingKey(null)
      }
    },
    [fetchProfile, flashNote]
  )

  const boost = (item: WeightedItem, kind: 'artist' | 'genre') => {
    void act('boost', { target: item.id, kind })
    flashNote(`${item.name ?? item.id} boosted \u00d72`)
  }

  const mute = (item: WeightedItem, kind: 'artist' | 'genre') => {
    void act('mute', { target: item.id, kind })
    flashNote(`The engine just forgot ${item.name ?? item.id}`)
  }

  const wrong = (item: WeightedItem, pick: 'genre' | 'mood') => {
    void act('wrong', { target: item.id, kind: pick })
    setWrongKey(null)
    flashNote(`Got it \u2014 reconsidering ${item.name ?? item.id}`)
  }

  const exportProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/mindbeat/profile?full=1')
      if (!res.ok) throw new Error(`export ${res.status}`)
      const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'tsf-taste-profile.json'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      flashNote('Taste profile downloaded as JSON.')
    } catch {
      flashNote('Export failed — the profile route didn\u2019t answer.')
    }
  }, [flashNote])

  const resetModel = useCallback(() => {
    setResetArmed(false)
    void act('reset')
    flashNote('Taste model reset. Your playlists and likes stay.')
  }, [act, flashNote])

  const toggleReset = () => {
    if (resetArmed) {
      resetModel()
      return
    }
    setResetArmed(true)
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setResetArmed(false), 6000)
  }

  const toggleRec = (v: boolean) => {
    setRecOff(v)
    writeSwitch(KEY_REC, v ? 'on' : 'off')
  }
  const toggleReasons = (v: boolean) => {
    setReasonsOff(v)
    writeSwitch(KEY_REASONS, v ? 'off' : 'on')
  }
  const toggleExplore = (v: boolean) => {
    setExploreOff(v)
    writeSwitch(KEY_NOEXPLORE, v ? 'on' : 'off')
  }

  // current daypart — prefer the server-computed cell, fall back to local math
  const nowBlock = profile?.daypart.block ?? currentDaypart().block
  const nowKind = profile?.daypart.dayKind ?? currentDaypart().dayKind

  const artists = profile?.topArtists ?? []
  const genres = profile?.topGenres ?? []
  const languages = profile?.topLanguages ?? []
  const moods = profile?.topMoods ?? []
  const maxArtist = artists[0]?.weight ?? 0
  const maxGenre = genres[0]?.weight ?? 0
  const energy = profile?.daypart.energyMean ?? null
  const energyBand = energy == null ? -1 : Math.max(0, Math.min(4, Math.floor(energy * 5)))
  const convRate =
    exploration && exploration.noveltyServed > 0
      ? Math.round((exploration.noveltyConverted / exploration.noveltyServed) * 100)
      : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="bg-[#181818] border border-white/[0.06] text-white max-w-2xl p-0 gap-0 overflow-hidden shadow-2xl shadow-black/60 max-h-[88vh]"
        aria-describedby={undefined}
      >
        <div className="p-5 pb-0">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-xl font-bold text-white">
              <span className="w-9 h-9 rounded-full bg-[#1ed760]/15 text-[#1ed760] flex items-center justify-center shrink-0">
                <Dna size={20} />
              </span>
              Taste DNA
            </DialogTitle>
            <DialogDescription className="text-[13px] text-[#a7a7a7] text-left">
              What TSF has learned about you — raw evidence weights, no black box. Every row has
              levers.
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* status / confirmation line */}
        <div aria-live="polite" className="px-5 pt-2 min-h-[22px]">
          {note ? (
            <div className="inline-flex items-center gap-1.5 text-[12px] text-[#1ed760]">
              <Check size={13} />
              {note}
            </div>
          ) : null}
        </div>

        <div className="px-5 pb-5 overflow-y-auto min-h-0 flex-1 flex flex-col gap-6">
          {/* ---------------- loading / error ---------------- */}
          {loading && !profile && (
            <div className="space-y-5" role="status" aria-label="Loading your taste profile">
              <div className="text-[13px] text-[#a7a7a7] flex items-center gap-2">
                <RefreshCw size={14} className="animate-spin" />
                Still learning your taste…
              </div>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="space-y-2">
                  <div className="h-3 w-24 rounded bg-white/[0.07]" />
                  <div className="h-4 w-full rounded bg-white/[0.05]" />
                  <div className="h-4 w-4/5 rounded bg-white/[0.05]" />
                </div>
              ))}
            </div>
          )}

          {!loading && error && (
            <div className="py-10 text-center">
              <p className="text-[15px] font-bold text-white mb-1">Couldn&apos;t load your taste profile</p>
              <p className="text-[13px] text-[#a7a7a7] mb-4">The engine didn&apos;t answer. Retry in a moment.</p>
              <Button
                size="sm"
                onClick={() => void fetchProfile()}
                className="rounded-full bg-white text-black font-bold hover:scale-105"
              >
                Retry
              </Button>
            </div>
          )}

          {!loading && !error && profile && (
            <>
              {/* ---------------- summary strip ---------------- */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="rounded-xl bg-[#1c1c1c] border border-white/[0.05] p-4">
                  <div className="text-[11px] uppercase tracking-wide text-[#a7a7a7]">Listening sessions</div>
                  <div className="text-xl font-bold text-white mt-1 tabular-nums">{profile.sessionCount}</div>
                </div>
                <div className="rounded-xl bg-[#1c1c1c] border border-white/[0.05] p-4">
                  <div className="text-[11px] uppercase tracking-wide text-[#a7a7a7]">Exploration budget</div>
                  <div className="text-xl font-bold text-[#1ed760] mt-1 tabular-nums">
                    {Math.round(profile.epsilon * 100)}%
                  </div>
                </div>
                <div className="rounded-xl bg-[#1c1c1c] border border-white/[0.05] p-4 col-span-2 sm:col-span-1">
                  <div className="text-[11px] uppercase tracking-wide text-[#a7a7a7]">Your corrections</div>
                  <div className="text-xl font-bold text-white mt-1 tabular-nums">
                    {profile.corrections.mutedArtists.length +
                      profile.corrections.mutedTracks.length +
                      Object.keys(profile.corrections.boosts).length +
                      profile.corrections.wrongLabels.length}
                  </div>
                </div>
              </div>

              {/* ---------------- top artists ---------------- */}
              <section aria-label="Top artists">
                <SectionTitle>Top artists — evidence weights</SectionTitle>
                {artists.length === 0 ? (
                  <p className="text-[13px] text-[#a7a7a7]">Nothing yet — play a few tracks and this fills in.</p>
                ) : (
                  <div className="space-y-3">
                    {artists.map((a, i) => (
                      <WeightRow
                        key={a.id + i}
                        item={a}
                        rank={i + 1}
                        max={maxArtist}
                        pending={pendingKey === a.id}
                        onBoost={() => boost(a, 'artist')}
                        onMute={() => mute(a, 'artist')}
                        onWrongOpen={() => setWrongKey(wrongKey === a.id ? null : a.id)}
                        wrongOpen={wrongKey === a.id}
                      >
                        {wrongKey === a.id && (
                          <WrongFlow
                            label={a.name ?? a.id}
                            busy={pendingKey === a.id}
                            onSubmit={(pick) => wrong(a, pick)}
                            onCancel={() => setWrongKey(null)}
                          />
                        )}
                      </WeightRow>
                    ))}
                  </div>
                )}
              </section>

              {/* ---------------- top genres ---------------- */}
              <section aria-label="Top genres">
                <SectionTitle>Top genres</SectionTitle>
                {genres.length === 0 ? (
                  <p className="text-[13px] text-[#a7a7a7]">No genre signals yet.</p>
                ) : (
                  <div className="space-y-3">
                    {genres.map((g, i) => (
                      <WeightRow
                        key={g.id + i}
                        item={g}
                        rank={i + 1}
                        max={maxGenre}
                        pending={pendingKey === g.id}
                        onBoost={() => boost(g, 'genre')}
                        onMute={() => mute(g, 'genre')}
                        onWrongOpen={() => setWrongKey(wrongKey === g.id ? null : g.id)}
                        wrongOpen={wrongKey === g.id}
                      >
                        {wrongKey === g.id && (
                          <WrongFlow
                            label={g.id}
                            busy={pendingKey === g.id}
                            onSubmit={(pick) => wrong(g, pick)}
                            onCancel={() => setWrongKey(null)}
                          />
                        )}
                      </WeightRow>
                    ))}
                  </div>
                )}
              </section>

              {/* ---------------- languages + moods ---------------- */}
              {(languages.length > 0 || moods.length > 0) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  {languages.length > 0 && (
                    <section aria-label="Top languages">
                      <SectionTitle>Languages</SectionTitle>
                      <div className="flex flex-wrap gap-2">
                        {languages.map((l, i) => (
                          <span
                            key={l.id + i}
                            className="h-7 px-3 rounded-full bg-[#2a2a2a] text-[12px] text-white flex items-center gap-1.5"
                          >
                            {l.id}
                            <span className="text-[10px] tabular-nums text-[#a7a7a7]">{fmtWeight(l.weight)}</span>
                          </span>
                        ))}
                      </div>
                    </section>
                  )}
                  {moods.length > 0 && (
                    <section aria-label="Moods">
                      <SectionTitle>Moods</SectionTitle>
                      <div className="flex flex-wrap gap-2">
                        {moods.map((m, i) => (
                          <span
                            key={m.id + i}
                            className="h-7 px-3 rounded-full bg-[#1ed760]/10 text-[#1ed760] text-[12px] flex items-center gap-1.5"
                          >
                            {m.id}
                            <span className="text-[10px] tabular-nums text-[#1ed760]/70">{fmtWeight(m.weight)}</span>
                          </span>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              )}

              {/* ---------------- daypart ---------------- */}
              <section aria-label="Daypart snapshot">
                <SectionTitle icon={<Moon size={14} />}>Daypart</SectionTitle>
                <div className="rounded-xl bg-[#1c1c1c] border border-white/[0.05] p-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="text-[15px] font-semibold text-white">
                      What the app thinks your {BLOCK_LABEL[nowBlock]} sounds like
                    </div>
                    <span className="text-[11px] px-2.5 py-1 rounded-full bg-white/[0.07] text-[#a7a7a7] capitalize">
                      {nowKind}
                    </span>
                  </div>
                  {profile.daypart.topArtists.length > 0 ? (
                    <ul className="mt-3 space-y-1.5">
                      {profile.daypart.topArtists.map((a, i) => (
                        <li key={a.id + i} className="flex items-center gap-2.5 text-[13px]">
                          <span className="w-4 text-right text-[11px] tabular-nums text-[#6a6a6a]">{i + 1}</span>
                          <span className="text-white truncate">{a.name}</span>
                          <span className="ml-auto text-[11px] tabular-nums text-[#a7a7a7]">{fmtWeight(a.weight)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[13px] text-[#a7a7a7] mt-3">
                      Not enough {BLOCK_LABEL[nowBlock]} listening yet — play something now and it learns.
                    </p>
                  )}
                  {/* energy band viz */}
                  <div className="mt-4">
                    <div className="flex items-center justify-between text-[11px] text-[#a7a7a7] mb-1.5">
                      <span>Energy</span>
                      <span className="tabular-nums">
                        {energy == null ? '—' : `${Math.round(energy * 100)}%`}
                      </span>
                    </div>
                    <div
                      className="flex gap-1"
                      role="img"
                      aria-label={`Energy level ${energy == null ? 'unknown' : Math.round(energy * 100) + ' percent'}`}
                    >
                      {[0, 1, 2, 3, 4].map((b) => (
                        <span
                          key={b}
                          className={`h-2 flex-1 rounded-full transition-colors ${
                            energyBand >= 0 && b <= energyBand ? 'bg-[#1ed760]' : 'bg-white/[0.08]'
                          }`}
                        />
                      ))}
                    </div>
                    <div className="flex justify-between text-[10px] text-[#6a6a6a] mt-1">
                      <span>chill</span>
                      <span>peak</span>
                    </div>
                  </div>
                </div>
              </section>

              {/* ---------------- exploration ---------------- */}
              <section aria-label="Exploration">
                <SectionTitle icon={<Compass size={14} />}>Exploration</SectionTitle>
                <div className="rounded-xl bg-[#1c1c1c] border border-white/[0.05] p-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-[#a7a7a7]">Novelty budget</div>
                      <div className="text-lg font-bold text-[#1ed760] tabular-nums mt-0.5">
                        {Math.round(profile.epsilon * 100)}% of picks
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-[#a7a7a7]">Fresh finds served</div>
                      <div className="text-lg font-bold text-white tabular-nums mt-0.5">
                        {exploration ? exploration.noveltyServed : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-[#a7a7a7]">Converted</div>
                      <div className="text-lg font-bold text-white tabular-nums mt-0.5">
                        {exploration ? exploration.noveltyConverted : '—'}
                        {convRate != null && (
                          <span className="ml-2 text-[12px] font-medium text-[#a7a7a7]">{convRate}%</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <p className="text-[12px] text-[#a7a7a7] mt-3 flex items-start gap-1.5">
                    <Sparkles size={13} className="text-[#1ed760] shrink-0 mt-0.5" />
                    The engine deliberately slips unfamiliar music in. Convert enough of it and it
                    serves more; skip-storm through it and the budget drops.
                  </p>
                </div>
              </section>

              {/* ---------------- kill switches ---------------- */}
              <section aria-label="MindBeat controls">
                <SectionTitle icon={<VolumeX size={14} />}>MindBeat controls</SectionTitle>
                <div className="rounded-xl bg-[#1c1c1c] border border-white/[0.05] p-4 divide-y divide-white/[0.05]">
                  <KillSwitch
                    title="Disable all recommendations"
                    description="Classic shuffle only. MindBeat stops learning and the engine stops picking."
                    hint="Takes effect on your next queue."
                    checked={recOff}
                    onChange={toggleRec}
                  />
                  <KillSwitch
                    title="Disable explanations"
                    description="Hides the “because you played…” lines on recommended tracks."
                    checked={reasonsOff}
                    onChange={toggleReasons}
                  />
                  <KillSwitch
                    title="Disable exploration"
                    description="No novelty serves — only music the model already knows you love."
                    checked={exploreOff}
                    onChange={toggleExplore}
                  />
                  <p className="text-[11px] text-[#6a6a6a] pt-2.5">
                    Switches persist on this device and apply from the next track.
                  </p>
                </div>
              </section>
            </>
          )}
        </div>

        {/* ---------------- footer ---------------- */}
        {profile && (
          <div className="border-t border-white/[0.06] bg-[#151515] px-5 py-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void fetchProfile()}
                disabled={loading}
                className="rounded-full text-[#a7a7a7] hover:text-white hover:bg-white/10 gap-1.5"
                aria-label="Refresh taste profile"
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                Refresh
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void exportProfile()}
                className="rounded-full text-[#a7a7a7] hover:text-white hover:bg-white/10 gap-1.5"
                aria-label="Export taste profile as JSON"
              >
                <Download size={14} />
                Export
              </Button>
            </div>
            {resetArmed ? (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-[#a7a7a7] max-w-[260px] leading-tight">
                  Erases all learned taste. Your playlists and likes stay.
                </span>
                <Button
                  size="sm"
                  onClick={resetModel}
                  className="rounded-full bg-[#e91429] text-white font-bold hover:scale-105 h-8"
                  aria-label="Confirm taste model reset"
                >
                  <RotateCcw size={13} className="mr-1" />
                  Reset
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setResetArmed(false)}
                  className="rounded-full text-[#a7a7a7] hover:text-white hover:bg-white/10 h-8"
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleReset}
                className="rounded-full text-[#a7a7a7] hover:text-[#e91429] hover:bg-[#e91429]/10 gap-1.5"
                aria-label="Reset taste model (two-step)"
              >
                <RotateCcw size={14} />
                Reset taste model
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
