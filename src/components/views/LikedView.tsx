'use client'

/**
 * TSF Music — Liked Songs view (purple gradient)
 *
 * Now fully wired: in-playlist search (live filter), sort menu
 * (recently added / title / artist / duration), and a Spotify-accurate
 * play/pause toggle on the hero FAB when this collection is playing.
 */

import { useMemo, useState } from 'react'
import { Play, Pause, Search, SortAsc, X, Check, ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePlayer } from '@/store/player'
import { useLibrary } from '@/store/library'
import { TrackRow } from '@/components/shared'
import type { PlayerTrack } from '@/store/player'

type SortKey = 'recent' | 'title' | 'artist' | 'duration'

const SORT_LABEL: Record<SortKey, string> = {
  recent: 'Date added',
  title: 'Title',
  artist: 'Artist',
  duration: 'Duration',
}

function sortTracks(tracks: PlayerTrack[], key: SortKey): PlayerTrack[] {
  const arr = [...tracks]
  switch (key) {
    case 'title':
      return arr.sort((a, b) => a.title.localeCompare(b.title))
    case 'artist':
      return arr.sort(
        (a, b) =>
          (a.artistName || '').localeCompare(b.artistName || '') ||
          a.title.localeCompare(b.title),
      )
    case 'duration':
      return arr.sort((a, b) => (b.duration || 0) - (a.duration || 0))
    default:
      return arr // 'recent' — server already returns newest-first
  }
}

export function LikedView() {
  const likedTracks = useLibrary((s) => s.likedTracks)
  const playQueue = usePlayer((s) => s.playQueue)
  const toggle = usePlayer((s) => s.toggle)
  const isPlaying = usePlayer((s) => s.isPlaying)
  const current = usePlayer((s) => s.queue[s.queueIndex])

  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('recent')

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? likedTracks.filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            (t.artistName || '').toLowerCase().includes(q) ||
            (t.albumName || '').toLowerCase().includes(q),
        )
      : likedTracks
    return sortTracks(filtered, sortKey)
  }, [likedTracks, query, sortKey])

  const playingThis =
    likedTracks.length > 0 &&
    likedTracks.some((t) => t.videoId === current?.videoId) &&
    isPlaying

  const heroPlay = () => {
    if (!visible.length) return
    // if this collection is already playing, the FAB becomes a pause button
    if (playingThis) {
      toggle()
      return
    }
    // if the current track is from this list, resume from it; else start fresh
    const idx = visible.findIndex((t) => t.videoId === current?.videoId)
    playQueue(visible, idx >= 0 ? idx : 0, 'Liked Songs')
  }

  return (
    <div>
      <header className="bg-gradient-to-b from-[#5038a0] to-[#33304f] px-4 lg:px-6 pt-8 pb-6 flex gap-6 items-end">
        <div className="w-[140px] h-[140px] lg:w-[232px] lg:h-[232px] rounded bg-gradient-to-br from-[#4300b0] via-[#7f5af0] to-[#b8a9ff] shadow-[0_16px_48px_rgba(0,0,0,0.6)] flex items-center justify-center shrink-0">
          <svg viewBox="0 0 24 24" className="w-[45%] h-[45%] fill-white">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
        </div>
        <div className="min-w-0 pb-1">
          <p className="text-[13px] font-semibold uppercase tracking-wide text-white/90 mb-2">Playlist</p>
          <h1 className="text-3xl lg:text-6xl font-extrabold text-white tracking-tight mb-4">Liked Songs</h1>
          <p className="text-sm text-white/90">
            <span className="font-bold">TSF Music</span> •{' '}
            <span>
              {likedTracks.length} song{likedTracks.length === 1 ? '' : 's'}
            </span>
          </p>
        </div>
      </header>

      <div className="sticky top-0 z-10 bg-[#121212]/95 backdrop-blur px-4 lg:px-6 py-4 flex items-center gap-4 lg:gap-6">
        <button
          onClick={heroPlay}
          className="w-14 h-14 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105 hover:bg-[#3be477] active:scale-95 transition-transform shadow-xl disabled:opacity-50 disabled:hover:scale-100 shrink-0"
          disabled={!visible.length}
          aria-label={playingThis ? 'Pause Liked Songs' : 'Play Liked Songs'}
        >
          {playingThis ? (
            <Pause size={24} fill="currentColor" />
          ) : (
            <Play size={24} fill="currentColor" className="translate-x-[1px]" />
          )}
        </button>

        {/* live search — inline input, Spotify-playlist style */}
        {searchOpen ? (
          <div className="flex items-center gap-2 flex-1 min-w-0 max-w-xs">
            <div className="flex items-center gap-2 flex-1 bg-[#242424] rounded-full px-3 h-9 border border-white/10 focus-within:border-white/40 transition-colors">
              <Search size={15} className="text-[#a7a7a7] shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search in Liked Songs"
                className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-[#8a8a8a]"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setQuery('')
                    setSearchOpen(false)
                  }
                }}
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="text-[#a7a7a7] hover:text-white"
                  aria-label="Clear search"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-4 text-[#a7a7a7]">
            <button
              onClick={() => setSearchOpen(true)}
              className={`hover:text-white transition-colors ${query ? 'text-[#1ed760]' : ''}`}
              aria-label="Search in playlist"
              title="Search in Liked Songs"
            >
              <Search size={22} />
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={`hover:text-white transition-colors flex items-center gap-1.5 text-[13px] font-medium ${
                    sortKey !== 'recent' ? 'text-[#1ed760]' : ''
                  }`}
                  aria-label="Sort options"
                >
                  <SortAsc size={20} /> {SORT_LABEL[sortKey]}
                  <ChevronDown size={13} className="opacity-70" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="bg-[#282828] border-white/10 text-white">
                <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-white/40">
                  Sort by
                </DropdownMenuLabel>
                {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                  <DropdownMenuItem
                    key={k}
                    onClick={() => setSortKey(k)}
                    className="gap-2 focus:bg-white/10"
                  >
                    <Check size={14} className={sortKey === k ? 'opacity-100' : 'opacity-0'} />
                    {SORT_LABEL[k]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {/* result count while filtering */}
        {query.trim() !== '' && (
          <span className="text-[12px] text-[#a7a7a7] tabular-nums shrink-0">
            {visible.length} result{visible.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="px-4 lg:px-6 pb-8">
        {visible.length ? (
          <>
            <div className="grid grid-cols-[16px_4fr_2fr_60px] gap-4 px-4 border-b border-white/10 pb-2 mb-2 text-[13px] text-[#a7a7a7]">
              <span className="text-right">#</span>
              <span>Title</span>
              <span className="hidden lg:block">Album</span>
              <span className="text-right pr-2">⏱</span>
            </div>
            {visible.map((t, i) => (
              <TrackRow
                key={t.videoId}
                track={t}
                index={i}
                onPlay={() => playQueue(visible, i, 'Liked Songs')}
              />
            ))}
          </>
        ) : (
          <div className="py-24 text-center">
            {query.trim() ? (
              <>
                <p className="text-xl font-bold text-white mb-2">No results for “{query.trim()}”</p>
                <p className="text-sm text-[#a7a7a7]">Try a different title or artist.</p>
              </>
            ) : (
              <>
                <p className="text-xl font-bold text-white mb-2">Songs you like will appear here</p>
                <p className="text-sm text-[#a7a7a7]">Save songs by tapping the heart icon.</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
