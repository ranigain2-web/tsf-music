'use client'

/**
 * TSF Music — dominant-color hook (Spotify signature)
 *
 * Wraps lib/color.ts dominantColor() extraction in a React-friendly hook so
 * headers can wear the artwork's dominant hue (playlist/album hero gradient,
 * lyrics background). Returns null until extraction resolves (CORS-tainted or
 * local URLs keep the caller's fallback).
 */

import { useEffect, useState } from 'react'
import { dominantColor } from '@/lib/color'

export function useDominantColor(src?: string | null): string | null {
  const [color, setColor] = useState<string | null>(null)

  useEffect(() => {
    if (!src) {
      setColor(null)
      return
    }
    let cancelled = false
    // synchronous cache hit keeps the header from flashing the fallback
    setColor(null)
    void dominantColor(src).then((c) => {
      if (!cancelled) setColor(c)
    })
    return () => {
      cancelled = true
    }
  }, [src])

  return color
}

/** rgba('rgb(r, g, b)', a) → 'rgba(r, g, b, a)' (passthrough on junk). */
export function withAlpha(rgb: string | null, alpha: number): string | null {
  const m = rgb?.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
  if (!m) return null
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`
}
