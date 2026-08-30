'use client'

/**
 * SEARCH V2 · result row — Spotify search-list anatomy (shared TrackRow's
 * grid, tuned for engine extras):
 *   index → artwork + title + artist subtitle (+ PREVIEW tag) + caption
 *   row (Video badge · views · Lyric-match chip · truthful reason ·
 *   version-cluster count) → album (desktop) → duration.
 *
 * • artistsFull joined with ", " for the artist line (reference fix v3.3 —
 *   featured artists never collapse away).
 * • reason renders VERBATIM from the engine's closed set; no reason → no
 *   line. Never invented, never social proof.
 * • artistId/albumId are only wired to YTM browse ids — saavn/itunes ids
 *   would navigate to broken artist/album pages, so those stay plain text.
 * • Rows without videoId (iTunes preview rescue) display honestly but
 *   don't join the playable queue.
 */

import { useEffect, useState } from 'react'
import { Play } from 'lucide-react'
import { usePlayer } from '@/store/player'
import { Artwork } from '@/components/Artwork'
import { TrackContextMenu } from '@/components/player/TrackContextMenu'
import type { PlayerTrack } from '@/store/player'
import type { SearchRow } from './types'

function useIsTouch(): boolean {
  const [touch, setTouch] = useState(false)
  useEffect(() => {
    setTouch(window.matchMedia('(hover: none), (pointer: coarse)').matches)
  }, [])
  return touch
}

function fmtViews(row: SearchRow): string | undefined {
  if (row.playsRaw) return row.playsRaw
  const n = row.playCount
  if (!n || n < 1000) return undefined
  if (n >= 1e7) return `${(n / 1e7).toFixed(1).replace(/\.0$/, '')} Cr plays`
  if (n >= 1e5) return `${(n / 1e5).toFixed(1).replace(/\.0$/, '')} L plays`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M plays`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K plays`
  return undefined
}

const fmtDur = (s: number) => {
  if (!s) return '—'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

/** PlayerTrack projection — full-artist display + safe navigation ids. */
export function rowToPlayerTrack(row: SearchRow): PlayerTrack {
  return {
    videoId: row.videoId ?? '',
    title: row.title,
    artistName: row.artistsFull?.length ? row.artistsFull.join(', ') : row.artistName,
    artistId: row.source === 'ytm' || row.source === 'youtube' ? row.artistId : undefined,
    albumName: row.albumName,
    albumId: row.source === 'ytm' ? row.albumId : undefined,
    duration: row.duration,
    thumbnail: row.thumbnail,
    __reason: row.reason,
  }
}

export function SearchResultRow({
  row,
  rank,
  playable,
  onPlay,
  showAlbum = true,
}: {
  row: SearchRow
  /** the row's index in the results list (0-based) — ledger rank */
  rank: number
  playable: boolean
  onPlay: () => void
  showAlbum?: boolean
}) {
  const current = usePlayer((s) => s.queue[s.queueIndex])
  const isPlaying = usePlayer((s) => s.isPlaying)
  const toggle = usePlayer((s) => s.toggle)
  const isTouch = useIsTouch()
  const isCurrent = !!row.videoId && current?.videoId === row.videoId

  const gridTemplate = [
    '16px',
    'minmax(0,4fr)',
    showAlbum ? 'minmax(0,2fr)' : null,
    'auto',
  ]
    .filter(Boolean)
    .join(' ')

  const artistLine = row.artistsFull?.length ? row.artistsFull.join(', ') : row.artistName
  const views = row.source === 'youtube' ? fmtViews(row) : undefined
  const isVideo = row.source === 'youtube' && row.ytKind === 'video'
  const hasCaption = isVideo || views || (row.lyricMatch && row.matchedLine) || row.reason || (row.versionCount ?? 0) > 1

  const meta = (
    <div className="flex items-center gap-3 min-w-0">
      <Artwork src={row.thumbnail} alt="" className="w-10 h-10" iconSize={16} />
      <div className="min-w-0">
        <div className={`truncate font-normal ${isCurrent ? 'text-[#1ed760]' : 'text-white'}`}>
          {row.title}
        </div>
        <div className="truncate text-[13px] text-[#a7a7a7] group-hover:text-white transition-colors">
          {row.previewOnly && (
            <span className="text-[10px] font-bold tracking-wide text-[#f0b64f] border border-[#f0b64f]/40 rounded px-1 py-px mr-1.5 align-[1px]">
              PREVIEW
            </span>
          )}
          {artistLine}
        </div>
        {hasCaption && (
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
            {isVideo && (
              <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-white/80 border border-white/15 bg-white/[0.06] rounded px-1 py-px">
                Video
              </span>
            )}
            {views && (
              <span className="shrink-0 text-[11px] text-[#a7a7a7] tabular-nums">{views}</span>
            )}
            {row.lyricMatch && row.matchedLine ? (
              <span className="inline-flex items-center gap-1 min-w-0">
                <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-[#1ed760] border border-[#1ed760]/40 bg-[#1ed760]/10 rounded-full px-1.5 py-px">
                  Lyric match
                </span>
                <span className="text-[11px] text-[#c8f5d8] truncate min-w-0">
                  &ldquo;{row.matchedLine}&rdquo;
                </span>
              </span>
            ) : (
              row.reason && (
                <span className="text-[11px] text-[#7a7a7a] truncate min-w-0">{row.reason}</span>
              )
            )}
            {(row.versionCount ?? 0) > 1 && (
              <span className="shrink-0 text-[11px] text-[#7a7a7a]">
                {isVideo || views ? '· ' : ''}
                {row.versionCount} versions
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )

  return (
    <TrackContextMenu track={rowToPlayerTrack(row)}>
      <div
        className={`group grid items-center gap-4 px-4 rounded-[4px] text-sm min-h-14 py-1 ${
          isCurrent ? 'bg-white/10' : 'hover:bg-white/10 active:bg-white/10'
        } ${playable ? 'cursor-default' : 'cursor-default opacity-70'}`}
        style={{ gridTemplateColumns: gridTemplate }}
        onDoubleClick={playable ? onPlay : undefined}
        onClick={
          playable && isTouch
            ? (e) => {
                if ((e.target as HTMLElement).closest('button, a, [role="slider"]')) return
                onPlay()
              }
            : undefined
        }
        aria-disabled={!playable}
      >
        <div className="w-6 flex items-center justify-center relative tabular-nums">
          {isCurrent && isPlaying ? (
            <button onClick={toggle} className="absolute inset-0 flex items-center justify-center" aria-label="Pause">
              <span className="flex items-end gap-[2px] h-4">
                <span className="eq-bar" />
                <span className="eq-bar" />
                <span className="eq-bar" />
                <span className="eq-bar" />
              </span>
            </button>
          ) : (
            <>
              <span className={`group-hover:hidden ${isCurrent ? 'text-[#1ed760]' : 'text-[#a7a7a7]'}`}>
                {rank + 1}
              </span>
              {playable && (
                <button
                  onClick={onPlay}
                  className="hidden group-hover:flex text-white"
                  aria-label={`Play ${row.title}`}
                >
                  <Play size={14} fill="currentColor" />
                </button>
              )}
            </>
          )}
        </div>

        {meta}

        {showAlbum && (
          <div className="hidden md:block min-w-0 text-[#a7a7a7] truncate">
            {row.albumName || '—'}
          </div>
        )}

        <div className="flex items-center justify-end ml-auto">
          <span className="text-[#a7a7a7] tabular-nums w-10 text-right">{fmtDur(row.duration)}</span>
        </div>
      </div>
    </TrackContextMenu>
  )
}
