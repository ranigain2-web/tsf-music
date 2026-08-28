'use client'

/**
 * TSF Music — Album view
 * Spotify's album layout: gradient hero, play button, track table.
 */

import { useEffect, useState } from 'react'
import { Play, Shuffle, Heart, MoreHorizontal, Clock3 } from 'lucide-react'
import { usePlayer, type PlayerTrack } from '@/store/player'
import { useLibrary } from '@/store/library'
import { useNav } from '@/store/nav'
import { api } from '@/store/nav'
import { TrackRow } from '@/components/shared'

export function AlbumView({ id }: { id: string }) {
  const [data, setData] = useState<{ title: string; subtitle: string; thumbnail: string; tracks: PlayerTrack[]; offline: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const playQueue = usePlayer((s) => s.playQueue)
  const toggleShuffle = usePlayer((s) => s.toggleShuffle)
  const shuffle = usePlayer((s) => s.shuffle)
  const push = useNav((s) => s.push)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void api<{ title: string; subtitle: string; thumbnail: string; tracks: PlayerTrack[]; offline: boolean }>(
      `/api/ytm/album?id=${encodeURIComponent(id)}`
    )
      .then((r) => !cancelled && setData(r))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [id])

  if (loading && !data) {
    return (
      <div className="px-4 lg:px-6 pt-6">
        <div className="flex gap-6 items-end">
          <div className="w-[180px] h-[180px] lg:w-[232px] lg:h-[232px] bg-white/5 rounded animate-pulse" />
          <div className="flex-1 space-y-3">
            <div className="h-4 w-16 bg-white/5 rounded animate-pulse" />
            <div className="h-12 w-3/4 bg-white/5 rounded animate-pulse" />
            <div className="h-4 w-1/2 bg-white/5 rounded animate-pulse" />
          </div>
        </div>
      </div>
    )
  }

  if (!data || !data.tracks?.length) {
    return (
      <div className="py-24 text-center">
        <p className="text-xl font-bold text-white">Album not found</p>
        <button onClick={() => push({ type: 'home' })} className="mt-4 text-sm text-[#1ed760] hover:underline">
          Go home
        </button>
      </div>
    )
  }

  const { title, subtitle, thumbnail, tracks } = data
  const [kindLabel, ...subRest] = (subtitle || 'Album').split(' • ')
  const artistName = subRest.length > 1 ? subRest[0] : tracks[0]?.artistName
  const year = subRest.length > 1 ? subRest[1] : subRest[0]

  return (
    <div>
      {/* hero */}
      <header className="bg-gradient-to-b from-[#3d3d3d] to-[#1f1f1f] px-4 lg:px-6 pt-6 pb-6 flex gap-6 items-end">
        {thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbnail} alt={title} className="w-[140px] h-[140px] lg:w-[232px] lg:h-[232px] object-cover rounded shadow-[0_16px_48px_rgba(0,0,0,0.6)] shrink-0" />
        ) : (
          <div className="w-[140px] h-[140px] lg:w-[232px] lg:h-[232px] bg-[#282828] rounded shrink-0" />
        )}
        <div className="min-w-0 pb-1">
          <p className="text-[13px] font-semibold uppercase tracking-wide text-white/90 mb-2">{kindLabel}</p>
          <h1 className="text-3xl lg:text-6xl font-extrabold text-white tracking-tight leading-tight mb-4 line-clamp-2 break-words">{title}</h1>
          <p className="text-sm text-white/90 flex items-center gap-1 flex-wrap">
            {tracks[0]?.artistId ? (
              <button onClick={() => push({ type: 'artist', id: tracks[0].artistId!, title: artistName })} className="font-bold hover:underline">
                {artistName}
              </button>
            ) : (
              <span className="font-bold">{artistName}</span>
            )}
            {year && <><span>•</span><span>{year}</span></>}
            <span>•</span>
            <span>{tracks.length} songs</span>
          </p>
        </div>
      </header>

      {/* action bar */}
      <div className="sticky top-0 z-10 bg-gradient-to-b from-[#1f1f1f] to-[#121212] px-4 lg:px-6 py-4 flex items-center gap-6">
        <button
          onClick={() => playQueue(tracks, 0, title)}
          className="w-14 h-14 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105 hover:bg-[#3be477] active:scale-95 transition-transform shadow-xl"
          aria-label="Play album"
        >
          <Play size={24} fill="currentColor" className="translate-x-[1px]" />
        </button>
        <button
          onClick={() => {
            if (!shuffle) toggleShuffle()
            playQueue(tracks, Math.floor(Math.random() * tracks.length), title)
          }}
          className={`transition-colors ${shuffle ? 'text-[#1ed760]' : 'text-[#b3b3b3] hover:text-white'}`}
          aria-label="Shuffle play"
          title="Shuffle play"
        >
          <Shuffle size={28} fill={shuffle ? 'currentColor' : 'none'} />
        </button>
        <button className="text-[#b3b3b3] hover:text-white transition-colors" aria-label="More options">
          <MoreHorizontal size={28} />
        </button>
      </div>

      {/* track table header */}
      <div className="px-4 lg:px-6">
        <div className="grid grid-cols-[16px_4fr_2fr_60px] lg:grid-cols-[16px_6fr_4fr_minmax(120px,2fr)60px] gap-4 px-4 border-b border-white/10 pb-2 mb-2 text-[13px] text-[#a7a7a7]">
          <span className="text-right tabular-nums">#</span>
          <span>Title</span>
          <span className="hidden lg:block">Album</span>
          <span className="flex items-center justify-end">
            <Clock3 size={16} />
          </span>
        </div>

        {tracks.map((t, i) => (
          <TrackRow key={t.videoId + i} track={t} index={i} onPlay={() => playQueue(tracks, i, title)} />
        ))}

        <div className="mt-6 pb-8 text-[11px] text-[#7a7a7a]">
          {data.offline ? 'Offline cached data' : 'Data from YouTube Music'}
        </div>
      </div>
    </div>
  )
}
