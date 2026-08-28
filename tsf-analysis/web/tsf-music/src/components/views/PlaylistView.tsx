'use client'

/**
 * TSF Music — Playlist detail view
 */

import { useEffect, useState } from 'react'
import { Play, Shuffle, MoreHorizontal, Clock3, Trash2, Sparkles, Loader2, Plus } from 'lucide-react'
import { usePlayer, type PlayerTrack } from '@/store/player'
import { useLibrary } from '@/store/library'
import { api } from '@/store/nav'
import { TrackRow } from '@/components/shared'

export function PlaylistView({ id }: { id: string }) {
  const [pl, setPl] = useState<{ id: string; name: string; description?: string | null; tracks: PlayerTrack[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [recommended, setRecommended] = useState<PlayerTrack[]>([])
  const [loadingRecs, setLoadingRecs] = useState(false)
  const playQueue = usePlayer((s) => s.playQueue)
  const toggleShuffle = usePlayer((s) => s.toggleShuffle)
  const shuffle = usePlayer((s) => s.shuffle)
  const removeFromPlaylist = useLibrary((s) => s.removeFromPlaylist)
  const addToPlaylist = useLibrary((s) => s.addToPlaylist)
  const refresh = useLibrary((s) => s.refresh)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void api<{ playlist: { id: string; name: string; description?: string | null; tracks: PlayerTrack[] } }>(
      `/api/library/playlists?id=${encodeURIComponent(id)}`
    )
      .then((r) => !cancelled && setPl(r.playlist))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [id])

  // Fetch recommended songs based on the playlist's tracks
  useEffect(() => {
    if (!pl || pl.tracks.length === 0) {
      setRecommended([])
      return
    }
    let cancelled = false
    setLoadingRecs(true)
    // Use up to 3 seed tracks (first, middle, last)
    const seeds = [pl.tracks[0], pl.tracks[Math.floor(pl.tracks.length / 2)], pl.tracks[pl.tracks.length - 1]]
      .filter(Boolean)
      .slice(0, 3)
      .map((t) => t.videoId)
    void api<{ tracks: PlayerTrack[] }>('/api/ai/recommended-songs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seedTrackIds: seeds, excludeTrackIds: pl.tracks.map((t) => t.videoId) }),
    })
      .then((r) => {
        if (!cancelled) setRecommended(r.tracks || [])
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoadingRecs(false))
    return () => { cancelled = true }
  }, [id, pl?.tracks.length])

  if (loading && !pl) {
    return <div className="p-6"><div className="h-[232px] bg-white/5 rounded animate-pulse" /></div>
  }
  if (!pl) return <div className="py-24 text-center text-white">Playlist not found</div>

  const cover = pl.tracks[0]?.thumbnail
  const totalSec = pl.tracks.reduce((acc, t) => acc + (t.duration || 0), 0)
  const fmtTotal = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} hr ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`)

  return (
    <div>
      <header className="bg-gradient-to-b from-[#3d3d3d] to-[#1f1f1f] px-4 lg:px-6 pt-8 pb-6 flex gap-6 items-end">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" className="w-[140px] h-[140px] lg:w-[232px] lg:h-[232px] object-cover rounded shadow-[0_16px_48px_rgba(0,0,0,0.6)] shrink-0" />
        ) : (
          <div className="w-[140px] h-[140px] lg:w-[232px] lg:h-[232px] bg-[#282828] rounded flex items-center justify-center shrink-0">
            <span className="text-white/30 text-6xl">♪</span>
          </div>
        )}
        <div className="min-w-0 pb-1">
          <p className="text-[13px] font-semibold uppercase tracking-wide text-white/90 mb-2">Playlist</p>
          <h1 className="text-3xl lg:text-6xl font-extrabold text-white tracking-tight mb-4 line-clamp-2 break-words">{pl.name}</h1>
          {pl.description && <p className="text-sm text-white/70 mb-2 line-clamp-2">{pl.description}</p>}
          <p className="text-sm text-white/90">
            <span className="font-bold">TSF Music</span> • <span>{pl.tracks.length} songs,</span>{' '}
            <span className="text-white/70">{fmtTotal(totalSec)}</span>
          </p>
        </div>
      </header>

      <div className="sticky top-0 z-10 bg-gradient-to-b from-[#1f1f1f] to-[#121212] px-4 lg:px-6 py-4 flex items-center gap-6">
        <button
          onClick={() => pl.tracks.length && playQueue(pl.tracks, 0, pl.name)}
          className="w-14 h-14 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105 hover:bg-[#3be477] active:scale-95 transition-transform shadow-xl disabled:opacity-50"
          disabled={!pl.tracks.length}
          aria-label="Play playlist"
        >
          <Play size={24} fill="currentColor" className="translate-x-[1px]" />
        </button>
        <button
          onClick={() => {
            if (!shuffle) toggleShuffle()
            if (pl.tracks.length) playQueue(pl.tracks, Math.floor(Math.random() * pl.tracks.length), pl.name)
          }}
          className={`transition-colors ${shuffle ? 'text-[#1ed760]' : 'text-[#b3b3b3] hover:text-white'}`}
          aria-label="Shuffle"
        >
          <Shuffle size={28} fill={shuffle ? 'currentColor' : 'none'} />
        </button>
        <button className="text-[#b3b3b3] hover:text-white transition-colors" aria-label="More">
          <MoreHorizontal size={28} />
        </button>
      </div>

      <div className="px-4 lg:px-6 pb-8">
        {pl.tracks.length ? (
          <>
            <div className="grid grid-cols-[16px_minmax(0,4fr)_minmax(0,2fr)_60px] gap-4 px-4 border-b border-white/10 pb-2 mb-2 text-[13px] text-[#a7a7a7]">
              <span className="text-right">#</span>
              <span>Title</span>
              <span className="hidden lg:block">Album</span>
              <span className="flex justify-end"><Clock3 size={16} /></span>
            </div>
            {pl.tracks.map((t, i) => (
              <TrackRow
                key={t.videoId + i}
                track={t}
                index={i}
                onPlay={() => playQueue(pl.tracks, i, pl.name)}
                onRemove={() => {
                  void removeFromPlaylist(pl.id, t.videoId).then(() => {
                    setPl({ ...pl, tracks: pl.tracks.filter((x) => x.videoId !== t.videoId) })
                    void refresh()
                  })
                }}
              />
            ))}
          </>
        ) : (
          <div className="py-24 text-center">
            <p className="text-xl font-bold text-white mb-2">Let&apos;s find something for your playlist</p>
            <p className="text-sm text-[#a7a7a7]">Search for songs and tap + to add them.</p>
          </div>
        )}

        {/* Recommended Songs — like Spotify */}
        {pl.tracks.length > 0 && (
          <div className="mt-10 pt-6 border-t border-white/10">
            <div className="flex items-center gap-2 mb-4">
              <Sparkles size={20} className="text-[#1ed760]" />
              <h2 className="text-xl font-bold text-white">Recommended</h2>
              <span className="text-xs text-[#a7a7a7] ml-2">Based on what&apos;s in this playlist</span>
            </div>

            {loadingRecs && (
              <div className="flex items-center gap-2 text-[#a7a7a7] text-sm py-4">
                <Loader2 size={16} className="animate-spin" /> Finding songs you might like…
              </div>
            )}

            {!loadingRecs && recommended.length === 0 && (
              <div className="text-[#a7a7a7] text-sm py-4">
                No recommendations right now. Try refreshing or add a few more songs.
              </div>
            )}

            {!loadingRecs && recommended.length > 0 && (
              <div className="space-y-1">
                {recommended.map((t, i) => (
                  <div
                    key={t.videoId + i}
                    className="group grid grid-cols-[16px_minmax(0,4fr)_minmax(0,2fr)_60px] items-center gap-4 px-4 rounded-[4px] text-sm h-14 hover:bg-white/10 cursor-default"
                  >
                    <span className="text-right tabular-nums text-[#a7a7a7] group-hover:hidden">{i + 1}</span>
                    <button
                      onClick={() => playQueue(recommended, i, `Recommended · ${pl.name}`)}
                      className="hidden group-hover:flex text-white justify-center"
                      aria-label={`Play ${t.title}`}
                    >
                      <Play size={14} fill="currentColor" />
                    </button>
                    <div className="flex items-center gap-3 min-w-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={t.thumbnail} alt="" className="w-10 h-10 object-cover shrink-0" loading="lazy" />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-white">{t.title}</div>
                        <div className="truncate text-[13px] text-[#a7a7a7]">{t.artistName}</div>
                      </div>
                    </div>
                    <span className="hidden lg:block text-[#a7a7a7] truncate">{t.albumName || '—'}</span>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={async () => {
                          await addToPlaylist(pl.id, t)
                          setPl({ ...pl, tracks: [...pl.tracks, t] })
                          setRecommended((r) => r.filter((x) => x.videoId !== t.videoId))
                        }}
                        className="opacity-0 group-hover:opacity-100 text-[#1ed760] hover:scale-110 transition-all"
                        aria-label={`Add ${t.title} to playlist`}
                        title="Add to this playlist"
                      >
                        <Plus size={18} />
                      </button>
                      <span className="text-[#a7a7a7] tabular-nums w-10 text-right">
                        {Math.floor(t.duration / 60)}:{String(Math.floor(t.duration % 60)).padStart(2, '0')}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export { Trash2 }

