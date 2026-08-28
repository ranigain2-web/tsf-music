'use client'

/**
 * TSF Music — Synced Lyrics (Phase 3)
 *
 * Fetches lyrics (synced LRC preferred, plain text fallback) from
 * /api/ytm/lyrics. Auto-scrolls to keep the current line near the center,
 * with karaoke-style highlight. Manual scroll is respected for a few seconds
 * before auto-scroll resumes.
 */

import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic2 } from 'lucide-react'
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
      <div className="w-full lg:w-[420px] xl:w-[480px] aspect-square lg:h-[420px] xl:h-[480px] rounded-lg bg-black/60 flex items-center justify-center text-white/60">
        <Loader2 size={32} className="animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="w-full lg:w-[420px] xl:w-[480px] aspect-square lg:h-[420px] xl:h-[480px] rounded-lg bg-black/60 flex flex-col items-center justify-center text-white/60 gap-2 p-6 text-center">
        <Mic2 size={32} />
        <div className="text-sm">{error}</div>
        <div className="text-xs text-white/40">Try another track or enjoy the music.</div>
      </div>
    )
  }

  const lines = lyrics?.lines || []
  return (
    <div
      ref={scrollRef}
      onScroll={onManualScroll}
      className="w-full lg:w-[420px] xl:w-[480px] h-[420px] xl:h-[480px] rounded-lg bg-gradient-to-b from-white/5 to-black/40 overflow-y-auto py-[40%] px-6 text-center hide-scrollbar"
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
  )
}
