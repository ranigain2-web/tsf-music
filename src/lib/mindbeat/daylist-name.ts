/**
 * MINDBEAT v2.0 — DAYLIST v2 "NOW SOUND" naming + block math (PURE helpers).
 *
 * Split out of the daylist brain so lightweight surfaces (featured cards)
 * can render the next-shift hint without pulling the engine/DB stack.
 *
 * The verified Spotify daylist mechanic this mirrors (plan §9.4):
 *   - a name per (block, dayKind, taste) in the daylist pattern
 *     "descriptor + microgenre" — "Late-Night Hindi Slowcore",
 *     "Sunday Morning Soft Pop" — deterministic within the block,
 *     varying across blocks.
 *   - a "next shift" hint — "Shifts around 5 pm" — the next block boundary.
 *
 * Blocks are the constitution's five Heggli blocks (types.ts):
 *   morning / afternoon / evening / night / lateNight, weekday + weekend.
 *
 * PURE — no imports beyond types.ts, no I/O, safe on client and server.
 */

import {
  BLOCK_BOUNDARIES,
  type DayKind,
  type DaypartBlock,
} from '@/lib/mindbeat/types'

// ---------------------------------------------------------------------------
// Block energy priors (plan §6.3 Heggli-style diurnal curve).
// Used when the profile's daypart cell has no trustworthy energyMean yet —
// the daylist still has to sound like the block ("no 9am pool at 11pm").
// Tunable priors, never magic: a cell with ≥3 sessions always wins.
// ---------------------------------------------------------------------------

export const BLOCK_ENERGY_PRIOR: Record<DaypartBlock, Record<DayKind, number>> = {
  morning:   { weekday: 0.55, weekend: 0.45 },
  afternoon: { weekday: 0.62, weekend: 0.60 },
  evening:   { weekday: 0.68, weekend: 0.65 },
  night:     { weekday: 0.45, weekend: 0.50 },
  lateNight: { weekday: 0.30, weekend: 0.35 },
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** FNV-1a → [0,1). Deterministic picker (same contract as decision.ts). */
export function hash01(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 0x100000000
}

function pick<T>(arr: readonly T[], seed: string): T {
  return arr[Math.floor(hash01(seed) * arr.length) % arr.length]
}

function capitalize(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// Next-shift hint ("Shifts around 5 pm")
// ---------------------------------------------------------------------------

/** "4 pm"-style label for an hour (0-23). */
export function fmtHour(h: number): string {
  const hh = h % 12 === 0 ? 12 : h % 12
  return `${hh} ${h < 12 ? 'am' : 'pm'}`
}

/**
 * The next block boundary after `now` for the given dayKind (defaults to the
 * real current daypart's kind), wrapping across midnight. Human hint only —
 * the block math itself always uses currentDaypart().
 *
 * `hourOverride` lets shadow-tested builds (?forceBlock=…) render the hint
 * for the SERVED block instead of the real clock.
 */
export function nextShiftHint(now = new Date(), dayKind?: DayKind, hourOverride?: number): string {
  const kind: DayKind = dayKind ?? (
    now.getDay() === 0 || now.getDay() === 6 ? 'weekend' : 'weekday'
  )
  const i = kind === 'weekday' ? 0 : 1
  const starts = (Object.keys(BLOCK_BOUNDARIES) as DaypartBlock[])
    .map((b) => BLOCK_BOUNDARIES[b][i])
    .sort((a, b) => a - b)
  const h = hourOverride ?? now.getHours()
  const next = starts.find((s) => s > h) ?? starts[0] // wrap → earliest start
  return fmtHour(next)
}

// ---------------------------------------------------------------------------
// Playlist name (the verified daylist pattern)
// ---------------------------------------------------------------------------

/** Descriptor words per block — picked deterministically per (block|kind|genre). */
const BLOCK_DESCRIPTORS: Record<DaypartBlock, Record<DayKind, string[]>> = {
  morning: {
    weekday: ['Soft Morning', 'Fresh Morning', 'Golden Morning'],
    weekend: ['Weekend Morning', 'Slow Morning', 'Easy Morning'],
  },
  afternoon: {
    weekday: ['Golden Afternoon', 'Midday Drift', 'Easy Afternoon'],
    weekend: ['Weekend Afternoon', 'Sunny Afternoon', 'Laid-Back Afternoon'],
  },
  evening: {
    weekday: ['Warm Evening', 'Golden Hour', 'After-Work'],
    weekend: ['Weekend Evening', 'Sundown', 'Evening Unwind'],
  },
  night: {
    weekday: ['Night', 'After Dark', 'Night Wind-Down'],
    weekend: ['Night', 'After Dark', 'Late Evening'],
  },
  lateNight: {
    weekday: ['After Hours', 'Late Night', '2 AM'],
    weekend: ['After Hours', 'Late Night', 'Night Owl'],
  },
}

/** Genre flavor follows the block's energy band (calm / mid / energetic). */
const FLAVOR_WORDS = {
  calm: ['Soft', 'Mellow', 'Quiet', 'Slow'],
  mid: ['Soft', 'Easy', 'Smooth', 'Golden'],
  energetic: ['Upbeat', 'Bright', 'Feel-Good', 'Bouncy'],
} as const

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Common ISO-ish language codes → display words (only mapped ones are used). */
const LANG_WORDS: Record<string, string> = {
  hi: 'Hindi', es: 'Spanish', ta: 'Tamil', pt: 'Portuguese', ko: 'Korean',
  ar: 'Arabic', fr: 'French', de: 'German', ja: 'Japanese', zh: 'Mandarin',
  it: 'Italian', ru: 'Russian', tr: 'Turkish', pa: 'Punjabi', bn: 'Bengali',
  ml: 'Malayalam', te: 'Telugu', mr: 'Marathi', ur: 'Urdu', id: 'Indonesian',
  th: 'Thai', vi: 'Vietnamese', nl: 'Dutch', sv: 'Swedish', pl: 'Polish',
  fa: 'Persian', he: 'Hebrew', el: 'Greek', uk: 'Ukrainian', fil: 'Filipino',
}

export function prettyLanguage(lang: string | null | undefined): string | null {
  if (!lang) return null
  const l = lang.toLowerCase().trim()
  if (!l || l === 'unknown' || l === 'en' || l === 'english') return null
  return LANG_WORDS[l] ?? capitalize(l)
}

export function bandOfEnergy(energy: number): keyof typeof FLAVOR_WORDS {
  if (energy < 0.35) return 'calm'
  if (energy <= 0.65) return 'mid'
  return 'energetic'
}

export interface DaylistNameInput {
  block: DaypartBlock
  dayKind: DayKind
  /** the profile's top genre word (e.g. "Pop") — optional on cold profiles */
  topGenre?: string | null
  /** the profile's top language (e.g. "hi") — optional */
  topLanguage?: string | null
  /** block energy target (cell energyMean or the prior) */
  energy: number
  now?: Date
}

/**
 * Deterministic per (block, dayKind, taste): stable inside the block,
 * varying across blocks — the verified daylist mechanic. Examples:
 *   "Late Night Hindi Soft Pop" · "Sunday Morning Slow Bollywood" ·
 *   "After Hours Quiet Electronic".
 */
export function daylistName(input: DaylistNameInput): string {
  const { block, dayKind } = input
  const now = input.now ?? new Date()
  const genreWord = input.topGenre ? capitalize(input.topGenre.split(/[\s,]+/)[0]) : 'Mix'
  const flavor = pick(FLAVOR_WORDS[bandOfEnergy(input.energy)], `${block}|${dayKind}|${genreWord}|flavor`)

  // Descriptor: on a real weekend day, morning/afternoon blocks get the day
  // name ("Sunday Morning Soft Pop" — the verified pattern); otherwise the
  // per-block descriptor table.
  const dow = now.getDay()
  let descriptor: string
  if (dayKind === 'weekend' && (dow === 0 || dow === 6) && (block === 'morning' || block === 'afternoon')) {
    descriptor = `${DAY_NAMES[dow]} ${block === 'morning' ? 'Morning' : 'Afternoon'}`
  } else {
    descriptor = pick(BLOCK_DESCRIPTORS[block][dayKind], `${block}|${dayKind}|${genreWord}|desc`)
  }

  const langWord = prettyLanguage(input.topLanguage)
  return [descriptor, langWord, flavor, genreWord].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}
