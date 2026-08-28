'use client'

/**
 * TSF Music — global keyboard shortcuts (desktop).
 *
 * Implements exactly what ShortcutsOverlay documents (plus M = mute):
 *   Space/K  play–pause        Shift+→/N  next track
 *   Shift+←/P previous          →/L  seek +5s     ←/J  seek −5s
 *   ↑/↓      volume ±5%        M    mute toggle
 *
 * Skips events while typing in inputs/textareas/content-editables and never
 * fires for keys with modifiers other than Shift (no browser-shortcut theft).
 */

import { useEffect } from 'react'
import { usePlayer } from '@/store/player'
import { seekTo } from '@/store/audio'

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

export function KeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const s = usePlayer.getState()
      switch (e.key) {
        case ' ':
          e.preventDefault()
          s.setIsPlaying(!s.isPlaying)
          break
        case 'k':
        case 'K':
          e.preventDefault()
          s.setIsPlaying(!s.isPlaying)
          break
        case 'ArrowRight':
          if (e.shiftKey) {
            e.preventDefault()
            s.next()
          } else {
            e.preventDefault()
            seekTo(s.position + 5)
          }
          break
        case 'ArrowLeft':
          if (e.shiftKey) {
            e.preventDefault()
            s.prev()
          } else {
            e.preventDefault()
            seekTo(Math.max(0, s.position - 5))
          }
          break
        case 'l':
          e.preventDefault()
          seekTo(s.position + 5)
          break
        case 'j':
          e.preventDefault()
          seekTo(Math.max(0, s.position - 5))
          break
        case 'n':
          e.preventDefault()
          s.next()
          break
        case 'p':
          e.preventDefault()
          s.prev()
          break
        case 'ArrowUp':
          e.preventDefault()
          if (s.muted) s.toggleMute()
          s.setVolume(Math.min(1, Math.round((s.volume + 0.05) * 100) / 100))
          break
        case 'ArrowDown':
          e.preventDefault()
          s.setVolume(Math.max(0, Math.round((s.volume - 0.05) * 100) / 100))
          break
        case 'm':
        case 'M':
          e.preventDefault()
          s.toggleMute()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return null
}
