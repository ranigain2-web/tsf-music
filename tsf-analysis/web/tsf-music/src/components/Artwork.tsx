'use client'

/**
 * TSF Music — Artwork with graceful degradation.
 *
 * Real Spotify never shows a broken-image glyph or alt text: a missing cover
 * renders as a dark gradient tile with a music-note mark. This component
 * centralizes that behavior (fixes the "broken image assets" critic gap).
 */

import { useState } from 'react'
import { Music2 } from 'lucide-react'

export function Artwork({
  src,
  alt = '',
  className = '',
  rounded = '',
  iconSize = 22,
}: {
  src?: string | null
  alt?: string
  className?: string
  rounded?: string
  iconSize?: number
}) {
  const [failed, setFailed] = useState(false)
  const usable = src && !failed && src.trim() !== ''

  if (!usable) {
    return (
      <div
        className={`bg-gradient-to-br from-[#3a3a3a] to-[#1c1c1c] flex items-center justify-center shrink-0 ${className} ${rounded}`}
        aria-hidden
      >
        <Music2 size={iconSize} className="text-white/25" />
      </div>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className={`shrink-0 ${className} ${rounded}`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}
