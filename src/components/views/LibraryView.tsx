'use client'

/**
 * TSF Music — Your Library view
 * Spotify 2023+ anatomy (BAR-B §2.6):
 *   - header row: search toggle + grid/list toggle + sort menu
 *   - filter chips (All / Playlists / Recently played / Playback)
 *   - compact 3-column grid on mobile (square art + caption, since 2023)
 *   - list mode = h-64 rows with 48px art
 *   - live name filter + real sorting (Recents / Alphabetical / Most songs)
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Play,
  Heart,
  Music2,
  Clock3,
  Trash2,
  FastForward,
  Server,
  Search,
  X,
  LayoutGrid,
  List,
  ArrowUpDown,
  Check,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePlayer, type PlayerTrack } from '@/store/player'
import { useLibrary, type Playlist } from '@/store/library'
import { useNav, api } from '@/store/nav'
import { Shelf } from '@/components/shared'
import { YourSound } from '@/components/mindbeat/YourSound'

/** localStorage key mirrored by AudioEngine's skipSegments logic. */
const SKIP_KEY = 'tsf-skip-segments'

type LibChip = 'all' | 'playlists' | 'history' | 'playback' | 'sound'
type SortKey = 'recents' | 'alpha' | 'songs'

const SORT_LABEL: Record<SortKey, string> = {
  recents: 'Recents',
  alpha: 'Alphabetical',
  songs: 'Most songs',
}

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
            Resolution chain: yt-dlp + POT (full-length hero) → InnerTube (visionOS → iOS → TV) →
            relays → Apple catalog preview → TSF synth. Touch devices stream through this
            Mac&apos;s proxy for bulletproof playback; desktops redirect straight to the CDN for
            zero extra load.
          </div>
        </div>
      </div>
    </div>
  )
}

function sortPlaylists(list: Playlist[], key: SortKey): Playlist[] {
  const arr = [...list]
  switch (key) {
    case 'alpha':
      return arr.sort((a, b) => a.name.localeCompare(b.name))
    case 'songs':
      return arr.sort((a, b) => (b.trackCount ?? b.coverTracks?.length ?? 0) - (a.trackCount ?? a.coverTracks?.length ?? 0))
    default:
      return arr // recents — store order (newest first)
  }
}

export function LibraryView() {
  const [chip, setChip] = useState<LibChip>('all')
  const [layout, setLayout] = useState<'grid' | 'list'>('grid')
  const [sortKey, setSortKey] = useState<SortKey>('recents')
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const playlists = useLibrary((s) => s.playlists)
  const likedTracks = useLibrary((s) => s.likedTracks)
  const [history, setHistory] = useState<PlayerTrack[]>([])
  const playQueue = usePlayer((s) => s.playQueue)
  const push = useNav((s) => s.push)
  const deletePlaylist = useLibrary((s) => s.deletePlaylist)

  useEffect(() => {
    if ((chip === 'history' || chip === 'all') && !history.length) {
      void api<{ tracks: PlayerTrack[] }>('/api/library/history?limit=50')
        .then((r) => setHistory(r.tracks || []))
        .catch(() => {})
    }
  }, [chip, history.length])

  const visiblePlaylists = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q ? playlists.filter((p) => p.name.toLowerCase().includes(q)) : playlists
    return sortPlaylists(filtered, sortKey)
  }, [playlists, query, sortKey])

  const visibleHistory = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return history
    return history.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.artistName || '').toLowerCase().includes(q),
    )
  }, [history, query])

  const showGridChip = chip === 'all' || chip === 'playlists'
  const showHistoryChip = chip === 'all' || chip === 'history'

  return (
    <div className="pb-8">
      {/* ---- header: title + (search · layout · sort) like Spotify §2.6 ---- */}
      <div className="px-4 lg:px-6 pt-2 pb-3 flex items-center justify-between gap-2">
        <h1 className="text-2xl lg:text-3xl font-bold text-white">Your Library</h1>
        <div className="flex items-center gap-1">
          {/* search toggle */}
          <button
            onClick={() => {
              setSearchOpen((v) => !v)
              if (searchOpen) setQuery('')
            }}
            className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
              searchOpen ? 'text-white bg-white/10' : 'text-[#b3b3b3] hover:text-white'
            }`}
            aria-label={searchOpen ? 'Close search' : 'Search in Your Library'}
            aria-expanded={searchOpen}
          >
            {searchOpen ? <X size={19} /> : <Search size={19} />}
          </button>
          {/* grid / list toggle */}
          <button
            onClick={() => setLayout((l) => (l === 'grid' ? 'list' : 'grid'))}
            className="w-9 h-9 rounded-full flex items-center justify-center text-[#b3b3b3] hover:text-white transition-colors"
            aria-label={layout === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
          >
            {layout === 'grid' ? <List size={19} /> : <LayoutGrid size={19} />}
          </button>
          {/* sort menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="w-9 h-9 rounded-full flex items-center justify-center text-[#b3b3b3] hover:text-white transition-colors"
                aria-label="Sort Your Library"
              >
                <ArrowUpDown size={19} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-[#282828] border-white/10 text-white">
              <DropdownMenuLabel className="text-[13px] text-[#a7a7a7]">Sort by</DropdownMenuLabel>
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                <DropdownMenuItem
                  key={k}
                  onClick={() => setSortKey(k)}
                  className="gap-2 text-[14px] focus:bg-white/10 focus:text-white"
                >
                  <span className="w-4">{sortKey === k && <Check size={14} className="text-[#1ed760]" />}</span>
                  {SORT_LABEL[k]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ---- expanding search field (h-8 pill, #1f1f1f token) ---- */}
      {searchOpen && (
        <div className="px-4 lg:px-6 pb-3">
          <div className="relative">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#b3b3b3]" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search in Your Library"
              className="w-full h-8 rounded-full bg-[#1f1f1f] text-white placeholder:text-[#a7a7a7] pl-9 pr-8 text-[13px] outline-none focus:ring-1 focus:ring-white/60"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[#a7a7a7] hover:text-white"
                aria-label="Clear search"
              >
                <X size={15} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* ---- filter chips (Spotify 2023+) ---- */}
      <div className="px-4 lg:px-6 pb-4 flex gap-2 overflow-x-auto no-scrollbar" role="tablist" aria-label="Library filter">
        {([
          ['all', 'All'],
          ['playlists', 'Playlists'],
          ['history', 'Recently played'],
          ['sound', 'Your Sound'],
          ['playback', 'Playback'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={chip === key}
            onClick={() => setChip(key)}
            className={`h-8 px-4 rounded-full text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors ${
              chip === key ? 'bg-white text-black' : 'bg-[#2a2a2a] text-white hover:bg-[#3a3a3a]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ================= PLAYLISTS — compact 3-col grid or list ================= */}
      {showGridChip && (
        layout === 'grid' ? (
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-3 gap-y-4 px-4 lg:px-6">
            {/* Liked Songs — pinned purple tile */}
            <button
              onClick={() => push({ type: 'liked' })}
              className="group text-left cursor-pointer"
            >
              <div className="relative w-full aspect-square rounded-[4px] mb-2 bg-gradient-to-br from-[#4300b0] via-[#7f5af0] to-[#b8a9ff] flex items-center justify-center shadow-lg overflow-hidden">
                <Heart size={40} className="text-white" fill="currentColor" />
                {likedTracks.length > 0 && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      playQueue(likedTracks, 0, 'Liked Songs')
                    }}
                    className="card-play-btn absolute bottom-2 right-2 w-11 h-11 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105"
                  >
                    <Play size={18} fill="currentColor" />
                  </span>
                )}
              </div>
              <div className="text-[14px] font-medium text-white truncate">Liked Songs</div>
              <div className="text-[12px] text-[#b3b3b3] truncate">Playlist • {likedTracks.length} songs</div>
            </button>

            {visiblePlaylists.map((pl) => {
              const cover = pl.coverTracks?.[0]?.thumbnail
              return (
                <div
                  key={pl.id}
                  className="group relative text-left cursor-pointer"
                  onClick={() => push({ type: 'playlist', id: pl.id })}
                >
                  <div className="relative w-full aspect-square rounded-[4px] mb-2 overflow-hidden shadow-lg bg-[#282828]">
                    {cover ? (
                       
                      <img src={cover} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full bg-[#282828] flex items-center justify-center">
                        <Music2 size={36} className="text-[#535353]" />
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
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(`Delete playlist "${pl.name}"?`)) void deletePlaylist(pl.id)
                      }}
                      className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity w-7 h-7 rounded-full bg-black/70 text-[#a7a7a7] hover:text-white flex items-center justify-center"
                      aria-label={`Delete ${pl.name}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <div className="text-[14px] font-medium text-white truncate">{pl.name}</div>
                  <div className="text-[12px] text-[#b3b3b3] truncate">
                    {pl.source === 'ai' ? 'AI playlist • ' : 'Playlist • '}
                    {pl.trackCount ?? pl.coverTracks?.length ?? 0} songs
                  </div>
                </div>
              )
            })}

            {visiblePlaylists.length === 0 && (
              <div className="col-span-full py-12 text-center text-[#a7a7a7]">
                <p className="text-lg font-bold text-white mb-1">
                  {query ? 'No matches' : 'No playlists yet'}
                </p>
                <p className="text-sm">
                  {query ? 'Try a different search.' : "Create one from the sidebar, or from any song's + button."}
                </p>
              </div>
            )}
          </div>
        ) : (
          /* ---- list mode: h-64 rows, 48px art (Spotify library list) ---- */
          <div className="px-2 lg:px-4">
            {/* Liked row */}
            <button
              onClick={() => push({ type: 'liked' })}
              className="w-full flex items-center gap-3 h-16 px-2 rounded-md hover:bg-[#1f1f1f] transition-colors text-left"
            >
              <div className="w-12 h-12 rounded-[4px] bg-gradient-to-br from-[#4300b0] via-[#7f5af0] to-[#b8a9ff] flex items-center justify-center shrink-0">
                <Heart size={20} className="text-white" fill="currentColor" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-medium text-white truncate">Liked Songs</div>
                <div className="text-[13px] text-[#b3b3b3] truncate">Playlist • {likedTracks.length} songs</div>
              </div>
            </button>
            {visiblePlaylists.map((pl) => {
              const cover = pl.coverTracks?.[0]?.thumbnail
              return (
                <div
                  key={pl.id}
                  onClick={() => push({ type: 'playlist', id: pl.id })}
                  className="group w-full flex items-center gap-3 h-16 px-2 rounded-md hover:bg-[#1f1f1f] transition-colors text-left cursor-pointer"
                >
                  <div className="w-12 h-12 rounded-[4px] bg-[#282828] overflow-hidden shrink-0 flex items-center justify-center">
                    {cover ? (
                       
                      <img src={cover} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <Music2 size={18} className="text-[#535353]" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-medium text-white truncate">{pl.name}</div>
                    <div className="text-[13px] text-[#b3b3b3] truncate">
                      {pl.source === 'ai' ? 'AI playlist • ' : 'Playlist • '}
                      {pl.trackCount ?? pl.coverTracks?.length ?? 0} songs
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      if (confirm(`Delete playlist "${pl.name}"?`)) void deletePlaylist(pl.id)
                    }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity w-8 h-8 rounded-full bg-black/70 text-[#a7a7a7] hover:text-white flex items-center justify-center shrink-0"
                    aria-label={`Delete ${pl.name}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )
            })}
            {visiblePlaylists.length === 0 && (
              <div className="py-12 text-center text-[#a7a7a7]">
                <p className="text-lg font-bold text-white mb-1">{query ? 'No matches' : 'No playlists yet'}</p>
                <p className="text-sm">{query ? 'Try a different search.' : "Create one from the sidebar, or from any song's + button."}</p>
              </div>
            )}
          </div>
        )
      )}

      {/* ================= RECENTLY PLAYED ================= */}
      {showHistoryChip && (
        <div className={chip === 'history' ? 'px-2 lg:px-4' : 'mt-6 px-4 lg:px-6'}>
          {chip === 'all' && <h2 className="text-xl font-bold text-white mb-3">Recently played</h2>}
          {visibleHistory.length === 0 ? (
            chip === 'history' ? (
              <div className="py-16 text-center text-[#a7a7a7]">
                <Clock3 size={40} className="mx-auto mb-3 opacity-50" />
                <p className="text-lg font-bold text-white mb-1">{query ? 'No matches' : 'Nothing here yet'}</p>
                <p className="text-sm">{query ? 'Try a different search.' : 'Songs you play will show up here.'}</p>
              </div>
            ) : null
          ) : (
            <div>
              {visibleHistory.map((t, i) => (
                <div
                  key={t.videoId + i}
                  className="group flex items-center gap-3 h-16 px-2 rounded-md hover:bg-[#1f1f1f] transition-colors cursor-pointer"
                  onClick={() => playQueue(visibleHistory, i, 'Recently played')}
                >
                  <div className="relative shrink-0">
                    {t.thumbnail ? (
                      <img src={t.thumbnail} alt="" className="w-12 h-12 object-cover rounded-[4px]" loading="lazy" />
                    ) : (
                      <div className="w-12 h-12 rounded-[4px] bg-[#282828] flex items-center justify-center">
                        <Music2 size={18} className="text-[#535353]" />
                      </div>
                    )}
                    <span className="card-play-btn absolute inset-0 m-auto w-10 h-10 rounded-full bg-[#1ed760] text-black items-center justify-center hidden group-hover:flex hover:scale-105">
                      <Play size={16} fill="currentColor" />
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-medium text-white truncate">{t.title}</div>
                    <div className="text-[13px] text-[#b3b3b3] truncate">{t.artistName}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ================= YOUR SOUND — Wrapped-grade stats ================= */}
      {chip === 'sound' && <YourSound />}

      {/* ================= PLAYBACK SETTINGS ================= */}
      {chip === 'playback' && <PlaybackSettings />}
    </div>
  )
}
