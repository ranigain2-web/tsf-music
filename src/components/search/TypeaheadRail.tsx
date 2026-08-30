'use client'

/**
 * SEARCH V2 · Typeahead rail (reference SearchScreen renderSuggestRail).
 *
 * Recents render at 0 ms from localStorage; provider suggestions
 * (best guess → songs → artists) land when /api/ytm/typeahead answers
 * (~250 ms; silent-fail degrades to recents-only). One flat keyboard
 * model shared with the input: ArrowUp/Down + Enter — buildRailItems is
 * the single source of both the render order and the keyboard order.
 */

import { Clock3, ArrowUp, Sparkles } from 'lucide-react'
import { Artwork } from '@/components/Artwork'
import type { TypeaheadPayload } from './types'

export interface RailItem {
  key: string
  kind: 'recent' | 'topquery' | 'song' | 'artist'
  title: string
  subtitle?: string
  thumbnail?: string
  round?: boolean
}

const RECENTS_MAX = 4
const SONGS_MAX = 5
const ARTISTS_MAX = 3

/** Rail order = keyboard order: recents first (0 ms block), then the
 *  provider rows (best guess top, songs, artists). */
export function buildRailItems(
  localRecents: string[],
  ta: TypeaheadPayload | null,
  query: string,
): RailItem[] {
  const needle = query.trim().toLowerCase()
  const out: RailItem[] = []
  const seen = new Set<string>()
  const pushRecent = (r: string) => {
    const k = r.toLowerCase()
    if (seen.has(k) || out.length >= RECENTS_MAX) return
    if (needle && !k.includes(needle)) return
    seen.add(k)
    out.push({ key: `recent-${k}`, kind: 'recent', title: r })
  }
  localRecents.forEach(pushRecent)
  ta?.recents?.forEach(pushRecent)

  if (ta?.bestGuess) {
    out.push({
      key: 'topquery',
      kind: 'topquery',
      title: ta.bestGuess.title,
      subtitle: ta.bestGuess.artistName,
      thumbnail: ta.bestGuess.thumbnail,
    })
  }
  for (const s of ta?.songs ?? []) {
    if (!s.title) continue
    out.push({
      key: `song-${s.videoId}`,
      kind: 'song',
      title: s.title,
      subtitle: s.artistName,
      thumbnail: s.thumbnail,
    })
    if (out.length >= RECENTS_MAX + 1 + SONGS_MAX) break
  }
  for (const a of ta?.artists ?? []) {
    if (!a.name) continue
    out.push({
      key: `artist-${a.id}`,
      kind: 'artist',
      title: a.name,
      subtitle: 'Artist',
      thumbnail: a.thumbnail,
      round: true,
    })
    if (out.length >= RECENTS_MAX + 1 + SONGS_MAX + ARTISTS_MAX) break
  }
  return out
}

export function TypeaheadRail({
  items,
  highlight,
  onPick,
  onHighlight,
}: {
  items: RailItem[]
  highlight: number
  onPick: (title: string) => void
  onHighlight: (i: number) => void
}) {
  if (items.length === 0) return null
  const hasRecents = items.some((i) => i.kind === 'recent')
  const hasSuggestions = items.some((i) => i.kind !== 'recent')

  return (
    <div
      data-testid="search-suggest-rail"
      className="absolute left-4 right-4 top-full mt-1 z-30 rounded-lg bg-[#181818] border border-white/[0.06] shadow-[0_16px_48px_rgba(0,0,0,0.7)] p-2 max-h-[min(55vh,420px)] overflow-y-auto"
      role="listbox"
      aria-label="Search suggestions"
    >
      {hasRecents && (
        <div className="px-2 pt-1 pb-1 text-[11px] font-bold uppercase tracking-wide text-[#7a7a7a]">
          Recent searches
        </div>
      )}
      {items.map((item, i) => (
        <div
          key={item.key}
          role="option"
          aria-selected={highlight === i}
          data-testid="search-suggest-row"
          // preventDefault keeps the input focused while picking
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHighlight(i)}
          onClick={() => onPick(item.title)}
          className={`flex items-center gap-3 h-12 px-2 rounded-md cursor-pointer transition-colors ${
            highlight === i ? 'bg-white/10' : 'hover:bg-white/[0.06]'
          }`}
        >
          {item.kind === 'recent' ? (
            <span className="w-10 h-10 flex items-center justify-center shrink-0 text-[#b3b3b3]">
              <Clock3 size={19} />
            </span>
          ) : item.kind === 'artist' ? (
            <Artwork
              src={item.thumbnail}
              alt=""
              className="w-10 h-10"
              rounded="rounded-full"
              iconSize={16}
            />
          ) : item.kind === 'topquery' ? (
            <span className="w-10 h-10 rounded bg-white/[0.06] flex items-center justify-center shrink-0 text-[#1ed760]">
              <Sparkles size={17} />
            </span>
          ) : (
            <Artwork src={item.thumbnail} alt="" className="w-10 h-10" rounded="rounded" iconSize={16} />
          )}
          <span className="flex-1 min-w-0">
            <span className="block truncate text-[15px] text-white leading-tight">{item.title}</span>
            {item.subtitle && (
              <span className="block truncate text-[13px] text-[#a7a7a7] leading-tight mt-0.5">
                {item.subtitle}
              </span>
            )}
          </span>
          {item.kind === 'topquery' ? (
            <span className="shrink-0 rounded-full bg-white text-black text-[11px] font-bold px-2.5 py-1">
              Best guess
            </span>
          ) : (
            item.kind !== 'recent' && (
              <ArrowUp size={15} className="shrink-0 text-[#7a7a7a]" aria-hidden />
            )
          )}
        </div>
      ))}
      {hasSuggestions && !hasRecents && (
        <div className="px-2 pt-1 pb-1 text-[11px] font-bold uppercase tracking-wide text-[#7a7a7a]">
          Suggestions
        </div>
      )}
    </div>
  )
}
