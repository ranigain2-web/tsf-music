'use client'

import { useMemo } from 'react'
import { usePreferences } from '@/store/preferences'
import { StepFooter } from './StepFooter'

/**
 * GenresStep — multi-select genre pills, Spotify-tile-inspired.
 *
 * Each genre is rendered as a rounded-rectangle tile with the genre's signature
 * Spotify-style background color (matched to our bar screenshot palette) and
 * the genre name in white. Tapping toggles selection. Selected tiles get a
 * green ring + a small check badge.
 *
 * This mirrors Spotify's "Choose 3 or more podcasts/genres you like" tile
 * grid pattern used in their signup onboarding.
 */

const TILES: { name: string; color: string }[] = [
  { name: 'Pop',          color: '#8d67ab' },
  { name: 'Hip-Hop',       color: '#ba5d07' },
  { name: 'Rap',           color: '#a16b28' },
  { name: 'Rock',          color: '#e91229' },
  { name: 'Indie',         color: '#7d4b32' },
  { name: 'R&B',           color: '#dc148c' },
  { name: 'Soul',          color: '#e8115b' },
  { name: 'Country',       color: '#8d67ab' },
  { name: 'Latin',         color: '#e8115b' },
  { name: 'K-Pop',         color: '#14833b' },
  { name: 'J-Pop',         color: '#0c684e' },
  { name: 'Electronic',    color: '#1e3264' },
  { name: 'Dance',         color: '#1e3264' },
  { name: 'House',         color: '#2b1f6b' },
  { name: 'Lo-Fi',         color: '#503750' },
  { name: 'Jazz',          color: '#777777' },
  { name: 'Classical',      color: '#616161' },
  { name: 'Metal',         color: '#5a2c17' },
  { name: 'Punk',          color: '#a16b28' },
  { name: 'Folk',          color: '#6f5c1d' },
  { name: 'Reggae',        color: '#0c684e' },
  { name: 'Afrobeats',     color: '#14833b' },
  { name: 'Bollywood',     color: '#1e3264' },
  { name: 'Ambient',       color: '#3a3a3a' },
]

const MIN_GENRES = 2

export function GenresStep({ onNext, onPrev }: { onNext: () => void; onPrev: () => void }) {
  const { genres, setGenres, artists } = usePreferences()

  // Auto-pick genres from the artists the user already selected (gentle nudge)
  const inferred = useMemo(() => {
    const seen = new Set<string>()
    for (const a of artists) {
      const g = (a as any).genre as string | undefined
      if (g && !seen.has(g)) seen.add(g)
    }
    return Array.from(seen)
  }, [artists])

  const selectedSet = useMemo(() => new Set(genres), [genres])

  function toggle(name: string) {
    const next = selectedSet.has(name)
      ? genres.filter((g) => g !== name)
      : [...genres, name]
    setGenres(next)
    usePreferences.getState().save().catch(() => {})
  }

  const count = genres.length
  const meets = count >= MIN_GENRES

  return (
    <div className="min-h-full flex flex-col">
      <div className="px-6 pt-10 pb-6 max-w-6xl mx-auto w-full">
        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white text-center">
          Now pick {MIN_GENRES} or more genres you love.
        </h1>
        <p className="text-white/55 text-sm text-center mt-2">
          Refines your Daily Mixes and Smart Radio.
        </p>
      </div>

      <div className="px-6 pb-8 max-w-6xl mx-auto w-full flex-1">
        {inferred.length > 0 && (
          <p className="text-white/40 text-xs mb-4">
            From your selected artists, you might like: {inferred.join(', ')}.
          </p>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {TILES.map((t) => {
            const isSelected = selectedSet.has(t.name)
            return (
              <button
                key={t.name}
                onClick={() => toggle(t.name)}
                aria-pressed={isSelected}
                className={[
                  'relative h-16 rounded-md overflow-hidden transition-all text-left',
                  isSelected ? 'ring-2 ring-[#1ed760] ring-offset-1 ring-offset-black scale-[1.02]' : 'hover:scale-[1.03]'
                ].join(' ')}
                style={{ backgroundColor: t.color }}
              >
                <span className="absolute top-3 left-3 right-3 text-white font-bold text-sm tracking-wide drop-shadow-md">
                  {t.name}
                </span>
                {isSelected && (
                  <span className="absolute bottom-2 right-2 w-6 h-6 rounded-full bg-[#1ed760] flex items-center justify-center shadow-lg">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      <StepFooter
        onPrev={onPrev}
        onNext={onNext}
        nextLabel={meets ? 'Continue' : 'Skip for now'}
        nextDisabled={false}
        nextVariant="primary"
        hint={count > 0 ? `${count} selected` : undefined}
      />
    </div>
  )
}
