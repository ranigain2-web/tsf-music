'use client'

/**
 * TSF Music — Now Playing bar
 * Spotify's exact three-zone layout:
 *   [ track info ]  [ transport controls + seek ]  [ volume / queue ]
 * Hidden entirely when no track has ever been queued (like Spotify).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ChevronUp,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  Volume2,
  Volume1,
  VolumeX,
  ListMusic,
  Maximize2,
  Heart,
  Loader2,
  Mic2,
  Download,
} from 'lucide-react'
import { usePlayer, fmtTime } from '@/store/player'
import { seekTo } from '@/store/audio'
import { useLibrary } from '@/store/library'
import { Slider } from '@/components/ui/slider'
import SourceBadge from './SourceBadge'

export function NowPlayingBar() {
  const queue = usePlayer((s) => s.queue)
  const queueIndex = usePlayer((s) => s.queueIndex)
  const track = queue[queueIndex] ?? null
  const streamArt = usePlayer((s) => s.streamArt)

  const isPlaying = usePlayer((s) => s.isPlaying)
  const isLoading = usePlayer((s) => s.isLoading)
  const position = usePlayer((s) => s.position)
  const duration = usePlayer((s) => s.duration)
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const toggle = usePlayer((s) => s.toggle)
  const next = usePlayer((s) => s.next)
  const prev = usePlayer((s) => s.prev)
  const toggleShuffle = usePlayer((s) => s.toggleShuffle)
  const cycleRepeat = usePlayer((s) => s.cycleRepeat)
  const setVolume = usePlayer((s) => s.setVolume)
  const toggleMute = usePlayer((s) => s.toggleMute)

  const likes = useLibrary((s) => s.likes)
  const toggleLike = useLibrary((s) => s.toggleLike)
  const openNowPlaying = usePlayer((s) => s.openNowPlaying)
  const toggleQueue = usePlayer((s) => s.toggleQueue)
  const toggleLyrics = usePlayer((s) => s.toggleLyrics)
  const queueOpen = usePlayer((s) => s.queueOpen)
  const lyricsOpen = usePlayer((s) => s.lyricsOpen)

  const [scrubbing, setScrubbing] = useState(false)
  const [scrubPos, setScrubPos] = useState(0)
  const barRef = useRef<HTMLDivElement>(null)

  // Effective duration — falls back to track.metadata if audio element hasn't
  // fired durationchange yet (e.g., during the initial loading window).
  // This is the key fix: previously the non-fullscreen bar showed "0:00"
  // until the audio element's durationchange fired, which made it look
  // broken. Now we show the metadata duration immediately and refine when
  // the actual audio duration is known.
  const effectiveDuration = duration > 0 ? duration : (track?.duration || 0)

  const onSeek = useCallback((val: number[]) => {
    if (effectiveDuration > 0) {
      setScrubbing(true)
      setScrubPos((val[0] / 100) * effectiveDuration)
    }
  }, [effectiveDuration])

  const onSeekCommit = useCallback((val: number[]) => {
    if (effectiveDuration > 0) {
      seekTo((val[0] / 100) * effectiveDuration)
    }
    setScrubbing(false)
  }, [effectiveDuration])

  // keyboard shortcuts: space play/pause, arrows seek/volume
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'CONTENTEDITABLE') return
      if (e.code === 'Space') {
        e.preventDefault()
        toggle()
      } else if (e.code === 'ArrowRight' && e.shiftKey) next()
      else if (e.code === 'ArrowLeft' && e.shiftKey) prev()
      else if (e.code === 'ArrowRight') seekTo(position + 5)
      else if (e.code === 'ArrowLeft') seekTo(Math.max(0, position - 5))
      else if (e.code === 'ArrowUp') setVolume(volume + 0.05)
      else if (e.code === 'ArrowDown') setVolume(volume - 0.05)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle, next, prev, position, volume, setVolume])

  if (!track) return null

  const liked = likes.has(track.videoId)
  const displayPos = scrubbing ? scrubPos : position
  const pct = effectiveDuration > 0 ? (displayPos / effectiveDuration) * 100 : 0
  const art = streamArt || track.thumbnail?.replace(/=w\d+-h\d+/, '=w96-h96') || '/icon.svg'

  return (
    <>
      {/* ================= MOBILE compact bar (Spotify mini-player) =================
       * Thin progress line on the top edge, art + title/artist + heart + play.
       * Tapping the row opens the full-screen Now Playing. Shown below lg;
       * the desktop three-zone bar below takes over at lg+. */}
      <motion.div
        initial={{ y: 80 }}
        animate={{ y: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 34 }}
        className="lg:hidden shrink-0 bg-black/95 backdrop-blur select-none"
        role="region"
        aria-label="Player"
      >
        {/* progress line — pure CSS, 2px, always visible (Spotify signature) */}
        <div className="h-[2px] w-full bg-white/20" aria-hidden>
          <div className="h-full bg-white transition-[width] duration-200 ease-linear" style={{ width: `${pct}%` }} />
        </div>
        <div
          className="flex items-center gap-3 pl-3 pr-4 py-2.5 active:bg-white/5 transition-colors cursor-pointer"
          onClick={(e) => {
            // taps on real buttons (heart/play) shouldn't open the sheet
            if ((e.target as HTMLElement).closest('button')) return
            openNowPlaying()
          }}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.img
              key={track.videoId}
              src={art}
              alt=""
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.08 }}
              transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
              className="w-11 h-11 object-cover rounded shadow-lg shrink-0"
            />
          </AnimatePresence>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold truncate flex items-center gap-1.5">
              <span className="truncate">{track.title}</span>
              <SourceBadge compact />
            </div>
            <div className="text-[12px] text-[#b3b3b3] truncate">{track.artistName}</div>
          </div>
          <button
            onClick={() => void toggleLike(track)}
            className={`shrink-0 p-2.5 -mr-1 transition-transform active:scale-90 ${liked ? 'text-[#1ed760]' : 'text-[#b3b3b3]'}`}
            aria-label={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
          >
            <Heart size={20} fill={liked ? 'currentColor' : 'none'} />
          </button>
          {/* draggable affordance (Spotify's chevron cue) */}
          <span className="shrink-0 text-white/50 pointer-events-none" aria-hidden>
            <ChevronUp size={18} />
          </span>
          <button
            onClick={toggle}
            className="shrink-0 w-11 h-11 flex items-center justify-center text-white active:scale-90 transition-transform"
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isLoading ? (
              <Loader2 size={26} className="animate-spin" />
            ) : isPlaying ? (
              <Pause size={26} fill="currentColor" />
            ) : (
              <Play size={26} fill="currentColor" className="translate-x-[1px]" />
            )}
          </button>
        </div>
      </motion.div>

      {/* ================= DESKTOP three-zone bar ================= */}
      <motion.div
        ref={barRef}
        initial={{ y: 80 }}
        animate={{ y: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 34 }}
        className="hidden lg:grid shrink-0 h-[72px] bg-black grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center px-4 gap-4 select-none"
        role="region"
        aria-label="Player"
      >
      {/* ---- left: track info ---- */}
      <div className="flex items-center gap-3 min-w-0 overflow-hidden">
        <button
          onClick={openNowPlaying}
          className="shrink-0 cursor-pointer rounded shadow-lg hover:scale-105 transition-transform"
          aria-label="Open now playing view"
          title="Open now playing view"
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.img
              key={track.videoId}
              src={track.thumbnail?.replace(/=w\d+-h\d+/, '=w80-h80') || '/icon.svg'}
              alt=""
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.08 }}
              transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
              className="w-14 h-14 object-cover rounded"
            />
          </AnimatePresence>
        </button>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={openNowPlaying}
              className="text-sm font-medium text-white truncate hover:underline underline-offset-2 cursor-pointer block min-w-0 flex-1 text-left"
              title={track.title}
            >
              {track.title}
            </button>
            <button
              onClick={() => void toggleLike(track)}
              className={`shrink-0 transition-transform hover:scale-110 ${liked ? 'text-[#1ed760]' : 'text-[#b3b3b3] hover:text-white'}`}
              aria-label={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
              title={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
            >
              <Heart size={16} fill={liked ? 'currentColor' : 'none'} />
            </button>
          </div>
          <div className="text-[13px] text-[#b3b3b3] truncate hover:text-white hover:underline underline-offset-2 cursor-pointer transition-colors">
            {track.artistName}
          </div>
        </div>
      </div>

      {/* ---- center: transport ---- */}
      <div className="flex flex-col items-center gap-1 w-full max-w-[456px] min-w-[180px]">
        <div className="flex items-center gap-4 lg:gap-5">
          <button
            onClick={toggleShuffle}
            className={`transition-colors ${shuffle ? 'text-[#1ed760]' : 'text-[#b3b3b3] hover:text-white'}`}
            aria-label="Toggle shuffle"
            title="Shuffle"
          >
            <Shuffle size={16} fill={shuffle ? 'currentColor' : 'none'} />
          </button>
          <button onClick={prev} className="text-[#b3b3b3] hover:text-white transition-colors" aria-label="Previous track" title="Previous">
            <SkipBack size={16} fill="currentColor" />
          </button>
          <button
            onClick={toggle}
            className="w-8 h-8 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 active:scale-95 transition-transform"
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isLoading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : isPlaying ? (
              <Pause size={16} fill="currentColor" />
            ) : (
              <Play size={16} fill="currentColor" className="translate-x-[1px]" />
            )}
          </button>
          <button onClick={next} className="text-[#b3b3b3] hover:text-white transition-colors" aria-label="Next track" title="Next">
            <SkipForward size={16} fill="currentColor" />
          </button>
          <button
            onClick={cycleRepeat}
            className={`transition-colors ${repeat !== 'off' ? 'text-[#1ed760]' : 'text-[#b3b3b3] hover:text-white'}`}
            aria-label="Cycle repeat mode"
            title={`Repeat: ${repeat}`}
          >
            {repeat === 'one' ? <Repeat1 size={16} fill="currentColor" /> : <Repeat size={16} fill={repeat === 'all' ? 'currentColor' : 'none'} />}
          </button>
        </div>

        {/* seek bar */}
        <div className="w-full flex items-center gap-2">
          <span className="text-[11px] text-[#a7a7a7] tabular-nums w-10 text-right">{fmtTime(displayPos)}</span>
          <Slider
            value={[pct]}
            min={0}
            max={100}
            step={0.1}
            onValueChange={onSeek}
            onValueCommit={onSeekCommit}
            className="flex-1 h-1 group/seek [&_[data-slot=slider-range]]:bg-white group-hover/seek:[&_[data-slot=slider-range]]:bg-[#1ed760] [&_[data-slot=slider-thumb]]:opacity-0 group-hover/seek:[&_[data-slot=slider-thumb]]:opacity-100"
            aria-label="Seek"
          />
          <span className="text-[11px] text-[#a7a7a7] tabular-nums w-10">{fmtTime(effectiveDuration)}</span>
        </div>
      </div>

      {/* ---- right: volume / queue ---- */}
      <div className="hidden lg:flex items-center justify-end gap-2">
        <button
          onClick={async () => {
            if (!track) return
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
            } catch {}
          }}
          className="text-[#b3b3b3] hover:text-white transition-colors p-1 hover:scale-110"
          aria-label="Download this track"
          title="Download"
        >
          <Download size={16} />
        </button>
        <button
          onClick={toggleLyrics}
          className={`transition-colors p-1 ${lyricsOpen ? 'text-[#1ed760]' : 'text-[#b3b3b3] hover:text-white'}`}
          aria-label="Lyrics"
          title="Lyrics"
        >
          <Mic2 size={16} />
        </button>
        <button
          onClick={toggleQueue}
          className={`transition-colors p-1 ${queueOpen ? 'text-[#1ed760]' : 'text-[#b3b3b3] hover:text-white'}`}
          aria-label="Queue"
          title="Queue"
        >
          <ListMusic size={16} />
        </button>
        <button
          onClick={openNowPlaying}
          className="text-[#b3b3b3] hover:text-white transition-colors p-1"
          aria-label="Now playing view"
          title="Now playing view"
        >
          <Maximize2 size={16} />
        </button>
        <button onClick={toggleMute} className="text-[#b3b3b3] hover:text-white transition-colors p-1" aria-label="Mute">
          {muted || volume === 0 ? <VolumeX size={16} /> : volume < 0.5 ? <Volume1 size={16} /> : <Volume2 size={16} />}
        </button>
        <Slider
          value={[muted ? 0 : volume * 100]}
          min={0}
          max={100}
          step={1}
          onValueChange={(v) => setVolume(v[0] / 100)}
          className="w-24 h-1 [&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-thumb]]:opacity-0 hover:[&_[data-slot=slider-thumb]]:opacity-100 hover:[&_[data-slot=slider-range]]:bg-[#1ed760]"
          aria-label="Volume"
        />
      </div>
      </motion.div>
    </>
  )
}

