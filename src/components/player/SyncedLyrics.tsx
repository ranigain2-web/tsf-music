'use client'

/**
 * TSF Music — Synced Lyrics (Phase 3)
 *
 * Fetches lyrics (synced LRC preferred, plain text fallback) from
 * /api/ytm/lyrics. Auto-scrolls to keep the current line near the center,
 * with karaoke-style highlight. Manual scroll is respected for a few seconds
 * before auto-scroll resumes.
 *
 * §2.8 SHARE: floating share button (bottom-right) copies/shares the current
 * lyric line with attribution — Spotify-parity "share this lyric" moment.
 */

import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic2, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { usePlayer, type PlayerTrack } from '@/store/player'
import { api } from '@/store/nav'

interface LyricLine {
  time: number // seconds (0 = unsynced)
  text: string
}

interface LyricsResp {
  synced: boolean
  lines: LyricLine[]
  offline?: boolean
}

export function SyncedLyrics({ track }: { track: PlayerTrack }) {
  const position = usePlayer((s) => s.position)
  const [lyrics, setLyrics] = useState<LyricsResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [userScrolled, setUserScrolled] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lineRefs = useRef<(HTMLDivElement | null)[]>([])

  // Fetch on track change
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setLyrics(null)
    setUserScrolled(false)
    void (async () => {
      try {
        const res = await api<LyricsResp>(
          `/api/ytm/lyrics?id=${encodeURIComponent(track.videoId)}&title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artistName)}&album=${encodeURIComponent(track.albumName || '')}&duration=${track.duration}`
        )
        if (cancelled) return
        if (!res.lines || res.lines.length === 0) {
          setError('No lyrics found')
        } else {
          setLyrics(res)
        }
      } catch (e) {
        if (!cancelled) setError('Could not load lyrics')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [track.videoId, track.title, track.artistName, track.albumName, track.duration])

  // Compute current line index from position
  const currentIdx = (() => {
    if (!lyrics?.synced || !lyrics.lines.length) return -1
    let idx = 0
    for (let i = 0; i < lyrics.lines.length; i++) {
      if (lyrics.lines[i].time <= position) idx = i
      else break
    }
    return idx
  })()

  // Auto-scroll the current line to center
  useEffect(() => {
    if (userScrolled) return
    if (currentIdx < 0) return
    const el = lineRefs.current[currentIdx]
    const container = scrollRef.current
    if (!el || !container) return
    const target = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2
    container.scrollTo({ top: target, behavior: 'smooth' })
  }, [currentIdx, userScrolled])

  // Detect user scroll and pause auto-scroll for 4s
  const onManualScroll = () => {
    const container = scrollRef.current
    if (!container) return
    // We can only detect manual scroll if it differs from where we'd auto-scroll.
    // Simple heuristic: assume any scroll event during the first 4s after a user
    // interaction is manual. We just set a flag.
    setUserScrolled(true)
    if (userScrollTimer.current) clearTimeout(userScrollTimer.current)
    userScrollTimer.current = setTimeout(() => setUserScrolled(false), 4000)
  }

  if (loading) {
    return (
      <div className="w-full lg:w-[420px] xl:w-[480px] aspect-square lg:h-[420px] xl:h-[480px] rounded-lg bg-black/30 backdrop-blur-sm flex items-center justify-center text-white/60">
        <Loader2 size={32} className="animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="w-full lg:w-[420px] xl:w-[480px] aspect-square lg:h-[420px] xl:h-[480px] rounded-lg bg-black/30 backdrop-blur-sm flex flex-col items-center justify-center text-white/60 gap-2 p-6 text-center">
        <Mic2 size={32} />
        <div className="text-sm">{error}</div>
        <div className="text-xs text-white/40">Try another track or enjoy the music.</div>
      </div>
    )
  }

  const lines = lyrics?.lines || []

  // §2.8 lyric share: current line + attribution. Web Share API (native sheet
  // on mobile/desktop shells) → clipboard fallback, mirroring TrackContextMenu.
  const currentLine = currentIdx >= 0 ? (lines[currentIdx]?.text || '').trim() : ''
  const shareLyric = async (): Promise<void> => {
    if (!currentLine) return
    const text = `"${currentLine}"\n— ${track.title} · ${track.artistName}`
    const shareData: ShareData = { text, title: `${track.title} — TSF Music` }
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share(shareData)
        return
      }
      throw new Error('no-share')
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return // user closed sheet
      try {
        await navigator.clipboard.writeText(text)
        toast.success('Lyric copied to clipboard')
      } catch {
        toast.error('Could not share this lyric')
      }
    }
  }

  return (
    <div className="relative w-full lg:w-[420px] xl:w-[480px]">
      <div
        ref={scrollRef}
        onScroll={onManualScroll}
        className="w-full h-[420px] xl:h-[480px] rounded-lg bg-gradient-to-b from-black/15 to-black/35 backdrop-blur-[2px] overflow-y-auto py-[40%] px-6 text-center hide-scrollbar"
      >
        {lines.map((line, i) => {
          const isCurrent = i === currentIdx
          const distance = Math.abs(i - currentIdx)
          const opacity = isCurrent ? 1 : Math.max(0.25, 1 - distance * 0.18)
          const scale = isCurrent ? '1.05' : '1'
          return (
            <div
              key={i}
              ref={(el) => {
                lineRefs.current[i] = el
              }}
              className="transition-all duration-500 ease-out py-1.5"
              style={{
                opacity,
                transform: `scale(${scale})`,
                color: isCurrent ? '#fff' : 'rgba(255,255,255,0.7)',
                fontWeight: isCurrent ? 700 : 500,
                textShadow: isCurrent ? '0 0 30px rgba(30,215,96,0.35)' : 'none',
              }}
            >
              {line.text || '♪'}
            </div>
          )
        })}
      </div>
      {currentLine !== '' && (
        <button
          type="button"
          onClick={() => {
            void shareLyric()
          }}
          aria-label={`Share lyric: ${currentLine.slice(0, 40)}`}
          title="Share this lyric"
          className="absolute bottom-4 right-4 z-10 h-9 min-w-[44px] px-3 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-white/90 hover:text-white hover:bg-black/80 hover:scale-[1.04] active:scale-95 transition-all inline-flex items-center justify-center gap-1.5 opacity-100 lg:opacity-60 lg:hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1ed760]/70"
        >
          <Share2 size={15} aria-hidden />
          <span className="text-[11px] font-semibold tracking-wide hidden sm:inline">SHARE</span>
        </button>
      )}
    </div>
  )
}
