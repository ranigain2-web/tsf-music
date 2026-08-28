'use client'

/**
 * TSF Music — Full-screen Now Playing view (Phase 3)
 *
 * Spotify-style immersive player: blurred album-art backdrop, big art,
 * title/artist, full controls, seek, like, queue button, lyrics button,
 * sleep timer, crossfade toggle.
 *
 * Slides up from the bottom when the user taps the maximize icon in
 * NowPlayingBar. Press Esc / X / swipe down to dismiss.
 */

import { useEffect, useRef, useState } from 'react'
import { motion, useDragControls } from 'framer-motion'
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  Heart,
  ListMusic,
  Mic2,
  ChevronDown,
  MoreHorizontal,
  Loader2,
  Clock,
  PictureInPicture2,
  Volume2,
  Volume1,
  VolumeX,
  Sparkles,
  Download,
  User,
  Disc3,
  Radio,
  Link2,
  Check,
} from 'lucide-react'
import { usePlayer, fmtTime, type PlayerTrack } from '@/store/player'
import { seekTo } from '@/store/audio'
import { useLibrary } from '@/store/library'
import { api, useNav } from '@/store/nav'
import { Slider } from '@/components/ui/slider'
import { dominantColor } from '@/lib/color'
import { SyncedLyrics } from './SyncedLyrics'
import { QueuePanel } from './QueuePanel'
import { useWakeLock } from '@/hooks/useWakeLock'
import SourceBadge from './SourceBadge'

export function FullScreenNowPlaying() {
  const open = usePlayer((s) => s.nowPlayingOpen)
  const queue = usePlayer((s) => s.queue)
  const queueIndex = usePlayer((s) => s.queueIndex)
  const track: PlayerTrack | null = queue[queueIndex] ?? null
  // Swipe-down dismiss controls (armed from the top bar only)
  const dragControls = useDragControls()

  const isPlaying = usePlayer((s) => s.isPlaying)
  const isLoading = usePlayer((s) => s.isLoading)
  const position = usePlayer((s) => s.position)
  const duration = usePlayer((s) => s.duration)
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const contextTitle = usePlayer((s) => s.contextTitle)
  const lyricsOpen = usePlayer((s) => s.lyricsOpen)
  const queueOpen = usePlayer((s) => s.queueOpen)
  const sleepTimerMs = usePlayer((s) => s.sleepTimerMs)
  const close = usePlayer((s) => s.closeNowPlaying)
  const toggle = usePlayer((s) => s.toggle)
  const next = usePlayer((s) => s.next)
  const prev = usePlayer((s) => s.prev)
  const toggleShuffle = usePlayer((s) => s.toggleShuffle)
  const cycleRepeat = usePlayer((s) => s.cycleRepeat)
  const toggleQueue = usePlayer((s) => s.toggleQueue)
  const toggleLyrics = usePlayer((s) => s.toggleLyrics)
  const toggleMute = usePlayer((s) => s.toggleMute)
  const setVolume = usePlayer((s) => s.setVolume)
  const smartShuffle = usePlayer((s) => s.smartShuffle)
  const smartShuffleLoading = usePlayer((s) => s.smartShuffleLoading)
  const toggleSmartShuffle = usePlayer((s) => s.toggleSmartShuffle)
  const applySmartShuffle = usePlayer((s) => s.applySmartShuffle)

  // Keep the screen on while lyrics are up and music is playing —
  // same behavior as Spotify's lyrics screen.
  useWakeLock(lyricsOpen && isPlaying)

  const likes = useLibrary((s) => s.likes)
  const toggleLike = useLibrary((s) => s.toggleLike)
  const push = useNav((s) => s.push)

  const [scrubbing, setScrubbing] = useState(false)
  const [scrubPos, setScrubPos] = useState(0)
  const [sleepMenuOpen, setSleepMenuOpen] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const [radioLoading, setRadioLoading] = useState(false)
  const [domColor, setDomColor] = useState<string | null>(null)
  const streamArt = usePlayer((s) => s.streamArt)

  const bgImage = streamArt || track?.thumbnail?.replace('w120-h120', 'w600-h600').replace(/=w\d+-h\d+/, '=w600-h600') || '/icon.svg'
  const bigArt = streamArt || track?.thumbnail?.replace('w120-h120', 'w720-h720').replace(/=w\d+-h\d+/, '=w720-h720') || '/icon.svg'

  // Spotify signature (BAR-B §2.6): the lyrics screen wears the dominant
  // color of the album art. Extract client-side, cache per track.
  useEffect(() => {
    if (!open || !track) return
    let cancelled = false
    setDomColor(null)
    dominantColor(bigArt).then((c) => {
      if (!cancelled) setDomColor(c)
    })
    return () => {
      cancelled = true
    }
  }, [open, track?.videoId, bigArt])

  // Esc to close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !lyricsOpen && !queueOpen) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close, lyricsOpen, queueOpen])

  // Sleep timer tick
  useEffect(() => {
    if (!open) return
    if (sleepTimerMs == null) return
    const iv = setInterval(() => {
      usePlayer.getState().tickSleepTimer(500)
    }, 500)
    return () => clearInterval(iv)
  }, [open, sleepTimerMs])

  if (!open || !track) return null

  const liked = likes.has(track.videoId)
  // Effective duration = audio element duration, fall back to metadata.
  // Both bars (full-screen + non-fullscreen) now use this same logic so they
  // never disagree about the duration display.
  const effectiveDuration = duration > 0 ? duration : (track?.duration || 0)
  const displayPos = scrubbing ? scrubPos : position
  const pct = effectiveDuration > 0 ? (displayPos / effectiveDuration) * 100 : 0

  return (
    <motion.div
      className="fixed inset-0 z-50 bg-black text-white flex flex-col now-playing-enter tsf-grain overflow-hidden"
      role="dialog"
      aria-label="Now playing"
      /* Swipe-down-to-dismiss (Spotify mobile): drag is armed ONLY from the
         top bar via dragControls, so sliders/buttons inside stay usable. */
      drag="y"
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.55 }}
      onDragEnd={(_, info) => {
        if (info.offset.y > 110 || info.velocity.y > 700) close()
      }}
    >
      {/* ambient backdrop — drifting, saturated artwork glow */}
      <div
        className="tsf-ambient bg-cover bg-center"
        style={{
          backgroundImage: `url(${bgImage})`,
          filter: 'blur(72px) brightness(0.7) saturate(1.8)',
        }}
        aria-hidden
      />
      {/* second ambient layer, offset phase for depth */}
      <div
        className="tsf-ambient bg-cover bg-center"
        style={{
          backgroundImage: `url(${bgImage})`,
          filter: 'blur(96px) brightness(0.5) saturate(1.4)',
          animationDelay: '-13s',
          opacity: 0.7,
        }}
        aria-hidden
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/25 via-black/35 to-black/70" aria-hidden />
      {/* Spotify-dominant-color layer: fades in over the ambient wash when
          lyrics are open (BAR-B §2.6 lyrics background) */}
      <div
        className={`absolute inset-0 transition-opacity duration-700 ${lyricsOpen && domColor ? 'opacity-100' : 'opacity-0'}`}
        style={{ background: `linear-gradient(180deg, ${domColor || 'transparent'} 0%, #121212 115%)` }}
        aria-hidden
      />

      {/* top bar — safe-area aware (notch/Dynamic Island); drag handle zone */}
      <div
        className="relative flex items-center justify-between px-6 pt-6 pb-2 max-lg:pt-[calc(env(safe-area-inset-top)+0.75rem)]"
        onPointerDown={(e) => dragControls.start(e)}
        style={{ touchAction: 'none' }}
      >
        {/* grabber — visual affordance for the swipe (mobile) */}
        <div className="lg:hidden absolute left-1/2 -translate-x-1/2 -top-1 w-9 h-1 rounded-full bg-white/40" aria-hidden />
        <button
          onClick={close}
          className="text-white/80 hover:text-white transition-colors p-1 -ml-1"
          aria-label="Close now playing"
          title="Close"
        >
          {/* Spotify uses a chevron-down to collapse the full-screen player */}
          <ChevronDown size={30} />
        </button>
        <div className="text-center">
          <div className="text-[11px] uppercase tracking-[0.16em] text-white/70 font-semibold">
            Playing from {contextTitle || 'your library'}
          </div>
          {sleepTimerMs != null && (
            <div className="text-[11px] text-[#1ed760] mt-0.5 tabular-nums flex items-center gap-1 justify-center">
              <Clock size={11} /> Sleep in {Math.ceil(sleepTimerMs / 60000)}m
            </div>
          )}
        </div>
        <button
          onClick={() => setSleepMenuOpen((s) => !s)}
          className="text-white/80 hover:text-white transition-colors relative p-1 -mr-1"
          aria-label="More options"
          title="More"
        >
          <MoreHorizontal size={28} />
          {sleepMenuOpen && (
            <div className="absolute right-0 top-full mt-2 w-60 rounded-md bg-[#282828] border border-white/10 shadow-xl p-2 z-10">
              {track.artistId && (
                <button
                  onClick={() => {
                    push({ type: 'artist', id: track.artistId!, title: track.artistName })
                    setSleepMenuOpen(false)
                  }}
                  className="flex w-full items-center gap-2.5 text-left px-3 py-1.5 text-sm text-white/90 hover:bg-white/10 rounded"
                >
                  <User size={14} /> Go to artist
                </button>
              )}
              {track.albumId && (
                <button
                  onClick={() => {
                    push({ type: 'album', id: track.albumId!, title: track.albumName })
                    setSleepMenuOpen(false)
                  }}
                  className="flex w-full items-center gap-2.5 text-left px-3 py-1.5 text-sm text-white/90 hover:bg-white/10 rounded"
                >
                  <Disc3 size={14} /> Go to album
                </button>
              )}
              <button
                disabled={radioLoading}
                onClick={async () => {
                  if (radioLoading) return
                  setRadioLoading(true)
                  try {
                    const r = await fetch(`/api/ytm/radio?id=${encodeURIComponent(track.videoId)}`)
                    if (r.ok) {
                      const j = (await r.json()) as { tracks?: PlayerTrack[] }
                      const tracks = (j.tracks || []).filter((t) => t?.videoId)
                      if (tracks[0]?.videoId !== track.videoId) tracks.unshift(track)
                      if (tracks.length > 0) {
                        usePlayer.getState().playQueue(tracks, 0, `${track.title} · Radio`)
                        setSleepMenuOpen(false)
                      }
                    }
                  } catch { /* keep menu open on failure */ } finally {
                    setRadioLoading(false)
                  }
                }}
                className="flex w-full items-center gap-2.5 text-left px-3 py-1.5 text-sm text-white/90 hover:bg-white/10 rounded disabled:opacity-60"
              >
                {radioLoading ? <Loader2 size={14} className="animate-spin" /> : <Radio size={14} />}
                Start track radio
              </button>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(`https://music.youtube.com/watch?v=${track.videoId}`)
                    setLinkCopied(true)
                    setTimeout(() => setLinkCopied(false), 1800)
                  } catch { /* clipboard unavailable */ }
                }}
                className="flex w-full items-center gap-2.5 text-left px-3 py-1.5 text-sm text-white/90 hover:bg-white/10 rounded"
              >
                {linkCopied ? <Check size={14} className="text-[#1ed760]" /> : <Link2 size={14} />}
                {linkCopied ? 'Link copied' : 'Copy song link'}
              </button>
              <div className="border-t border-white/10 my-1.5" />
              <div className="text-[11px] uppercase tracking-wider text-white/40 px-3 py-1.5">Sleep timer</div>
              {[5, 10, 15, 30, 60].map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    usePlayer.getState().startSleepTimer(m)
                    setSleepMenuOpen(false)
                  }}
                  className="block w-full text-left px-3 py-1.5 text-sm text-white/90 hover:bg-white/10 rounded"
                >
                  End in {m} minutes
                </button>
              ))}
              {sleepTimerMs != null && (
                <button
                  onClick={() => {
                    usePlayer.getState().cancelSleepTimer()
                    setSleepMenuOpen(false)
                  }}
                  className="block w-full text-left px-3 py-1.5 text-sm text-[#1ed760] hover:bg-white/10 rounded mt-1 border-t border-white/10 pt-2"
                >
                  Cancel timer
                </button>
              )}
            </div>
          )}
        </button>
      </div>

      {/* main body */}
      <div className="relative flex-1 min-h-0 flex flex-col lg:flex-row lg:items-center lg:justify-center gap-6 px-6 lg:px-12 pb-12 max-lg:pb-[max(3rem,env(safe-area-inset-bottom))] pt-2">
        {/* album art (or lyrics overlay when lyrics open) — shrinks when the
            queue panel is open so the queue gets usable height on mobile */}
        <div className={`flex items-center justify-center min-h-0 lg:flex-none ${queueOpen ? 'max-lg:flex-none max-lg:h-[160px]' : 'flex-1'}`}>
          {lyricsOpen ? (
            <SyncedLyrics track={track} />
          ) : queueOpen ? (
            <motion.div
              key={track.videoId + '-q'}
              initial={{ opacity: 0, scale: 0.92, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.45, ease: [0.2, 0, 0, 1] }}
              className="h-full w-full flex items-center justify-center"
            >
              { }
              <img
                src={bigArt}
                alt={track.title}
                className="h-full aspect-square object-cover rounded-md shadow-[0_24px_80px_rgba(0,0,0,0.85)]"
                referrerPolicy="no-referrer"
              />
            </motion.div>
          ) : (
            <motion.div
              key={track.videoId}
              initial={{ opacity: 0, scale: 0.92, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.45, ease: [0.2, 0, 0, 1] }}
              className="w-full h-full flex items-center justify-center"
            >
              { }
              <img
                src={bigArt}
                alt={track.title}
                className={`max-w-full max-h-full lg:w-[520px] lg:h-[520px] xl:w-[600px] xl:h-[600px] aspect-square object-cover rounded-md shadow-[0_24px_80px_rgba(0,0,0,0.85)] ${isPlaying ? 'tsf-breathe' : ''}`}
                referrerPolicy="no-referrer"
              />
            </motion.div>
          )}
        </div>

        {/* right column: title + controls */}
        <div className={`lg:flex-none lg:w-[480px] xl:w-[560px] flex flex-col gap-5 min-h-0 ${queueOpen ? 'max-lg:flex-[2.2]' : 'flex-1'}`}>
          {/* title row */}
          <div className="flex items-end gap-4">
            <div className="min-w-0 flex-1">
              <motion.div
                key={`t-${track.videoId}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: [0.2, 0, 0, 1] }}
                className="text-3xl xl:text-4xl 2xl:text-5xl font-black text-white truncate hover:underline cursor-pointer tracking-tight leading-tight"
              >
                {track.title}
              </motion.div>
              <div className="flex items-center gap-2 mt-1.5">
                <div className="text-lg xl:text-xl text-white/85 truncate hover:underline cursor-pointer font-semibold">
                  {track.artistName}
                </div>
                <SourceBadge />
              </div>
            </div>
            <button
              onClick={() => void toggleLike(track)}
              className={`shrink-0 transition-transform hover:scale-110 ${liked ? 'text-[#1ed760]' : 'text-white/70 hover:text-white'}`}
              aria-label={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
            >
              <Heart size={32} fill={liked ? 'currentColor' : 'none'} />
            </button>
          </div>

          {/* seek bar */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-white/60 tabular-nums w-10 text-right">
              {fmtTime(displayPos)}
            </span>
            <Slider
              value={[pct]}
              min={0}
              max={100}
              step={0.1}
              onValueChange={(v) => {
                if (effectiveDuration > 0) {
                  setScrubbing(true)
                  setScrubPos((v[0] / 100) * effectiveDuration)
                }
              }}
              onValueCommit={(v) => {
                if (effectiveDuration > 0) seekTo((v[0] / 100) * effectiveDuration)
                setScrubbing(false)
              }}
              className="flex-1 h-1.5 group/seek [&_[data-slot=slider-track]]:bg-white/30 [&_[data-slot=slider-range]]:bg-white group-hover/seek:[&_[data-slot=slider-range]]:bg-[#1ed760] [&_[data-slot=slider-thumb]]:opacity-0 group-hover/seek:[&_[data-slot=slider-thumb]]:opacity-100 [&_[data-slot=slider-thumb]]:w-3.5 [&_[data-slot=slider-thumb]]:h-3.5 [&_[data-slot=slider-thumb]]:bg-white [&_[data-slot=slider-thumb]]:shadow-md"
              aria-label="Seek"
            />
            <span className="text-xs text-white/60 tabular-nums w-10">{fmtTime(effectiveDuration)}</span>
          </div>

          {/* transport */}
          <div className="flex items-center justify-between">
            <button
              onClick={toggleShuffle}
              className={`transition-colors ${shuffle ? 'text-[#1ed760]' : 'text-white/60 hover:text-white'}`}
              aria-label="Toggle shuffle"
              title="Shuffle"
            >
              <Shuffle size={22} fill={shuffle ? 'currentColor' : 'none'} />
            </button>
            <button
              onClick={prev}
              className="text-white/80 hover:text-white transition-transform max-lg:scale-110 active:scale-95"
              aria-label="Previous track"
              title="Previous"
            >
              <SkipBack size={32} fill="currentColor" />
            </button>
            <button
              onClick={toggle}
              className="w-16 h-16 max-lg:w-[60px] max-lg:h-[60px] rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105 active:scale-95 transition-transform shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isLoading ? (
                <Loader2 size={32} className="animate-spin" />
              ) : isPlaying ? (
                <Pause size={32} fill="currentColor" />
              ) : (
                <Play size={32} fill="currentColor" className="translate-x-[1px]" />
              )}
            </button>
            <button
              onClick={next}
              className="text-white/80 hover:text-white transition-transform max-lg:scale-110 active:scale-95"
              aria-label="Next track"
              title="Next"
            >
              <SkipForward size={32} fill="currentColor" />
            </button>
            <button
              onClick={cycleRepeat}
              className={`transition-colors ${repeat !== 'off' ? 'text-[#1ed760]' : 'text-white/60 hover:text-white'}`}
              aria-label="Cycle repeat mode"
              title={`Repeat: ${repeat}`}
            >
              {repeat === 'one' ? <Repeat1 size={22} fill="currentColor" /> : <Repeat size={22} fill={repeat === 'all' ? 'currentColor' : 'none'} />}
            </button>
          </div>

          {/* bottom row: lyrics / queue / save / smart — wraps on phones,
              volume controls are desktop-only (phones use hardware volume) */}
          <div className="flex flex-wrap items-center justify-start lg:justify-between gap-2 pt-2">
            <button
              onClick={toggleLyrics}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors border ${
                lyricsOpen
                  ? 'bg-[#1ed760] text-black border-transparent max-lg:px-2.5 max-lg:py-1.5 lg:border-[#1ed760]'
                  : 'border-transparent max-lg:bg-white/10 max-lg:px-2.5 max-lg:py-1.5 lg:border-white/30 text-white/80 hover:border-white'
              }`}
              aria-label="Lyrics"
              title="Lyrics"
            >
              <Mic2 size={14} /> Lyrics
            </button>
            <button
              onClick={toggleQueue}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors border ${
                queueOpen
                  ? 'bg-[#1ed760] text-black border-transparent max-lg:px-2.5 max-lg:py-1.5 lg:border-[#1ed760]'
                  : 'border-transparent max-lg:bg-white/10 max-lg:px-2.5 max-lg:py-1.5 lg:border-white/30 text-white/80 hover:border-white'
              }`}
              aria-label="Queue"
              title="Queue"
            >
              <ListMusic size={14} /> Queue
            </button>
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
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors border border-white/30 text-white/80 hover:border-white"
              aria-label="Download"
              title="Download this track"
            >
              <Download size={14} /> Save
            </button>
            <button
              onClick={async () => {
                toggleSmartShuffle()
                // If turning ON, fetch smart-shuffled queue immediately
                if (!smartShuffle && queue.length >= 2) {
                  usePlayer.setState({ smartShuffleLoading: true })
                  try {
                    const r = await api<{ tracks: PlayerTrack[]; insertedAt: number[] }>(
                      '/api/ai/smart-shuffle',
                      {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ tracks: queue, count: 10 }),
                      }
                    )
                    if (r.tracks?.length) {
                      applySmartShuffle(r.tracks, r.insertedAt || [])
                    }
                  } catch { /* skip */ }
                  finally {
                    usePlayer.setState({ smartShuffleLoading: false })
                  }
                }
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors border ${
                smartShuffle
                  ? 'bg-[#1ed760] text-black border-transparent max-lg:px-2.5 max-lg:py-1.5 lg:border-[#1ed760]'
                  : 'border-transparent max-lg:bg-white/10 max-lg:px-2.5 max-lg:py-1.5 lg:border-white/30 text-white/80 hover:border-white'
              }`}
              aria-label="Smart shuffle"
              title="Smart Shuffle — sprinkle AI recommendations into your queue"
            >
              {smartShuffleLoading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Sparkles size={14} />
              )}
              Smart
            </button>
            <button
              onClick={toggleMute}
              className="hidden lg:flex text-white/70 hover:text-white transition-colors p-1"
              aria-label="Mute"
              title={muted ? 'Unmute' : 'Mute'}
            >
              {muted || volume === 0 ? <VolumeX size={18} /> : volume < 0.5 ? <Volume1 size={18} /> : <Volume2 size={18} />}
            </button>
            <Slider
              value={[muted ? 0 : volume * 100]}
              min={0}
              max={100}
              step={1}
              onValueChange={(v) => setVolume(v[0] / 100)}
              className="hidden lg:flex w-28 h-1 [&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-thumb]]:opacity-0 hover:[&_[data-slot=slider-thumb]]:opacity-100 hover:[&_[data-slot=slider-range]]:bg-[#1ed760]"
              aria-label="Volume"
            />
            <button
              className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border border-white/30 text-white/80 hover:border-white transition-colors"
              aria-label="Picture in picture"
              title="Picture in picture"
            >
              <PictureInPicture2 size={14} /> PiP
            </button>
          </div>

          {/* queue / lyrics panel underneath (when toggled) */}
          {queueOpen && (
            <div className="mt-1 flex-1 min-h-0">
              <QueuePanel />
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}
