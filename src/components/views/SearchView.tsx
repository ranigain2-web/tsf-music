'use client'

/**
 * TSF Music — Search view
 * Live search with tabs (All / Songs / Albums / Artists), recent searches,
 * browse genre cards when empty, AI Playlist Generator entry.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Play, Wand2, Sparkles } from 'lucide-react'
import { usePlayer, type PlayerTrack } from '@/store/player'
import { api, useNav } from '@/store/nav'
import { TrackRow, AlbumCard, ArtistCard } from '@/components/shared'
import { AiPlaylistGenerator } from '@/components/ai/AiPlaylistGenerator'
import type { YtmTrack, YtmAlbum, YtmArtist } from '@/lib/ytm/parse'

const GENRES = [
  { name: 'Pop', colors: ['#e13300', '#537895'] },
  { name: 'Hip-Hop', colors: ['#ba5d07', '#503750'] },
  { name: 'Rock', colors: ['#e8145c', '#503750'] },
  { name: 'Dance/Electronic', colors: ['#0d73ec', '#503750'] },
  { name: 'Mood', colors: ['#7358ff', '#503750'] },
  { name: 'Indie', colors: ['#8d67ab', '#503750'] },
  { name: 'R&B', colors: ['#dc148c', '#503750'] },
  { name: 'Chill', colors: ['#1e3264', '#503750'] },
  { name: 'Workout', colors: ['#477d95', '#503750'] },
  { name: 'Sleep', colors: ['#1e3264', '#503750'] },
  { name: 'Party', colors: ['#af2896', '#503750'] },
  { name: 'Focus', colors: ['#503750', '#537895'] },
]

const RECENT_KEY = 'tsf-recent-searches'

export function SearchView({ initialQuery }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery ?? '')
  const [debounced, setDebounced] = useState(initialQuery ?? '')
  const [tab, setTab] = useState<'all' | 'songs' | 'albums' | 'artists'>('all')
  const [results, setResults] = useState<{ tracks: YtmTrack[]; albums: YtmAlbum[]; artists: YtmArtist[]; offline: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [recent, setRecent] = useState<string[]>([])
  const [aiOpen, setAiOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const playQueue = usePlayer((s) => s.playQueue)

  useEffect(() => {
    try {
      setRecent(JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'))
    } catch {}
    inputRef.current?.focus()
  }, [])

  // debounce
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 350)
    return () => clearTimeout(t)
  }, [query])

  // search when debounced changes
  useEffect(() => {
    if (!debounced) {
      setResults(null)
      return
    }
    let cancelled = false
    setLoading(true)
    const filter = tab === 'songs' ? 'songs' : undefined
    void api<{ tracks: YtmTrack[]; albums: YtmAlbum[]; artists: YtmArtist[]; offline: boolean }>(
      `/api/ytm/search?q=${encodeURIComponent(debounced)}${filter ? `&filter=${filter}` : ''}`
    )
      .then((r) => {
        if (cancelled) return
        setResults(r)
        // save recent
        try {
          const prev = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x: string) => x !== debounced)
          const next = [debounced, ...prev].slice(0, 10)
          localStorage.setItem(RECENT_KEY, JSON.stringify(next))
          setRecent(next)
        } catch {}
      })
      .catch(() => !cancelled && setResults({ tracks: [], albums: [], artists: [], offline: true }))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [debounced, tab])

  const tracksAsPlayer = useMemo(
    () => (results?.tracks || []).map((t) => ({ ...t })) as PlayerTrack[],
    [results]
  )

  return (
    <div className="pb-8">
      {/* mobile search field (top bar input is desktop-visible in this view too) */}
      <div className="lg:hidden px-4 pt-2 pb-4">
        <div className="relative">
          <Search size={20} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#b3b3b3]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What do you want to listen to?"
            className="w-full h-12 rounded bg-[#242424] text-white placeholder:text-[#a7a7a7] pl-11 pr-4 text-sm outline-none focus:ring-1 focus:ring-white"
          />
        </div>
      </div>

      {!debounced && (
        <div className="px-4 lg:px-6">
          {/* AI Playlist Generator banner */}
          <button
            onClick={() => setAiOpen(true)}
            className="w-full mb-6 p-4 lg:p-5 rounded-lg bg-gradient-to-r from-[#1ed760]/15 via-[#0d73ec]/15 to-[#503750]/15 border border-[#1ed760]/30 hover:border-[#1ed760]/60 transition-colors flex items-center gap-4 text-left"
          >
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#1ed760] to-[#0d73ec] flex items-center justify-center shrink-0">
              <Wand2 size={22} className="text-black" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-white font-bold flex items-center gap-1.5">
                <Sparkles size={14} className="text-[#1ed760]" />
                Create playlist with AI
              </div>
              <div className="text-[13px] text-[#a7a7a7] mt-0.5">
                Describe a vibe, mood, or theme and we&apos;ll build you a fresh playlist
              </div>
            </div>
            <span className="text-[#1ed760] text-xs font-bold shrink-0 hidden sm:block">Try →</span>
          </button>

          <h2 className="text-xl font-bold text-white mb-4">Browse all</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5">
            {GENRES.map((g) => (
              <button
                key={g.name}
                onClick={() => setQuery(g.name)}
                className="relative h-[110px] rounded-lg overflow-hidden text-left p-4 transition-transform hover:scale-[1.02]"
                style={{ background: `linear-gradient(135deg, ${g.colors[0]}, ${g.colors[1]})` }}
              >
                <span className="text-lg font-bold text-white">{g.name}</span>
                <div className="absolute -bottom-3 -right-3 w-[68px] h-[68px] rounded shadow-2xl rotate-[25deg]" style={{ background: g.colors[1] }} />
              </button>
            ))}
          </div>

          {recent.length > 0 && (
            <div className="mt-8">
              <h3 className="text-lg font-bold text-white mb-3">Recent searches</h3>
              <div className="flex flex-wrap gap-2">
                {recent.map((r) => (
                  <button
                    key={r}
                    onClick={() => setQuery(r)}
                    className="px-4 h-9 rounded-full bg-white/10 hover:bg-white/20 text-sm text-white transition-colors"
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {debounced && (
        <>
          {/* filter tabs */}
          <div className="flex items-center gap-2 px-4 lg:px-6 mb-4 mt-2">
            {(['all', 'songs', 'albums', 'artists'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 h-8 rounded-full text-sm font-medium capitalize transition-colors ${
                  tab === t ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'
                }`}
              >
                {t}
              </button>
            ))}
            {loading && <span className="text-[13px] text-[#a7a7a7] ml-1">Searching…</span>}
          </div>

          {/* top result + songs (All tab) */}
          {tab === 'all' && results && (
            <div className="px-0 lg:px-0">
              {results.artists.length > 0 && (
                <div className="grid lg:grid-cols-[minmax(280px,1fr)_2fr] gap-6 px-4 lg:px-6 mb-6">
                  {/* top result card */}
                  <div>
                    <h3 className="text-xl font-bold text-white mb-3">Top result</h3>
                    <div
                      className="group relative bg-[#181818] hover:bg-[#282828] p-5 max-lg:p-3 rounded-lg cursor-pointer transition-colors"
                      onClick={() => results.artists[0] && (window.location.hash = '')}
                    >
                      {results.artists[0] && (
                        <TopResultCard artist={results.artists[0]} />
                      )}
                    </div>
                  </div>
                  {/* songs list */}
                  <div>
                    <h3 className="text-xl font-bold text-white mb-3">Songs</h3>
                    <div>
                      {tracksAsPlayer.slice(0, 4).map((t, i) => (
                        <TrackRow
                          key={t.videoId}
                          track={t}
                          index={i}
                          showIndex={false}
                          showAlbum={false}
                          onPlay={() => playQueue(tracksAsPlayer, i, `Search: ${debounced}`)}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {results.artists.length > 0 && (
                <Section title="Artists">
                  {results.artists.map((a) => (
                    <ArtistCard key={a.browseId} id={a.browseId} name={a.name} thumbnail={a.thumbnail} subscribers={a.subscribers} />
                  ))}
                </Section>
              )}
              {results.albums.length > 0 && (
                <Section title="Albums">
                  {results.albums.map((a) => (
                    <AlbumCard key={a.browseId} id={a.browseId} name={a.name} artist={a.artistName} thumbnail={a.thumbnail} year={a.year} />
                  ))}
                </Section>
              )}
            </div>
          )}

          {/* songs tab */}
          {tab === 'songs' && (
            <div className="px-4 lg:px-6">
              {tracksAsPlayer.length > 0 ? (
                <>
                  <button
                    onClick={() => playQueue(tracksAsPlayer, 0, `Search: ${debounced}`)}
                    className="mb-3 flex items-center gap-2 text-sm text-[#1ed760] hover:scale-105 transition-transform font-bold"
                  >
                    <Play size={20} fill="currentColor" /> Play all
                  </button>
                  {tracksAsPlayer.map((t, i) => (
                    <TrackRow
                      key={t.videoId}
                      track={t}
                      index={i}
                      onPlay={() => playQueue(tracksAsPlayer, i, `Search: ${debounced}`)}
                    />
                  ))}
                </>
              ) : (
                !loading && <EmptyState query={debounced} />
              )}
            </div>
          )}

          {/* albums tab */}
          {tab === 'albums' && (
            <Section title="Albums">
              {results?.albums.map((a) => (
                <AlbumCard key={a.browseId} id={a.browseId} name={a.name} artist={a.artistName} thumbnail={a.thumbnail} year={a.year} />
              ))}
              {results && !results.albums.length && !loading && <div className="px-4 lg:px-6"><EmptyState query={debounced} /></div>}
            </Section>
          )}

          {/* artists tab */}
          {tab === 'artists' && (
            <Section title="Artists">
              {results?.artists.map((a) => (
                <ArtistCard key={a.browseId} id={a.browseId} name={a.name} thumbnail={a.thumbnail} subscribers={a.subscribers} />
              ))}
              {results && !results.artists.length && !loading && <div className="px-4 lg:px-6"><EmptyState query={debounced} /></div>}
            </Section>
          )}
        </>
      )}

      <AiPlaylistGenerator open={aiOpen} onOpenChange={setAiOpen} />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="text-xl font-bold text-white mb-3 px-4 lg:px-6">{title}</h3>
      <div className="flex gap-1.5 lg:gap-4 overflow-x-auto no-scrollbar px-4 lg:px-6 pb-1">{children}</div>
    </section>
  )
}

function TopResultCard({ artist }: { artist: YtmArtist }) {
  const push = useNav((s) => s.push)
  return (
    <div
      onClick={() => push({ type: 'artist', id: artist.browseId, title: artist.name })}
      className="cursor-pointer"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={artist.thumbnail}
        alt={artist.name}
        className="w-[92px] h-[92px] max-lg:w-16 max-lg:h-16 rounded-full object-cover mb-4 max-lg:mb-2 shadow-xl"
      />
      <div className="text-2xl max-lg:text-lg font-bold text-white truncate mb-1">{artist.name}</div>
      <div className="text-[13px] text-[#a7a7a7] mb-4">
        <span className="bg-[#2a2a2a] px-2.5 py-1 rounded-full uppercase text-[11px] font-bold tracking-wide">Artist</span>
        {artist.subscribers && <span className="ml-2">{artist.subscribers}</span>}
      </div>
      <button className="card-play-btn force-visible absolute bottom-5 right-5 max-lg:bottom-3 max-lg:right-3 max-lg:w-10 max-lg:h-10 w-12 h-12 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105">
        <Play size={20} fill="currentColor" />
      </button>
    </div>
  )
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="py-16 text-center">
      <p className="text-xl font-bold text-white mb-2">No results found for &ldquo;{query}&rdquo;</p>
      <p className="text-sm text-[#a7a7a7]">Please make sure your words are spelled correctly, or use fewer or different keywords.</p>
    </div>
  )
}
