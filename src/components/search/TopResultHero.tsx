'use client'

/**
 * SEARCH V2 · Top-result hero (reference "Top result" card — Spotify's
 * hero: big artwork, large title, type chip, artist line, truthful
 * reason / lyric chip, green play FAB). The card plays the full results
 * queue at index 0.
 */

import { Play } from 'lucide-react'
import { Artwork } from '@/components/Artwork'
import { TextQuote } from 'lucide-react'
import type { SearchRow } from './types'

/** Closed, honest type label per source (never invented). */
export function rowTypeLabel(row: SearchRow): string {
  if (row.source === 'youtube') return row.ytKind === 'video' ? 'YT Video' : 'YT Song'
  if (row.source === 'itunes') return 'Preview'
  return 'Song'
}

export function TopResultHero({
  row,
  playable,
  onPlay,
}: {
  row: SearchRow
  playable: boolean
  onPlay: () => void
}) {
  const artistLine = row.artistsFull?.length ? row.artistsFull.join(', ') : row.artistName
  return (
    <div
      data-testid="search-top-result"
      onClick={playable ? onPlay : undefined}
      role={playable ? 'button' : undefined}
      tabIndex={playable ? 0 : undefined}
      onKeyDown={(e) => {
        if (playable && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onPlay()
        }
      }}
      aria-label={playable ? `Play ${row.title}` : row.title}
      className={`relative bg-[#181818] hover:bg-[#282828] p-5 max-lg:p-3.5 rounded-lg transition-colors ${
        playable ? 'cursor-pointer' : 'cursor-default'
      }`}
    >
      <Artwork
        src={row.thumbnail}
        alt={row.title}
        className="w-[92px] h-[92px] max-lg:w-16 max-lg:h-16 object-cover shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
        rounded="rounded-md"
        iconSize={30}
      />
      <div className="text-xl lg:text-2xl font-bold text-white line-clamp-2 mt-4 max-lg:mt-2 mb-2">
        {row.title}
      </div>
      <div className="flex items-center gap-2.5 mb-2.5">
        <span className="bg-[#2a2a2a] px-2.5 py-1 rounded-full uppercase text-[11px] font-bold tracking-wide text-white shrink-0">
          {rowTypeLabel(row)}
        </span>
        <span className="text-[13px] text-[#a7a7a7] truncate min-w-0">{artistLine}</span>
      </div>
      {row.lyricMatch && row.matchedLine ? (
        <div
          data-testid="top-lyric-chip"
          className="inline-flex items-center gap-1.5 max-w-full rounded-full border border-[#1ed760]/40 bg-[#1ed760]/10 px-2.5 py-1"
        >
          <TextQuote size={12} className="text-[#1ed760] shrink-0" />
          <span className="text-[11px] font-bold uppercase tracking-wide text-[#1ed760] shrink-0">
            Lyric match
          </span>
          <span className="text-[12px] text-[#c8f5d8] truncate min-w-0">&ldquo;{row.matchedLine}&rdquo;</span>
        </div>
      ) : row.reason ? (
        <div className="text-[13px] text-[#a7a7a7] truncate">{row.reason}</div>
      ) : null}
      {playable && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onPlay()
          }}
          className="absolute bottom-5 right-5 max-lg:bottom-3.5 max-lg:right-3.5 w-12 h-12 max-lg:w-10 max-lg:h-10 rounded-full bg-[#1ed760] text-black flex items-center justify-center shadow-xl hover:scale-105 hover:bg-[#3be477] active:scale-95 transition-transform"
          aria-label={`Play ${row.title}`}
        >
          <Play size={20} fill="currentColor" className="translate-x-[1px]" />
        </button>
      )}
      {!playable && row.previewOnly && (
        <div className="text-[11px] font-bold uppercase tracking-wide text-[#7a7a7a] mt-1">
          30s preview — queuing unavailable
        </div>
      )}
    </div>
  )
}
