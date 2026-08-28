'use client'

import { useEffect, useMemo, useState, useRef } from 'react'
import { usePreferences } from '@/store/preferences'
import type { SelectedArtist } from '@/app/api/onboarding/route'
import { StepFooter } from './StepFooter'

/**
 * ArtistsStep — multi-select artist picker.
 *
 * Spotify-signup-pattern (the EXACT screen Spotify shows during signup):
 *   - Big bold headline "Choose 3 or more artists you like."
 *   - Subtitle "We'll build playlists from them."
 *   - Search input (sticky, with magnifier icon, dark pill, white text)
 *   - 4-column grid (desktop) / 2-col (mobile) of rounded-square artist cards:
 *       · album cover fills the card (or initials tile if no thumbnail)
 *       · artist name below (white text, smaller, 1-line truncate)
 *       · "+ checkmark" button overlay in the top-right corner
 *         (when selected: filled green circle with white check + slight scale-up)
 *   - Sticky footer: "X of 3 selected" left + green "Next" right (disabled until 3+)
 *   - When the user searches, the grid is replaced with live results.
 *   - Selected artists persist across search/clear so users don't lose picks.
 */

interface ArtistGrid extends SelectedArtist {
  genre?: string
}

const MIN_SELECTED = 3

export function ArtistsStep({ onNext, onPrev }: { onNext: () => void; onPrev: () => void }) {
  const { artists: selected, setArtists } = usePreferences()
  const [grid, setGrid] = useState<ArtistGrid[]>([])
  const [genres, setGenres] = useState<{ genre: string; color: string }[]>([])
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<ArtistGrid[]>([])
  const [searching, setSearching] = useState(false)
  const [activeGenre, setActiveGenre] = useState<string>('All')
  const [loading, setLoading] = useState(true)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load curated grid once
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/onboarding/seed-artists')
        const j = await r.json()
        if (cancelled) return
        setGrid(j.artists || [])
        setGenres(j.genres || [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Debounced live search (≥ 2 chars)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = search.trim()
    if (q.length < 2) { setSearchResults([]); setSearching(false); return }
    setSearching(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/onboarding/seed-artists?q=${encodeURIComponent(q)}`)
        const j = await r.json()
        setSearchResults(j.artists || [])
      } finally {
        setSearching(false)
      }
    }, 300)
  }, [search])

  const selectedIds = useMemo(() => new Set(selected.map((a) => a.id)), [selected])
  const showingSearch = search.trim().length >= 2

  const displayed: ArtistGrid[] = showingSearch
    ? searchResults
    : (activeGenre === 'All'
        ? grid
        : grid.filter((a) => a.genre === activeGenre))

  function toggle(a: ArtistGrid) {
    const next = selectedIds.has(a.id)
      ? selected.filter((s) => s.id !== a.id)
      : [...selected, { id: a.id, name: a.name, thumbnail: a.thumbnail }]
    setArtists(next)
    usePreferences.getState().save().catch(() => {})
  }

  const count = selected.length
  const meets = count >= MIN_SELECTED

  return (
    <div className="min-h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-10 pb-6 max-w-6xl mx-auto w-full">
        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white text-center">
          Choose {MIN_SELECTED} or more artists you like.
        </h1>
        <p className="text-white/55 text-sm text-center mt-2">
          We'll build mixes and smart radio from these.
        </p>
      </div>

      {/* Sticky search bar */}
      <div className="sticky top-0 z-10 bg-black/85 backdrop-blur-md border-y border-white/5">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search for artists"
              className="w-full pl-9 pr-4 py-2.5 rounded-md bg-[#1a1a1a] border border-white/10 text-white text-sm placeholder-white/40 outline-none focus:border-[#1ed760] focus:bg-[#222] transition-colors"
              autoFocus={false}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/40 hover:text-white"
                aria-label="Clear search"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            )}
          </div>

          {!showingSearch && (
            <div className="ml-auto hidden sm:flex items-center gap-1 overflow-x-auto">
              <GenreChip label="All"    active={activeGenre === 'All'}    onClick={() => setActiveGenre('All')} color="#1ed760"/>
              {genres.map((g) => (
                <GenreChip
                  key={g.genre}
                  label={g.genre}
                  active={activeGenre === g.genre}
                  onClick={() => setActiveGenre(g.genre)}
                  color={g.color}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 px-6 py-6 max-w-6xl mx-auto w-full">
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            {Array.from({ length: 15 }).map((_, i) => (
              <div key={i} className="aspect-square rounded-md bg-white/5 animate-pulse" />
            ))}
          </div>
        ) : displayed.length === 0 ? (
          <div className="text-center py-16 text-white/40 text-sm">
            {searching ? 'Searching…' : (showingSearch ? 'No artists found.' : 'No artists in this genre.')}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-6">
            {displayed.map((a) => {
              const isSelected = selectedIds.has(a.id)
              return (
                <ArtistCard key={a.id + (a.thumbnail || '')} artist={a} selected={isSelected} onToggle={() => toggle(a)} />
              )
            })}
          </div>
        )}
      </div>

      <StepFooter
        onPrev={onPrev}
        onNext={onNext}
        nextLabel="Continue"
        nextDisabled={!meets}
        nextVariant="primary"
        hint={`${count} of ${MIN_SELECTED} selected`}
      />
    </div>
  )
}

function ArtistCard({ artist, selected, onToggle }: { artist: ArtistGrid; selected: boolean; onToggle: () => void }) {
  const initials = useMemo(() => {
    const parts = artist.name.split(/\s+/).filter(Boolean)
    if (parts.length === 0) return '?'
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }, [artist.name])

  return (
    <button
      onClick={onToggle}
      className={[
        'group relative flex flex-col items-start gap-2 rounded-md p-3 transition-all',
        selected ? 'bg-white/10 ring-1 ring-[#1ed760]/60' : 'hover:bg-white/5'
      ].join(' ')}
      aria-pressed={selected}
      aria-label={`${selected ? 'Remove' : 'Add'} ${artist.name}`}
    >
      <div className="relative w-full aspect-square rounded-lg overflow-hidden bg-gradient-to-br from-[#333] to-[#1a1a1a] shadow-[0_8px_24px_-8px_rgba(0,0,0,0.7)] ring-1 ring-white/5">
        {artist.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={artist.thumbnail}
            alt={artist.name}
            className="w-full h-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-white/70 text-3xl font-bold uppercase">
            {initials}
          </div>
        )}

        {/* Spotify-style play/select button overlay (bottom-right) */}
        <div
          className={[
            'absolute bottom-2 right-2 w-8 h-8 rounded-full flex items-center justify-center transition-all shadow-lg',
            selected
              ? 'bg-[#1ed760] text-black scale-100'
              : 'bg-black/70 text-white opacity-0 group-hover:opacity-100 scale-90 hover:scale-100'
          ].join(' ')}
        >
          {selected ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          )}
        </div>
      </div>

      <div className="w-full text-left">
        <div className="text-white text-sm font-medium truncate leading-tight">{artist.name}</div>
        {artist.genre && (
          <div className="text-white/40 text-xs mt-0.5 truncate">Artist</div>
        )}
      </div>
    </button>
  )
}

function GenreChip({ label, active, onClick, color }: { label: string; active: boolean; onClick: () => void; color: string }) {
  return (
    <button
      onClick={onClick}
      className={[
        'shrink-0 px-3 py-1 rounded-full text-xs font-bold transition-all whitespace-nowrap',
        active ? 'text-white' : 'text-white/50 hover:text-white/80'
      ].join(' ')}
      style={active ? { backgroundColor: color } : { backgroundColor: 'rgba(255,255,255,0.06)' }}
    >
      {label}
    </button>
  )
}
