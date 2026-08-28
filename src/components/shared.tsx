'use client'

/**
 * TSF Music — shared UI building blocks
 * TrackRow, Shelf (horizontal scroller), AlbumCard, ArtistCard, SectionHeader
 */

import { Heart, Plus, ListPlus, Play, Pause, Download, MoreHorizontal, Loader2, Check } from 'lucide-react'
import { usePlayer, type PlayerTrack } from '@/store/player'
import { useLibrary } from '@/store/library'
import { useNav } from '@/store/nav'
import { useEffect, useState } from 'react'
import { Artwork } from '@/components/Artwork'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

/**
 * True on touch devices (phones/tablets). On touch, a single tap on a track
 * row plays it (Spotify mobile behavior); desktop keeps double-click.
 */
function useIsTouch(): boolean {
  const [touch, setTouch] = useState(false)
  useEffect(() => {
    setTouch(window.matchMedia('(hover: none), (pointer: coarse)').matches)
  }, [])
  return touch
}

/* ---------------- Track row (Spotify table style) ---------------- */

export function TrackRow({
  track,
  index,
  onPlay,
  showAlbum = true,
  showIndex = true,
  compact = false,
  onRemove,
}: {
  track: PlayerTrack
  index: number
  onPlay: () => void
  showAlbum?: boolean
  showIndex?: boolean
  compact?: boolean
  onRemove?: () => void
}) {
  const current = usePlayer((s) => s.queue[s.queueIndex])
  const isPlaying = usePlayer((s) => s.isPlaying)
  const toggle = usePlayer((s) => s.toggle)
  const likes = useLibrary((s) => s.likes)
  const toggleLike = useLibrary((s) => s.toggleLike)
  const push = useNav((s) => s.push)
  const [addOpen, setAddOpen] = useState(false)
  const isTouch = useIsTouch()

  const isCurrent = current?.videoId === track.videoId
  const liked = likes.has(track.videoId)
  const [downloadState, setDownloadState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')

  // Adaptive grid template — must ALWAYS match the number of rendered grid
  // children, otherwise the title cluster lands in the 16px index column and
  // the title/artist render at width 0 (invisible text bug in SearchView).
  const gridTemplate = [
    showIndex ? '16px' : null, // index / play column
    'minmax(0,4fr)', // thumbnail + title + artist
    showAlbum ? 'minmax(0,2fr)' : null, // album column
    'auto', // like / add / download / duration
  ]
    .filter(Boolean)
    .join(' ')

  const fmt = (s: number) => {
    if (!s) return '—'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  const onDownload = async () => {
    if (downloadState === 'loading') return
    setDownloadState('loading')
    try {
      const r = await fetch(`/api/download?id=${encodeURIComponent(track.videoId)}&title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artistName || '')}&dur=${track.duration || 0}`)
      if (!r.ok) throw new Error('download failed')
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${track.title} - ${track.artistName}.m4a`.replace(/[/\\:*?"<>|]/g, '_')
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setDownloadState('done')
      setTimeout(() => setDownloadState('idle'), 2000)
    } catch {
      setDownloadState('error')
      setTimeout(() => setDownloadState('idle'), 2500)
    }
  }

  return (
    <>
      <div
        className={`group grid items-center gap-4 px-4 rounded-[4px] text-sm ${
          compact ? 'h-14' : 'h-14'
        } ${isCurrent ? 'bg-white/10' : 'hover:bg-white/10 active:bg-white/10'} cursor-default`}
        style={{ gridTemplateColumns: gridTemplate }}
        onDoubleClick={onPlay}
        onClick={
          isTouch
            ? (e) => {
                // taps on buttons/links inside the row keep their own action
                if ((e.target as HTMLElement).closest('button, a, [role="slider"]')) return
                onPlay()
              }
            : undefined
        }
      >
        {showIndex && (
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
                <span className={`group-hover:hidden ${isCurrent ? 'text-[#1ed760]' : 'text-[#a7a7a7]'}`}>{index + 1}</span>
                <button onClick={onPlay} className="hidden group-hover:flex text-white" aria-label={`Play ${track.title}`}>
                  <Play size={14} fill="currentColor" />
                </button>
              </>
            )}
          </div>
        )}

        <div className="flex items-center gap-3 min-w-0">
          <Artwork src={track.thumbnail} alt="" className="w-10 h-10" iconSize={16} />
          <div className="min-w-0">
            <div className={`truncate font-medium ${isCurrent ? 'text-[#1ed760]' : 'text-white'}`}>{track.title}</div>
            <div className="truncate text-[13px] text-[#a7a7a7] group-hover:text-white transition-colors">
              {track.artistId ? (
                <button
                  onClick={() => push({ type: 'artist', id: track.artistId!, title: track.artistName })}
                  className="hover:underline underline-offset-2 truncate"
                >
                  {track.artistName}
                </button>
              ) : (
                track.artistName
              )}
            </div>
          </div>
        </div>

        {showAlbum && (
          <div className="hidden md:block min-w-0 text-[#a7a7a7] truncate">
            {track.albumId ? (
              <button
                onClick={() => push({ type: 'album', id: track.albumId!, title: track.albumName })}
                className="hover:underline underline-offset-2 truncate"
              >
                {track.albumName || '—'}
              </button>
            ) : (
              track.albumName || '—'
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 lg:gap-4 ml-auto">
          {/* Mobile: Spotify shows ONLY the duration in the row (actions live
              in the full-screen player / long-press menu). Desktop: hover
              actions as before. */}
          <button
            onClick={() => void toggleLike(track)}
            className={`hidden lg:block transition-all ${
              liked ? 'text-[#1ed760] opacity-100' : 'text-[#a7a7a7] opacity-0 group-hover:opacity-100 hover:text-white'
            }`}
            aria-label={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
          >
            <Heart size={16} fill={liked ? 'currentColor' : 'none'} />
          </button>
          {/* phones DO get a like affordance — a single subtle heart,
              Spotify-mobile style (active row keeps it, others dim it) */}
          <button
            onClick={() => void toggleLike(track)}
            className={`lg:hidden p-1.5 -mr-1 ${liked ? 'text-[#1ed760]' : 'text-white/40'}`}
            aria-label={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
          >
            <Heart size={18} fill={liked ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={() => setAddOpen(true)}
            className="hidden lg:block text-[#a7a7a7] opacity-0 group-hover:opacity-100 hover:text-white transition-all"
            aria-label="Add to playlist"
          >
            <Plus size={16} />
          </button>
          <button
            onClick={onDownload}
            disabled={downloadState === 'loading'}
            className={`hidden lg:block transition-all text-[#a7a7a7] opacity-0 group-hover:opacity-100 hover:text-white ${
              downloadState === 'loading' ? 'animate-pulse text-[#1ed760]' : ''
            } ${downloadState === 'done' ? 'text-[#1ed760]' : ''} ${downloadState === 'error' ? 'text-red-500' : ''}`}
            aria-label="Download"
            title={downloadState === 'done' ? 'Downloaded' : downloadState === 'error' ? 'Failed — try again' : 'Download this track'}
          >
            {downloadState === 'loading' ? (
              <Loader2 size={16} className="animate-spin" />
            ) : downloadState === 'done' ? (
              <Check size={16} />
            ) : (
              <Download size={16} />
            )}
          </button>
          <span className="text-[#a7a7a7] tabular-nums w-10 text-right">{fmt(track.duration)}</span>
          {onRemove && (
            <button
              onClick={onRemove}
              className="hidden lg:block text-[#a7a7a7] opacity-0 group-hover:opacity-100 hover:text-white transition-all"
              aria-label="Remove"
            >
              <ListPlus size={16} />
            </button>
          )}
        </div>
      </div>

      <AddToPlaylistDialog track={track} open={addOpen} onOpenChange={setAddOpen} />
    </>
  )
}

/* ---------------- Add to playlist dialog ---------------- */

export function AddToPlaylistDialog({
  track,
  open,
  onOpenChange,
}: {
  track: PlayerTrack
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const playlists = useLibrary((s) => s.playlists)
  const addToPlaylist = useLibrary((s) => s.addToPlaylist)
  const createPlaylist = useLibrary((s) => s.createPlaylist)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#282828] border-none text-white max-w-[380px]">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold">Add to playlist</DialogTitle>
        </DialogHeader>
        <div className="max-h-72 overflow-y-auto -mx-2 px-2 space-y-1">
          <button
            onClick={async () => {
              const pl = await createPlaylist(`Playlist ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)
              if (pl) await addToPlaylist(pl.id, track)
              onOpenChange(false)
            }}
            className="w-full flex items-center gap-4 p-2 rounded-md hover:bg-white/10 transition-colors text-left"
          >
            <div className="w-12 h-12 rounded bg-white/10 flex items-center justify-center shrink-0">
              <Plus size={20} />
            </div>
            <span className="font-bold text-sm">New playlist</span>
          </button>

          {playlists.map((pl) => (
            <button
              key={pl.id}
              onClick={async () => {
                await addToPlaylist(pl.id, track)
                onOpenChange(false)
              }}
              className="w-full flex items-center gap-4 p-2 rounded-md hover:bg-white/10 transition-colors text-left"
            >
              <Artwork src={pl.coverTracks?.[0]?.thumbnail} alt="" className="w-12 h-12" iconSize={18} />
              <div className="min-w-0">
                <div className="font-bold text-sm truncate">{pl.name}</div>
                <div className="text-[13px] text-[#a7a7a7]">{pl.coverTracks?.length ?? 0} songs</div>
              </div>
            </button>
          ))}

          {creating && (
            <div className="flex gap-2 p-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Playlist name"
                className="flex-1 bg-[#3e3e3e] rounded-md px-3 h-10 text-sm outline-none"
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && name.trim()) {
                    const pl = await createPlaylist(name.trim())
                    if (pl) await addToPlaylist(pl.id, track)
                    onOpenChange(false)
                  }
                }}
              />
              <Button size="sm" className="rounded-full bg-white text-black" onClick={async () => {
                const pl = await createPlaylist(name.trim())
                if (pl) await addToPlaylist(pl.id, track)
                onOpenChange(false)
              }}>
                Create
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------- Shelf (horizontal scroller with arrows) ---------------- */

export function Shelf({
  title,
  subtitle,
  children,
  onMore,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  onMore?: () => void
}) {
  const scroll = (dir: number) => {
    const el = document.querySelector(`[data-shelf="${title}"]`) as HTMLElement | null
    el?.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' })
  }

  return (
    <section className="group/shelf mb-6">
      <div className="flex items-end justify-between px-4 lg:px-6 mb-1">
        <div>
          <h2 className="text-xl lg:text-2xl font-bold text-white tracking-tight hover:underline underline-offset-4 cursor-pointer">
            {title}
          </h2>
          {subtitle && <p className="text-[13px] text-[#a7a7a7] mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {onMore && (
            <button onClick={onMore} className="text-[13px] font-bold text-[#a7a7a7] hover:underline underline-offset-2 uppercase tracking-wide">
              Show all
            </button>
          )}
          <div className="hidden lg:flex gap-1 opacity-0 group-hover/shelf:opacity-100 transition-opacity">
            <button onClick={() => scroll(-1)} className="w-8 h-8 rounded-full bg-black/60 text-white flex items-center justify-center hover:scale-105" aria-label="Scroll left">
              ‹
            </button>
            <button onClick={() => scroll(1)} className="w-8 h-8 rounded-full bg-black/60 text-white flex items-center justify-center hover:scale-105 text-lg leading-none" aria-label="Scroll right">
              ›
            </button>
          </div>
        </div>
      </div>
      <div
        data-shelf={title}
        className="flex gap-1.5 lg:gap-4 overflow-x-auto no-scrollbar px-4 lg:px-6 pb-1 snap-x"
      >
        {children}
      </div>
    </section>
  )
}

/* ---------------- Album / playlist card ---------------- */

export function AlbumCard({
  id,
  name,
  artist,
  thumbnail,
  year,
  playTracks,
}: {
  id: string
  name: string
  artist?: string
  thumbnail: string
  year?: number
  playTracks?: () => void
}) {
  const push = useNav((s) => s.push)
  return (
    <div
      className="group relative w-[157px] lg:w-[180px] shrink-0 p-3 rounded-lg hover:bg-[#1f1f1f] transition-colors cursor-pointer snap-start"
      onClick={() => push({ type: 'album', id, title: name })}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && push({ type: 'album', id, title: name })}
      aria-label={`Album ${name}${artist ? ` by ${artist}` : ''}`}
    >
      <div className="relative mb-3">
        <Artwork
          src={thumbnail}
          alt={name}
          className="w-full aspect-square object-cover shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
          rounded="rounded"
          iconSize={28}
        />
        {playTracks && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              playTracks()
            }}
            className="card-play-btn absolute bottom-2 right-2 w-12 h-12 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105 hover:bg-[#3be477] active:scale-95"
            aria-label={`Play ${name}`}
          >
            <Play size={20} fill="currentColor" className="translate-x-[1px]" />
          </button>
        )}
      </div>
      <div className="text-[15px] font-semibold text-white truncate">{name}</div>
      <div className="text-[13px] text-[#a7a7a7] truncate mt-0.5">
        {year ? `${year} • ` : ''}
        {artist || 'Album'}
      </div>
    </div>
  )
}

/* ---------------- Artist card (circle) ---------------- */

export function ArtistCard({
  id,
  name,
  thumbnail,
  subscribers,
}: {
  id: string
  name: string
  thumbnail: string
  subscribers?: string
}) {
  const push = useNav((s) => s.push)
  return (
    <div
      className="group relative w-[157px] lg:w-[180px] shrink-0 p-3 rounded-lg hover:bg-[#1f1f1f] transition-colors cursor-pointer snap-start"
      onClick={() => push({ type: 'artist', id, title: name })}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && push({ type: 'artist', id, title: name })}
      aria-label={`Artist ${name}`}
    >
      <div className="relative mb-3">
        <Artwork
          src={thumbnail}
          alt={name}
          className="w-full aspect-square object-cover"
          rounded="rounded-full"
          iconSize={28}
        />
      </div>
      <div className="text-[15px] font-semibold text-white truncate text-center">{name}</div>
      {subscribers && <div className="text-[13px] text-[#a7a7a7] truncate text-center mt-0.5">{subscribers}</div>}
    </div>
  )
}

/* ---------------- Section header for list views ---------------- */

export function PlayButtonBig({ isPlaying, onClick, size = 56 }: { isPlaying?: boolean; onClick: () => void; size?: number }) {
  return (
    <button
      onClick={onClick}
      style={{ width: size, height: size }}
      className="rounded-full bg-[#1ed760] text-black flex items-center justify-center shadow-xl hover:scale-105 hover:bg-[#3be477] active:scale-95 transition-transform"
      aria-label={isPlaying ? 'Pause' : 'Play'}
    >
      {isPlaying ? <Pause size={size * 0.36} fill="currentColor" /> : <Play size={size * 0.36} fill="currentColor" className="translate-x-[6%]" />}
    </button>
  )
}
