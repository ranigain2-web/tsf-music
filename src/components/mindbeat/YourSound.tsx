'use client'

/**
 * TSF Music — Your Sound (Wrapped-grade listening stats)
 *
 * Lives inside Your Library as the "Your Sound" chip/tab. Everything is
 * computed CLIENT-SIDE from the raw history feed:
 *   GET /api/library/history?limit=200&raw=1
 *     → per-play rows with { msPlayed, playedAt } (no dedupe)
 *
 * THE 30-SECOND RULE: a play only counts when msPlayed ≥ 30 000.
 * Genres come from the MindBeat taste profile (compact summary) — history
 * rows carry no genre tags, and we don't fake data we don't have.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Clock3,
  TrendingUp,
  TrendingDown,
  Minus,
  Sparkles,
  Flame,
  CalendarDays,
  CheckCircle2,
  Timer,
  RefreshCw,
  BarChart3,
} from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { api } from '@/store/nav'
import type { PlayerTrack } from '@/store/player'
import { currentDaypart, type DaypartBlock } from '@/lib/mindbeat/types'

// ---------------------------------------------------------------------------
// Types + helpers
// ---------------------------------------------------------------------------

type HistoryRow = PlayerTrack & { msPlayed: number; playedAt: string }

interface ProfileGenres {
  topGenres: { id: string; weight: number }[]
}

const THIRTY_S_MS = 30_000
const DAY_MS = 24 * 60 * 60 * 1000

const BLOCK_LABEL: Record<DaypartBlock, string> = {
  morning: 'morning',
  afternoon: 'afternoon',
  evening: 'evening',
  night: 'night',
  lateNight: 'late-night',
}

/** Local-time day key (YYYY-MM-DD) for streak math. */
function dayKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function humanMs(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 1) return '0m'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

function hourLabel(h: number): string {
  if (h === 0) return '12 AM'
  if (h === 12) return '12 PM'
  return h < 12 ? `${h} AM` : `${h - 12} PM`
}

/** Maps an hour onto the constitution's daypart blocks (currentDaypart logic). */
function blockOfHour(h: number): DaypartBlock {
  return currentDaypart(new Date(2024, 0, 1, h, 0)).block
}

type Trend = 'up' | 'down' | 'flat' | 'new'

function TrendArrow({ trend }: { trend: Trend }) {
  if (trend === 'up')
    return (
      <span className="inline-flex items-center gap-0.5 text-[#1ed760]" title="Rising vs the previous 15 days">
        <TrendingUp size={13} />
      </span>
    )
  if (trend === 'down')
    return (
      <span className="inline-flex items-center gap-0.5 text-[#f07078]" title="Falling vs the previous 15 days">
        <TrendingDown size={13} />
      </span>
    )
  if (trend === 'new')
    return (
      <span className="inline-flex items-center gap-0.5 text-[#1ed760]" title="New in the last 15 days">
        <Sparkles size={12} />
      </span>
    )
  return (
    <span className="inline-flex items-center gap-0.5 text-[#6a6a6a]" title="Steady vs the previous 15 days">
      <Minus size={13} />
    </span>
  )
}

function StatCard({
  icon,
  title,
  children,
  className = '',
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={`rounded-xl bg-[#181818] p-4 ${className}`}>
      <div className="flex items-center gap-2 mb-3">
        <span className="w-7 h-7 rounded-full bg-[#1ed760]/15 text-[#1ed760] flex items-center justify-center shrink-0">
          {icon}
        </span>
        <span className="text-[12px] font-bold uppercase tracking-wider text-[#a7a7a7]">{title}</span>
      </div>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stats computation (pure — testable by reading, no backend round-trips)
// ---------------------------------------------------------------------------

interface SoundStats {
  totalMs: number
  playCount: number
  clock: number[] // 24 buckets of qualifying plays
  peakHour: number
  peakCount: number
  weekdayMs: number
  weekendMs: number
  topArtists: { name: string; plays: number; trend: Trend }[]
  finishPct: number
  currentStreak: number
  longestStreak: number
  activeDays: number
}

function computeStats(rows: HistoryRow[]): SoundStats {
  const now = Date.now()
  const cut30 = now - 30 * DAY_MS
  const cut15 = now - 15 * DAY_MS

  // 30-second rule: only plays ≥ 30s count as plays. Total time sums all real ms.
  const qualifying = rows.filter((r) => r.msPlayed >= THIRTY_S_MS)
  const totalMs = rows.reduce((s, r) => s + Math.max(0, r.msPlayed || 0), 0)

  // listening clock + weekday/weekend + streaks
  const clock = new Array<number>(24).fill(0)
  let weekdayMs = 0
  let weekendMs = 0
  const days = new Set<string>()
  for (const r of qualifying) {
    const d = new Date(r.playedAt)
    clock[d.getHours()] += 1
    const dow = d.getDay()
    if (dow === 0 || dow === 6) weekendMs += r.msPlayed
    else weekdayMs += r.msPlayed
    days.add(dayKey(d))
  }

  let peakHour = 0
  let peakCount = 0
  clock.forEach((c, h) => {
    if (c > peakCount) {
      peakCount = c
      peakHour = h
    }
  })

  // top artists (history artistName counts) + trend vs the previous 15 days
  const counts = new Map<string, number>()
  const firstHalf = new Map<string, number>()
  const secondHalf = new Map<string, number>()
  for (const r of qualifying) {
    const name = r.artistName || 'Unknown artist'
    counts.set(name, (counts.get(name) ?? 0) + 1)
    const ts = new Date(r.playedAt).getTime()
    if (ts >= cut30) {
      if (ts >= cut15) secondHalf.set(name, (secondHalf.get(name) ?? 0) + 1)
      else firstHalf.set(name, (firstHalf.get(name) ?? 0) + 1)
    }
  }
  const topArtists = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, plays]) => {
      const f = firstHalf.get(name) ?? 0
      const s = secondHalf.get(name) ?? 0
      let trend: Trend = 'flat'
      if (f === 0 && s > 0) trend = 'new'
      else if (s > f) trend = 'up'
      else if (s < f) trend = 'down'
      return { name, plays, trend }
    })

  // skip profile — "you finish X% of what you start"
  // completions (≥90% of track duration) ÷ all rows with any listen time
  const started = rows.filter((r) => r.msPlayed > 0)
  const completions = started.filter((r) => {
    const durMs = r.duration > 0 ? r.duration * 1000 : 0
    return durMs > 0 && r.msPlayed / durMs >= 0.9
  }).length
  const finishPct = started.length ? Math.round((completions / started.length) * 100) : 0

  // streaks (consecutive listening days)
  const sortedDays = [...days].sort()
  let longestStreak = 0
  let run = 0
  let prev: string | null = null
  for (const d of sortedDays) {
    if (prev !== null) {
      const prevDate = new Date(`${prev}T12:00:00`)
      const curDate = new Date(`${d}T12:00:00`)
      run = Math.round(curDate.getTime() - prevDate.getTime()) === DAY_MS ? run + 1 : 1
    } else {
      run = 1
    }
    longestStreak = Math.max(longestStreak, run)
    prev = d
  }
  // current streak walks back from today (or yesterday if today hasn't started)
  const today = new Date()
  const yest = new Date(today.getTime() - DAY_MS)
  let cursor: Date | null = null
  if (days.has(dayKey(today))) cursor = today
  else if (days.has(dayKey(yest))) cursor = yest
  let currentStreak = 0
  while (cursor && days.has(dayKey(cursor))) {
    currentStreak += 1
    cursor = new Date(cursor.getTime() - DAY_MS)
  }

  return {
    totalMs,
    playCount: qualifying.length,
    clock,
    peakHour,
    peakCount,
    weekdayMs,
    weekendMs,
    topArtists,
    finishPct,
    currentStreak,
    longestStreak,
    activeDays: days.size,
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function YourSound() {
  const [rows, setRows] = useState<HistoryRow[] | null>(null)
  const [genres, setGenres] = useState<{ id: string; weight: number }[] | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    setError(false)
    try {
      const [hist, profile] = await Promise.all([
        api<{ tracks: HistoryRow[] }>('/api/library/history?limit=200&raw=1'),
        api<ProfileGenres>('/api/mindbeat/profile').catch(() => null),
      ])
      setRows(hist.tracks ?? [])
      setGenres(profile?.topGenres ?? null)
    } catch {
      setError(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const stats = useMemo<SoundStats | null>(() => (rows ? computeStats(rows) : null), [rows])

  if (error) {
    return (
      <div className="px-4 lg:px-6 py-16 text-center">
        <BarChart3 size={40} className="mx-auto mb-3 opacity-50 text-[#a7a7a7]" />
        <p className="text-lg font-bold text-white mb-1">Your Sound didn&apos;t load</p>
        <p className="text-sm text-[#a7a7a7] mb-4">The history feed didn&apos;t answer.</p>
        <button
          onClick={() => void load()}
          className="h-9 px-6 rounded-full bg-white text-black text-[13px] font-bold hover:scale-105 transition-transform"
        >
          Retry
        </button>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="px-4 lg:px-6 py-16 text-center" role="status" aria-label="Loading Your Sound">
        <RefreshCw size={26} className="mx-auto mb-3 animate-spin text-[#a7a7a7]" />
        <p className="text-sm text-[#a7a7a7]">Crunching your listening…</p>
      </div>
    )
  }

  // ---- empty state (no qualifying plays at all) ----
  if (stats.playCount === 0) {
    return (
      <div className="px-4 lg:px-6 py-16 text-center">
        <Clock3 size={40} className="mx-auto mb-3 opacity-50 text-[#a7a7a7]" />
        <p className="text-lg font-bold text-white mb-1">Nothing to show yet</p>
        <p className="text-sm text-[#a7a7a7] max-w-sm mx-auto">
          Play some music and this fills itself in. Plays count after 30 seconds — that&apos;s how
          your listening stays honest.
        </p>
      </div>
    )
  }

  const { clock, peakHour, peakCount } = stats
  const dominantBlock = blockOfHour(peakHour)
  const weekdayPct =
    stats.weekdayMs + stats.weekendMs > 0
      ? Math.round((stats.weekdayMs / (stats.weekdayMs + stats.weekendMs)) * 100)
      : 50

  return (
    <div className="px-4 lg:px-6 pb-8">
      {/* header */}
      <div className="mb-4">
        <h2 className="text-xl lg:text-2xl font-bold text-white">Your Sound</h2>
        <p className="text-[13px] text-[#a7a7a7] mt-0.5">
          Wrapped-grade stats from your real listening — plays count after 30 seconds.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* ---- total listening time ---- */}
        <StatCard icon={<Timer size={15} />} title="Total listening time">
          <div className="text-3xl font-bold text-white tabular-nums">{humanMs(stats.totalMs)}</div>
          <div className="text-[12px] text-[#a7a7a7] mt-1">
            {stats.playCount} plays past the 30-second rule · {stats.activeDays} listening{' '}
            {stats.activeDays === 1 ? 'day' : 'days'}
          </div>
        </StatCard>

        {/* ---- streaks ---- */}
        <StatCard icon={<Flame size={15} />} title="Streaks">
          <div className="flex items-end gap-6">
            <div>
              <div className="text-3xl font-bold text-[#1ed760] tabular-nums">{stats.currentStreak}</div>
              <div className="text-[12px] text-[#a7a7a7] mt-1">day streak right now</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-white tabular-nums">{stats.longestStreak}</div>
              <div className="text-[12px] text-[#a7a7a7] mt-1">longest ever</div>
            </div>
          </div>
        </StatCard>

        {/* ---- listening clock ---- */}
        <StatCard icon={<Clock3 size={15} />} title="Listening clock">
          <div className="text-[15px] font-semibold text-white">
            You&apos;re a{' '}
            <span className="text-[#1ed760]">{BLOCK_LABEL[dominantBlock]}</span> listener
          </div>
          <div className="text-[12px] text-[#a7a7a7] mt-0.5 mb-3">
            Peak hour: {hourLabel(peakHour)}
          </div>
          <div className="flex items-end gap-[3px] h-16" role="img" aria-label="Plays per hour of day">
            {clock.map((c, h) => (
              <div key={h} className="flex-1 flex flex-col justify-end h-full group/hr">
                <div
                  title={`${hourLabel(h)} — ${c} ${c === 1 ? 'play' : 'plays'}`}
                  className={`w-full rounded-sm transition-all duration-500 ${
                    h === peakHour ? 'bg-[#1ed760]' : 'bg-[#1ed760]/30 group-hover/hr:bg-[#1ed760]/60'
                  }`}
                  style={{ height: `${peakCount > 0 ? Math.max(6, (c / peakCount) * 100) : 6}%` }}
                />
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-[#6a6a6a] mt-1.5">
            <span>12 AM</span>
            <span>6 AM</span>
            <span>12 PM</span>
            <span>6 PM</span>
            <span>11 PM</span>
          </div>
        </StatCard>

        {/* ---- weekday / weekend ---- */}
        <StatCard icon={<CalendarDays size={15} />} title="Weekday vs weekend">
          <div className="text-[15px] font-semibold text-white mb-3">
            {weekdayPct >= 60
              ? 'Your week powers your sound'
              : weekdayPct <= 40
                ? 'Weekends are your stage'
                : 'An even split between work and play'}
          </div>
          <div className="flex h-3 rounded-full overflow-hidden bg-white/[0.07]">
            <div
              className="bg-[#1ed760] transition-all duration-500"
              style={{ width: `${weekdayPct}%` }}
              title={`Weekdays — ${weekdayPct}%`}
            />
            <div
              className="bg-white/25 transition-all duration-500"
              style={{ width: `${100 - weekdayPct}%` }}
              title={`Weekend — ${100 - weekdayPct}%`}
            />
          </div>
          <div className="flex justify-between text-[12px] text-[#a7a7a7] mt-2">
            <span>
              <span className="text-[#1ed760] font-semibold tabular-nums">{weekdayPct}%</span> weekdays ·{' '}
              {humanMs(stats.weekdayMs)}
            </span>
            <span>
              <span className="text-white font-semibold tabular-nums">{100 - weekdayPct}%</span> weekend ·{' '}
              {humanMs(stats.weekendMs)}
            </span>
          </div>
        </StatCard>

        {/* ---- finish rate (skip profile) ---- */}
        <StatCard icon={<CheckCircle2 size={15} />} title="Finish rate">
          <div className="text-3xl font-bold text-white tabular-nums">{stats.finishPct}%</div>
          <div className="text-[12px] text-[#a7a7a7] mt-1 mb-3">
            You finish {stats.finishPct}% of what you start
          </div>
          <Progress value={stats.finishPct} className="h-2" aria-label={`Finish rate ${stats.finishPct} percent`} />
        </StatCard>

        {/* ---- top artists with trend arrows ---- */}
        <StatCard icon={<TrendingUp size={15} />} title="Top artists — last 200 plays">
          {stats.topArtists.length === 0 ? (
            <p className="text-[13px] text-[#a7a7a7]">No qualifying plays yet.</p>
          ) : (
            <ul className="space-y-2">
              {stats.topArtists.map((a, i) => (
                <li key={a.name + i} className="flex items-center gap-2.5 text-[13px]">
                  <span className="w-4 text-right text-[11px] tabular-nums text-[#6a6a6a]">{i + 1}</span>
                  <span className="text-white truncate flex-1 min-w-0">{a.name}</span>
                  <span className="text-[11px] tabular-nums text-[#a7a7a7]">
                    {a.plays} {a.plays === 1 ? 'play' : 'plays'}
                  </span>
                  <TrendArrow trend={a.trend} />
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-[#6a6a6a] mt-3">
            Arrows compare the last 15 days against the 15 before that.
          </p>
        </StatCard>

        {/* ---- genres (from the taste model — history rows carry no genre tags) ---- */}
        {genres && genres.length > 0 && (
          <StatCard icon={<Sparkles size={15} />} title="Your genres right now" className="sm:col-span-2">
            <div className="flex flex-wrap gap-2">
              {genres.slice(0, 8).map((g, i) => (
                <span
                  key={g.id + i}
                  className="h-8 px-3.5 rounded-full bg-[#2a2a2a] text-[13px] text-white flex items-center gap-2"
                >
                  {g.id}
                  <span className="text-[10px] tabular-nums text-[#a7a7a7]">{g.weight.toFixed(1)}</span>
                </span>
              ))}
            </div>
            <p className="text-[11px] text-[#6a6a6a] mt-3">
              Live from your MindBeat taste model — see the full picture in Taste DNA (sidebar).
            </p>
          </StatCard>
        )}
      </div>
    </div>
  )
}
