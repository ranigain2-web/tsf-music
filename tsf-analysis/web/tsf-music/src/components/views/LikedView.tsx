'use client'

/**
 * TSF Music — Liked Songs view (purple gradient)
 */

import { Play, Search, SortAsc } from 'lucide-react'
import { usePlayer } from '@/store/player'
import { useLibrary } from '@/store/library'
import { TrackRow } from '@/components/shared'

export function LikedView() {
  const likedTracks = useLibrary((s) => s.likedTracks)
  const playQueue = usePlayer((s) => s.playQueue)
  const isPlaying = usePlayer((s) => s.isPlaying)
  const current = usePlayer((s) => s.queue[s.queueIndex])

  const playingThis = likedTracks.some((t) => t.videoId === current?.videoId) && isPlaying

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
            <span className="font-bold">TSF Music</span> • <span>{likedTracks.length} songs</span>
          </p>
        </div>
      </header>

      <div className="sticky top-0 z-10 bg-[#121212]/95 backdrop-blur px-4 lg:px-6 py-4 flex items-center gap-6">
        <button
          onClick={() => likedTracks.length && playQueue(likedTracks, 0, 'Liked Songs')}
          className="w-14 h-14 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105 hover:bg-[#3be477] active:scale-95 transition-transform shadow-xl disabled:opacity-50 disabled:hover:scale-100"
          disabled={!likedTracks.length}
          aria-label="Play Liked Songs"
        >
          <Play size={24} fill="currentColor" className="translate-x-[1px]" />
        </button>
        <div className="flex items-center gap-4 text-[#a7a7a7]">
          <button className="hover:text-white transition-colors" aria-label="Search in playlist">
            <Search size={22} />
          </button>
          <button className="hover:text-white transition-colors flex items-center gap-1.5 text-[13px] font-medium" aria-label="Sort">
            <SortAsc size={20} /> Date added
          </button>
        </div>
        {playingThis && null}
      </div>

      <div className="px-4 lg:px-6 pb-8">
        {likedTracks.length ? (
          <>
            <div className="grid grid-cols-[16px_4fr_2fr_60px] gap-4 px-4 border-b border-white/10 pb-2 mb-2 text-[13px] text-[#a7a7a7]">
              <span className="text-right">#</span>
              <span>Title</span>
              <span className="hidden lg:block">Album</span>
              <span className="text-right pr-2">⏱</span>
            </div>
            {likedTracks.map((t, i) => (
              <TrackRow key={t.videoId} track={t} index={i} onPlay={() => playQueue(likedTracks, i, 'Liked Songs')} />
            ))}
          </>
        ) : (
          <div className="py-24 text-center">
            <p className="text-xl font-bold text-white mb-2">Songs you like will appear here</p>
            <p className="text-sm text-[#a7a7a7]">Save songs by tapping the heart icon.</p>
          </div>
        )}
      </div>
    </div>
  )
}
