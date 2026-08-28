'use client'

/**
 * TSF Music — Your Library view
 * Playlists grid + Liked Songs + History tabs.
 */

import { useEffect, useState } from 'react'
import { Play, Heart, Music2, Clock3, Trash2, FastForward, Server } from 'lucide-react'
import { usePlayer, type PlayerTrack } from '@/store/player'
import { useLibrary } from '@/store/library'
import { useNav, api } from '@/store/nav'
import { Shelf } from '@/components/shared'

/** localStorage key mirrored by AudioEngine's skipSegments logic. */
const SKIP_KEY = 'tsf-skip-segments'

function PlaybackSettings() {
  const [skipOn, setSkipOn] = useState(true)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    try {
      setSkipOn(localStorage.getItem(SKIP_KEY) !== 'off')
    } catch { /* default on */ }
  }, [])

  const toggle = () => {
    const next = !skipOn
    setSkipOn(next)
    setTouched(true)
    try {
      localStorage.setItem(SKIP_KEY, next ? 'on' : 'off')
    } catch { /* private mode — toggle still applies this session */ }
  }

  return (
    <div className="px-4 lg:px-6 max-w-2xl">
      <div className="p-4 rounded-xl bg-[#181818]">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 w-10 h-10 rounded-full bg-[#1ed760]/15 text-[#1ed760] flex items-center justify-center shrink-0">
              <FastForward size={20} />
            </div>
            <div>
              <div className="text-[15px] font-semibold text-white">Skip non-music segments</div>
              <div className="text-[13px] text-[#a7a7a7] mt-1 leading-relaxed">
                Hops straight over intros, outros, sponsor plugs and other non-music parts using
                community-curated segment data (SponsorBlock). Most studio tracks are untouched;
                music videos with talking sections play like the clean radio edit.
              </div>
              {touched && (
                <div className="text-[12px] text-[#1ed760] mt-2">Applies to the next track you play.</div>
              )}
            </div>
          </div>
          {/* Spotify-style pill switch */}
          <button
            role="switch"
            aria-checked={skipOn}
            aria-label="Skip non-music segments"
            onClick={toggle}
            className={`relative w-12 h-7 rounded-full transition-colors shrink-0 ${
              skipOn ? 'bg-[#1ed760]' : 'bg-white/20'
            }`}
          >
            <span
              className={`absolute top-1 w-5 h-5 rounded-full bg-black transition-all ${
                skipOn ? 'left-6' : 'left-1 bg-white'
              }`}
            />
          </button>
        </div>
      </div>

      <div className="p-4 rounded-xl bg-[#181818] mt-3 flex items-start gap-3">
        <div className="mt-0.5 w-10 h-10 rounded-full bg-white/10 text-white/70 flex items-center justify-center shrink-0">
          <Server size={18} />
        </div>
        <div>
          <div className="text-[15px] font-semibold text-white">Stream engine</div>
          <div className="text-[13px] text-[#a7a7a7] mt-1 leading-relaxed">
            Resolution chain: InnerTube (visionOS → iOS → TV) → relays → Apple catalog preview →
            TSF synth. Touch devices stream through this Mac&apos;s proxy for bulletproof playback;
            desktops redirect straight to the CDN for zero extra load.
          </div>
        </div>
      </div>
    </div>
  )
}

export function LibraryView() {
  const [tab, setTab] = useState<'playlists' | 'history' | 'playback'>('playlists')
  const playlists = useLibrary((s) => s.playlists)
  const likedTracks = useLibrary((s) => s.likedTracks)
  const [history, setHistory] = useState<PlayerTrack[]>([])
  const playQueue = usePlayer((s) => s.playQueue)
  const push = useNav((s) => s.push)
  const deletePlaylist = useLibrary((s) => s.deletePlaylist)

  useEffect(() => {
    if (tab === 'history' && !history.length) {
      void api<{ tracks: PlayerTrack[] }>('/api/library/history?limit=50')
        .then((r) => setHistory(r.tracks || []))
        .catch(() => {})
    }
  }, [tab, history.length])

  return (
    <div className="pb-8">
      <div className="px-4 lg:px-6 pt-2 pb-4 flex items-center justify-between">
        <h1 className="text-2xl lg:text-3xl font-bold text-white">Your Library</h1>
        <div className="flex gap-2">
          {(['playlists', 'history', 'playback'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 h-9 rounded-full text-sm font-medium capitalize transition-colors ${
                tab === t ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'
              }`}
            >
              {t === 'playlists' ? 'Playlists' : t === 'history' ? 'Recently played' : 'Playback'}
            </button>
          ))}
        </div>
      </div>

      {tab === 'playlists' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5 px-4 lg:px-6">
          {/* Liked songs tile */}
          <button
            onClick={() => push({ type: 'liked' })}
            className="group relative p-3 rounded-lg bg-[#181818] hover:bg-[#282828] transition-colors text-left"
          >
            <div className="w-full aspect-square rounded mb-3 bg-gradient-to-br from-[#4300b0] via-[#7f5af0] to-[#b8a9ff] flex items-center justify-center shadow-lg relative overflow-hidden">
              <Heart size={48} className="text-white" fill="currentColor" />
              <span
                onClick={(e) => {
                  e.stopPropagation()
                  if (likedTracks.length) playQueue(likedTracks, 0, 'Liked Songs')
                }}
                className="card-play-btn absolute bottom-2 right-2 w-11 h-11 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105"
              >
                <Play size={18} fill="currentColor" />
              </span>
            </div>
            <div className="text-[15px] font-semibold text-white truncate">Liked Songs</div>
            <div className="text-[13px] text-[#a7a7a7] truncate">{likedTracks.length} songs</div>
          </button>

          {playlists.map((pl) => {
            const cover = pl.coverTracks?.[0]?.thumbnail
            return (
              <div key={pl.id} className="group relative p-3 rounded-lg bg-[#181818] hover:bg-[#282828] transition-colors cursor-pointer" onClick={() => push({ type: 'playlist', id: pl.id })}>
                <div className="relative w-full aspect-square rounded mb-3 overflow-hidden shadow-lg">
                  {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={cover} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-[#282828] flex items-center justify-center">
                      <Music2 size={40} className="text-[#535353]" />
                    </div>
                  )}
                  {pl.coverTracks && pl.coverTracks.length > 0 && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation()
                        void (async () => {
                          const res = await api<{ playlist: { tracks: PlayerTrack[] } }>(`/api/library/playlists?id=${pl.id}`)
                          if (res.playlist?.tracks?.length) playQueue(res.playlist.tracks, 0, pl.name)
                        })()
                      }}
                      className="card-play-btn absolute bottom-2 right-2 w-11 h-11 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105"
                    >
                      <Play size={18} fill="currentColor" />
                    </span>
                  )}
                </div>
                <div className="text-[15px] font-semibold text-white truncate">{pl.name}</div>
                <div className="text-[13px] text-[#a7a7a7] truncate">
                  {pl.source === 'ai' ? 'AI playlist' : 'Playlist'} • {pl.trackCount ?? pl.coverTracks?.length ?? 0} songs
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(`Delete playlist "${pl.name}"?`)) void deletePlaylist(pl.id)
                  }}
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity w-8 h-8 rounded-full bg-black/70 text-[#a7a7a7] hover:text-white flex items-center justify-center"
                  aria-label={`Delete ${pl.name}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )
          })}

          {playlists.length === 0 && (
            <div className="col-span-full py-16 text-center text-[#a7a7a7]">
              <p className="text-lg font-bold text-white mb-1">No playlists yet</p>
              <p className="text-sm">Create one from the sidebar, or from any song&apos;s + button.</p>
            </div>
          )}
        </div>
      ) : tab === 'playback' ? (
        <PlaybackSettings />
      ) : (
        <div className="px-4 lg:px-6">
          {history.length === 0 ? (
            <div className="py-16 text-center text-[#a7a7a7]">
              <Clock3 size={40} className="mx-auto mb-3 opacity-50" />
              <p className="text-lg font-bold text-white mb-1">Nothing here yet</p>
              <p className="text-sm">Songs you play will show up here.</p>
            </div>
          ) : (
            <Shelf title="Recently played">
              {history.map((t, i) => (
                <div
                  key={t.videoId + i}
                  className="group relative w-[157px] shrink-0 p-3 rounded-lg hover:bg-[#1f1f1f] transition-colors cursor-pointer snap-start"
                  onClick={() => playQueue(history, i, 'Recently played')}
                >
                  <div className="relative mb-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={t.thumbnail} alt="" className="w-full aspect-square object-cover rounded" loading="lazy" />
                    <span className="card-play-btn absolute bottom-2 right-2 w-11 h-11 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105">
                      <Play size={18} fill="currentColor" />
                    </span>
                  </div>
                  <div className="text-[15px] font-semibold text-white truncate">{t.title}</div>
                  <div className="text-[13px] text-[#a7a7a7] truncate mt-0.5">{t.artistName}</div>
                </div>
              ))}
            </Shelf>
          )}
        </div>
      )}
    </div>
  )
}
