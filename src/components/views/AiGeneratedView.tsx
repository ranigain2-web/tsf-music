'use client'

/**
 * TSF Music — AI-generated playlist view
 *
 * Renders any AI-generated playlist that exposes a GET endpoint returning:
 *   { id, title, subtitle, cover?, tracks: PlayerTrack[] }
 *
 * Used for:
 *   - Discover Weekly (endpoint: /api/ai/discover-weekly)
 *   - Release Radar  (endpoint: /api/ai/release-radar)
 *   - Daylist         (endpoint: /api/ai/daylist)
 *   - On Repeat       (endpoint: /api/ai/on-repeat)
 *   - Mood hubs       (endpoint: /api/ai/mood-playlists?mood=chill)
 */

import { useEffect, useState } from 'react'
import { Play, Shuffle, MoreHorizontal, Clock3, Sparkles, RefreshCw } from 'lucide-react'
import { usePlayer, type PlayerTrack } from '@/store/player'
import { api } from '@/store/nav'
import { TrackRow } from '@/components/shared'

interface AiGeneratedData {
  id: string
  title: string
  subtitle: string
  cover?: string
  emoji?: string
  gradient?: [string, string]
  tracks: PlayerTrack[]
}

interface Props {
  endpoint: string
  title: string
  subtitle?: string
  gradient?: [string, string]
  emoji?: string
}

export function AiGeneratedView({ endpoint, title, subtitle, gradient, emoji }: Props) {
  const [data, setData] = useState<AiGeneratedData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const playQueue = usePlayer((s) => s.playQueue)
  const toggleShuffle = usePlayer((s) => s.toggleShuffle)
  const shuffle = usePlayer((s) => s.shuffle)

  const load = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const r = await api<AiGeneratedData>(endpoint)
      setData(r)
    } catch { /* skip */ }
    finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!cancelled) setLoading(true)
      try {
        const r = await api<AiGeneratedData>(endpoint)
        if (!cancelled) setData(r)
      } catch { /* skip */ }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [endpoint])

  if (loading && !data) {
    return (
      <div className="px-4 lg:px-6 pt-6">
        <div className="flex gap-6 items-end">
          <div className="w-[180px] h-[180px] lg:w-[232px] lg:h-[232px] rounded animate-pulse" style={{ background: `linear-gradient(135deg, ${gradient?.[0] || '#3d3d3d'}, ${gradient?.[1] || '#1f1f1f'})` }} />
          <div className="flex-1 space-y-3">
            <div className="h-4 w-16 bg-white/5 rounded animate-pulse" />
            <div className="h-12 w-3/4 bg-white/5 rounded animate-pulse" />
            <div className="h-4 w-1/2 bg-white/5 rounded animate-pulse" />
          </div>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="py-24 text-center">
        <p className="text-xl font-bold text-white">Could not load this playlist.</p>
        <button onClick={() => load(true)} className="mt-4 text-sm text-[#1ed760] hover:underline">
          Try again
        </button>
      </div>
    )
  }

  const tracks = data.tracks || []
  const cover = data.cover
  const heroGradient = gradient || ['#3d3d3d', '#1f1f1f']
  const totalSec = tracks.reduce((acc, t) => acc + (t.duration || 0), 0)
  const fmtTotal = (s: number) =>
    s >= 3600 ? `${Math.floor(s / 3600)} hr ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`

  return (
    <div>
      {/* hero */}
      <header
        className="px-4 lg:px-6 pt-6 pb-6 flex gap-6 items-end"
        style={{ background: `linear-gradient(180deg, ${heroGradient[0]} 0%, ${heroGradient[1]} 100%)` }}
      >
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" className="w-[140px] h-[140px] lg:w-[232px] lg:h-[232px] object-cover rounded shadow-[0_16px_48px_rgba(0,0,0,0.6)] shrink-0" />
        ) : (
          <div
            className="w-[140px] h-[140px] lg:w-[232px] lg:h-[232px] rounded flex items-center justify-center text-6xl shrink-0 shadow-[0_16px_48px_rgba(0,0,0,0.6)]"
            style={{ background: `linear-gradient(135deg, ${heroGradient[0]}, ${heroGradient[1]})` }}
          >
            <span>{data.emoji || emoji || '✨'}</span>
          </div>
        )}
        <div className="min-w-0 pb-1">
          <p className="text-[13px] font-semibold uppercase tracking-wide text-white/90 mb-2 flex items-center gap-2">
            <Sparkles size={14} /> AI-generated playlist
          </p>
          <h1 className="text-3xl lg:text-6xl font-extrabold text-white tracking-tight leading-tight mb-4 line-clamp-2 break-words">
            {data.title || title}
          </h1>
          <p className="text-sm text-white/70 mb-2 line-clamp-2">{data.subtitle || subtitle}</p>
          <p className="text-sm text-white/90">
            <span className="font-bold">TSF Music</span> • <span>{tracks.length} songs,</span>{' '}
            <span className="text-white/70">{fmtTotal(totalSec)}</span>
          </p>
        </div>
      </header>

      {/* action bar */}
      <div className="sticky top-0 z-10 bg-gradient-to-b from-[#1f1f1f] to-[#121212] px-4 lg:px-6 py-4 flex items-center gap-6">
        <button
          onClick={() => tracks.length && playQueue(tracks, 0, data.title)}
          disabled={!tracks.length}
          className="w-14 h-14 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105 hover:bg-[#3be477] active:scale-95 transition-transform shadow-xl disabled:opacity-50"
          aria-label="Play playlist"
        >
          <Play size={24} fill="currentColor" className="translate-x-[1px]" />
        </button>
        <button
          onClick={() => {
            if (!shuffle) toggleShuffle()
            if (tracks.length) playQueue(tracks, Math.floor(Math.random() * tracks.length), data.title)
          }}
          className={`transition-colors ${shuffle ? 'text-[#1ed760]' : 'text-[#b3b3b3] hover:text-white'}`}
          aria-label="Shuffle"
        >
          <Shuffle size={28} fill={shuffle ? 'currentColor' : 'none'} />
        </button>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="text-[#b3b3b3] hover:text-white transition-colors disabled:opacity-50"
          aria-label="Refresh playlist"
          title="Refresh"
        >
          <RefreshCw size={24} className={refreshing ? 'animate-spin' : ''} />
        </button>
        <button className="text-[#b3b3b3] hover:text-white transition-colors" aria-label="More options">
          <MoreHorizontal size={28} />
        </button>
      </div>

      {/* track table */}
      <div className="px-4 lg:px-6 pb-8">
        {tracks.length ? (
          <>
            <div className="grid grid-cols-[16px_4fr_2fr_60px] gap-4 px-4 border-b border-white/10 pb-2 mb-2 text-[13px] text-[#a7a7a7]">
              <span className="text-right">#</span>
              <span>Title</span>
              <span className="hidden lg:block">Album</span>
              <span className="flex justify-end"><Clock3 size={16} /></span>
            </div>
            {tracks.map((t, i) => (
              <TrackRow
                key={t.videoId + i}
                track={t}
                index={i}
                onPlay={() => playQueue(tracks, i, data.title)}
              />
            ))}
            <div className="mt-6 text-[11px] text-[#7a7a7a]">
              Generated for you by TSF Music · refreshes periodically
            </div>
          </>
        ) : (
          <div className="py-24 text-center">
            <p className="text-xl font-bold text-white mb-2">Nothing here yet</p>
            <p className="text-sm text-[#a7a7a7] mb-4">Play some music to populate this playlist, or refresh.</p>
            <button onClick={() => load(true)} className="px-5 py-2 rounded-full bg-[#1ed760] text-black font-semibold">
              Refresh
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
