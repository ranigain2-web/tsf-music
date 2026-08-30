'use client'

/**
 * TSF Music — Search view (Search V2 UI — reference SearchScreen v3.4)
 *
 * Keyword mode runs the S0–S5 engine (/api/ytm/search-v2, plain-NDJSON):
 *   • progressive paint — the 'early' line renders rows immediately with a
 *     "refining…" indicator; the 'final' line swaps in the full result
 *   • typeahead rail while typing (recents at 0 ms → provider songs /
 *     artists + Best guess; keyboard-navigable; silent-fail → recents)
 *   • Catalog | YouTube source toggle (YouTube rows carry Video badges +
 *     view counts; a cooling-down source says so honestly)
 *   • Top-result hero for confident hits (sigState hit/rescued) playing the
 *     full queue at index 0 — the remaining rows list below without
 *     duplicating row 0
 *   • truthful reason lines (closed set, verbatim), lyric-match chips,
 *     version-cluster captions, full-artist display (artistsFull joined)
 *   • honest zero + Did-you-mean / correction chips / relaxation banner /
 *     S-PARTIAL disambiguation chips — never unrelated rows as matches
 *
 * Vibe mode is untouched: the query still goes to /api/ai/vibe-search and
 * renders with its Playlist-shortcut UI. MINDBEAT wiring preserved:
 * SEARCH_QUERY on settled results, SEARCH_CLICK on played rows.
 *
 * Note: the desktop search field lives in the TopBar (Enter pushes the
 * query — the typeahead rail is anchored to this view's own field, which
 * is the mobile field).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Search, Play, Wand2, Sparkles, Clock3, X, AudioLines, Loader2, Music4, Youtube, Disc3, RefreshCw, RotateCcw,
} from 'lucide-react'
import { usePlayer, type PlayerTrack } from '@/store/player'
import { api, useNav } from '@/store/nav'
import { TrackRow } from '@/components/shared'
import { AiPlaylistGenerator } from '@/components/ai/AiPlaylistGenerator'
// MINDBEAT: SEARCH_QUERY on settled results, SEARCH_CLICK on result rows
import { searchClick, searchQuery } from '@/lib/mindbeat/client'
import type { YtmTrack } from '@/lib/ytm/parse'
import { useSearchV2 } from '@/components/search/useSearchV2'
import { fetchTypeahead } from '@/components/search/stream'
import { buildRailItems, TypeaheadRail } from '@/components/search/TypeaheadRail'
import { TopResultHero } from '@/components/search/TopResultHero'
import { SearchResultRow, rowToPlayerTrack } from '@/components/search/SearchResultRow'
import type { SearchRow, SearchSourceKey, TypeaheadPayload } from '@/components/search/types'

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
// search debounce leaves a visible typeahead window (suggestions land at
// ~200 ms while the search waits, like the reference's 700/120 pair)
const SEARCH_DEBOUNCE_MS = 550
const TYPEAHEAD_DEBOUNCE_MS = 200
const LIST_HEAD_COUNT = 4 // rows shown beside the hero

/* Real-cover genre tiles: fetch the top album match for each genre once and
   swap the rotated corner mock for real artwork (Spotify browse cards use
   photography, flat mocks read as "clone"). Staggered + session-cached so we
   never fire 12 requests at once; failure keeps the gradient mock. */
const browseArtCache = new Map<string, string | null>()

function BrowseTile({
  name,
  colors,
  onPick,
  index,
}: {
  name: string
  colors: [string, string]
  onPick: () => void
  index: number
}) {
  const [art, setArt] = useState<string | null | undefined>(browseArtCache.get(name))

  useEffect(() => {
    if (art !== undefined) return
    let cancelled = false
    const t = setTimeout(() => {
      void api<{ albums?: { thumbnail?: string }[] }>(
        `/api/ytm/search?q=${encodeURIComponent(name + ' essentials')}&filter=albums`
      )
        .then((r) => {
          const thumb = r.albums?.find((a) => a.thumbnail)?.thumbnail ?? null
          browseArtCache.set(name, thumb)
          if (!cancelled) setArt(thumb)
        })
        .catch(() => {
          browseArtCache.set(name, null)
          if (!cancelled) setArt(null)
        })
    }, 120 * index) // stagger: avoids a burst of search calls on mount
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [art, name, index])

  return (
    <button
      onClick={onPick}
      className="relative aspect-[8/7] rounded-lg overflow-hidden text-left p-4 transition-transform hover:scale-[1.02] active:scale-[0.98]"
      style={{ background: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})` }}
    >
      <span className="text-lg font-bold text-white leading-tight pr-6 block">{name}</span>
      {/* Spotify signature: rotated album art in the corner (real cover once loaded) */}
      <div
        className="absolute -bottom-1.5 -right-2 w-[64px] h-[64px] rounded-[4px] rotate-[25deg] shadow-[0_4px_24px_rgba(0,0,0,0.5)] origin-bottom-right overflow-hidden"
        style={{
          background: `radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45), rgba(255,255,255,0.08) 42%), linear-gradient(135deg, ${colors[1]}, ${colors[0]})`,
          boxShadow: '0 4px 20px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.18)',
        }}
        aria-hidden
      >
        {art && (
          <img
            src={art}
            alt=""
            loading="lazy"
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none'
            }}
          />
        )}
      </div>
    </button>
  )
}

function persistRecent(next: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {}
  return next
}

interface VibeResponse {
  tracks: YtmTrack[]
  vibePlaylistShortcut: { prompt: string }
  artistsLike: { id?: string; name: string }[]
  intentConfidence?: number
  offline?: boolean
}

/** Honest rescue provenance — closed strings per rung (reference labels). */
const RESCUE_NOTES: Record<string, string> = {
  youtube: 'Found on YouTube · full song, ad-free',
  itunes: 'Found via Apple Music · 30s preview',
  variant: 'Found under a different spelling',
  album: 'Found via its album · full song',
}

export function SearchView({ initialQuery }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery ?? '')
  const [debounced, setDebounced] = useState(initialQuery ?? '')
  // LIVE SEARCH: the desktop field lives in TopBar and replaces the view's
  // q as you type — sync it into this component's query state so the
  // typeahead rail + debounced engine runs react per keystroke.
  const navView = useNav((s) => s.view)
  useEffect(() => {
    if (navView.type === 'search' && typeof navView.q === 'string' && navView.q && navView.q !== query) {
      setQuery(navView.q)
    }
  }, [navView])
  const [mode, setMode] = useState<'keyword' | 'vibe'>('keyword')
  const [source, setSource] = useState<SearchSourceKey>('catalog')
  const [vibe, setVibe] = useState<VibeResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [recent, setRecent] = useState<string[]>([])
  const [aiOpen, setAiOpen] = useState(false)
  const [aiPrefill, setAiPrefill] = useState<string | undefined>(undefined)
  // typeahead rail state (mobile field — the desktop field lives in TopBar)
  const [ta, setTa] = useState<TypeaheadPayload | null>(null)
  const [railFocus, setRailFocus] = useState(false)
  const [railDismissed, setRailDismissed] = useState(false)
  const [railHighlight, setRailHighlight] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const playQueue = usePlayer((s) => s.playQueue)

  const searchV2 = useSearchV2()
  const { loadMore, more } = searchV2

  // ---- F1 · sentinel: when the tail scrolls into view, append the next page
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore()
      },
      { rootMargin: '400px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore, more.hasMore])

  const rememberRecent = useCallback((q: string) => {
    try {
      const prev = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x: string) => x !== q)
      setRecent(persistRecent([q, ...prev].slice(0, 10)))
    } catch {}
  }, [])

  const removeRecent = (r: string) => {
    setRecent((prev) => persistRecent(prev.filter((x) => x !== r)))
  }
  const clearRecent = () => {
    setRecent(persistRecent([]))
  }

  useEffect(() => {
    try {
      setRecent(JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'))
    } catch {}
    // mobile only — the desktop field is the TopBar input (TopBar focuses it)
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) {
      inputRef.current?.focus()
    }
  }, [])

  // search debounce
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  // ── typeahead: recents at 0 ms, provider rows ~200 ms later; per-keystroke
  // AbortController; silent-fail degrades to recents-only ──
  useEffect(() => {
    const q = query.trim()
    if (mode !== 'keyword' || q.length < 2) {
      setTa(null)
      return
    }
    let latest = true
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      fetchTypeahead(q, ctrl.signal)
        .then((b) => {
          if (latest) setTa(b)
        })
        .catch(() => {
          if (latest) setTa(null) // rail stays up with recents only
        })
    }, TYPEAHEAD_DEBOUNCE_MS)
    return () => {
      latest = false
      clearTimeout(t)
      ctrl.abort()
    }
  }, [query, mode])

  // ── search when debounced changes (keyword → search-v2 engine; vibe →
  // intent brain, unchanged path) ──
  useEffect(() => {
    if (!debounced) {
      searchV2.reset()
      setVibe(null)
      setLoading(false)
      return
    }
    if (mode === 'vibe') {
      // VIBE MODE — existing flow, untouched
      searchV2.reset()
      setVibe(null)
      setLoading(true)
      void api<VibeResponse>('/api/ai/vibe-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: debounced }),
      })
        .then((r) => {
          setVibe(r)
          // MINDBEAT: vibe searches count as SEARCH_QUERY too
          searchQuery(debounced, r.tracks?.length || 0)
          rememberRecent(debounced)
        })
        .catch(() => setVibe({ tracks: [], vibePlaylistShortcut: { prompt: debounced }, artistsLike: [], offline: true }))
        .finally(() => setLoading(false))
      return
    }

    // KEYWORD MODE — the S0–S5 engine streams early+final NDJSON
    setVibe(null)
    setLoading(true)
    setTa(null) // the rail yields to the running search (reference behavior)
    setRailDismissed(true)
    searchV2.run(debounced, source)
  }, [debounced, mode, source])

  // ── settle side-effects (once per generation): ledger SEARCH_QUERY +
  // recent-searches write ──
  const settledGenRef = useRef(-1)
  useEffect(() => {
    if (searchV2.state.phase !== 'ready' || !debounced) return
    if (settledGenRef.current === searchV2.gen) return
    settledGenRef.current = searchV2.gen
    const count = searchV2.state.final.rows?.length ?? 0
    searchQuery(debounced, count)
    rememberRecent(debounced)
  }, [searchV2.gen, searchV2.state.phase, debounced])

  useEffect(() => {
    if (searchV2.state.phase !== 'loading') return
    setLoading(true)
  }, [searchV2.state.phase])
  useEffect(() => {
    if (searchV2.state.phase === 'ready' || searchV2.state.phase === 'idle') setLoading(false)
  }, [searchV2.state.phase])

  // ── derived result view-model ──
  const v2 = searchV2.state
  const rows: SearchRow[] =
    v2.phase === 'refining' ? v2.early.rows : v2.phase === 'ready' ? v2.final.rows ?? [] : []
  const corrected =
    v2.phase === 'ready' ? v2.final.corrected : v2.phase === 'refining' ? v2.early.corrected : undefined
  const sigState = v2.phase === 'ready' ? v2.final.sigState : undefined
  const plan = v2.phase === 'ready' ? v2.final.plan : undefined

  /** playable queue projection (rows without videoId stay display-only) */
  const playableTracks = useMemo(
    () => rows.filter((r) => r.videoId).map(rowToPlayerTrack),
    [rows]
  )
  const playAt = (row: SearchRow) => {
    const idx = playableTracks.findIndex((t) => t.videoId === row.videoId)
    if (idx < 0) return
    playQueue(playableTracks, idx, `Search: ${debounced}`)
  }
  const playRow = (row: SearchRow, rank: number) => {
    // MINDBEAT: SEARCH_CLICK — rank = position in the results list
    searchClick(row.id, rank)
    playAt(row)
  }

  /** deliberate query picks (rail, chips, recents, genres) run instantly */
  const runQuery = (q: string) => {
    setQuery(q)
    setDebounced(q.trim())
    inputRef.current?.focus()
  }

  // did-you-mean candidates for the honest zero state (from the engine's
  // correction + bounded variant spellings — never invented)
  const didYouMean = useMemo(() => {
    if (v2.phase !== 'ready' || v2.final.rows?.length) return []
    const q = debounced.toLowerCase()
    const out: string[] = []
    if (v2.final.corrected && v2.final.corrected.toLowerCase() !== q) out.push(v2.final.corrected)
    for (const v of v2.final.plan?.variants ?? []) {
      if (v.toLowerCase() !== q && !out.includes(v)) out.push(v)
    }
    return out.slice(0, 3)
  }, [v2, debounced])

  // rail model
  const railItems = useMemo(
    () => (mode === 'keyword' && query.trim().length >= 2 ? buildRailItems(recent, ta, query) : []),
    [mode, query, ta, recent]
  )
  const railOpen =
    mode === 'keyword' && query.trim().length >= 2 && railFocus && !railDismissed && railItems.length > 0

  const pickRail = (title: string) => {
    setRailDismissed(true)
    setTa(null)
    runQuery(title)
  }

  const onRailKeys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!railOpen || railItems.length === 0) {
      if (e.key === 'Enter' && query.trim()) {
        setRailDismissed(true)
        setDebounced(query.trim())
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setRailHighlight((h) => Math.min(h + 1, railItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setRailHighlight((h) => Math.max(h - 1, -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      setRailDismissed(true)
      if (railHighlight >= 0 && railItems[railHighlight]) pickRail(railItems[railHighlight].title)
      else setDebounced(query.trim())
    } else if (e.key === 'Escape') {
      setRailDismissed(true)
    }
  }

  // hero + list split (rest never duplicates row 0)
  const showHero =
    rows.length > 0 &&
    (v2.phase === 'refining' || sigState === undefined || sigState === 'hit' || sigState === 'rescued')
  const heroRow = rows[0]
  const rest = rows.slice(1)
  const restHead = rest.slice(0, LIST_HEAD_COUNT)
  const restMore = rest.slice(LIST_HEAD_COUNT)

  const vibeTracksAsPlayer = useMemo(
    () => (vibe?.tracks || []).map((t) => ({ ...t })) as PlayerTrack[],
    [vibe]
  )

  return (
    <div className="pb-8">
      {/* mobile search field (top bar input is desktop-visible in this view too) */}
      <div className="lg:hidden px-4 pt-2 pb-4 relative">
        <div className="relative">
          <Search size={20} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#b3b3b3]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setRailDismissed(false)
              setRailHighlight(-1)
            }}
            onFocus={() => setRailFocus(true)}
            onBlur={() => setRailFocus(false)}
            onKeyDown={onRailKeys}
            placeholder="What do you want to listen to?"
            className="w-full h-12 rounded bg-[#242424] text-white placeholder:text-[#a7a7a7] pl-11 pr-4 text-sm outline-none ring-1 ring-transparent focus:ring-1 focus:ring-white/70 hover:bg-[#2a2a2a] focus:bg-[#2a2a2a] transition-colors"
            aria-label="Search"
            aria-expanded={railOpen}
            role="combobox"
            aria-controls="search-typeahead-rail"
            autoComplete="off"
          />
          {query.length > 0 && (
            <button
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#a7a7a7] hover:text-white"
              aria-label="Clear search"
            >
              <X size={18} />
            </button>
          )}
        </div>
        {/* typeahead rail — recents at 0 ms, provider rows when they land */}
        {railOpen && (
          <div id="search-typeahead-rail" onBlur={(e) => e.stopPropagation()}>
            <TypeaheadRail
              items={railItems}
              highlight={railHighlight}
              onPick={pickRail}
              onHighlight={setRailHighlight}
            />
          </div>
        )}
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
            {GENRES.map((g, i) => (
              <BrowseTile key={g.name} name={g.name} colors={[g.colors[0], g.colors[1]]} index={i} onPick={() => runQuery(g.name)} />
            ))}
          </div>

          {recent.length > 0 && (
            <div className="mt-8">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-lg font-bold text-white">Recent searches</h3>
                <button
                  onClick={clearRecent}
                  className="text-[13px] font-bold text-[#a7a7a7] hover:text-white transition-colors px-3 h-8 rounded-full hover:bg-white/10"
                >
                  Clear all
                </button>
              </div>
              {/* Spotify mobile anatomy: vertical rows with clock icon + per-row remove */}
              <div>
                {recent.map((r) => (
                  <div
                    key={r}
                    className="group flex items-center gap-3 h-12 px-2 -mx-2 rounded-md hover:bg-[#1f1f1f] transition-colors cursor-pointer"
                    onClick={() => runQuery(r)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') runQuery(r)
                    }}
                  >
                    <Clock3 size={18} className="text-[#b3b3b3] shrink-0" />
                    <span className="flex-1 text-[15px] text-white truncate">{r}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        removeRecent(r)
                      }}
                      className="w-8 h-8 rounded-full flex items-center justify-center text-[#a7a7a7] hover:text-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity shrink-0"
                      aria-label={`Remove recent search ${r}`}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {debounced && (
        <>
          {/* mode toggle (Keyword | Vibe) + source toggle (Catalog | YouTube) */}
          <div className="flex items-center gap-2 px-4 lg:px-6 mb-4 mt-2 flex-wrap">
            <div className="flex items-center rounded-full bg-white/[0.06] p-0.5" role="tablist" aria-label="Search mode">
              <button
                onClick={() => setMode('keyword')}
                aria-selected={mode === 'keyword'}
                role="tab"
                className={`px-4 h-7 rounded-full text-[13px] font-bold transition-colors ${
                  mode === 'keyword' ? 'bg-white text-black' : 'text-[#a7a7a7] hover:text-white'
                }`}
              >
                Keyword
              </button>
              <button
                onClick={() => setMode('vibe')}
                role="tab"
                aria-selected={mode === 'vibe'}
                className={`flex items-center gap-1.5 px-4 h-7 rounded-full text-[13px] font-bold transition-colors ${
                  mode === 'vibe' ? 'bg-white text-black' : 'text-[#a7a7a7] hover:text-white'
                }`}
                title="Describe a feeling — the intent brain does the searching"
              >
                <AudioLines size={13} className={mode === 'vibe' ? 'text-black' : 'text-[#1ed760]'} />
                Vibe
              </button>
            </div>
            {mode === 'keyword' && (
              <div className="flex items-center rounded-full bg-white/[0.06] p-0.5" role="tablist" aria-label="Result source">
                <button
                  onClick={() => setSource('catalog')}
                  role="tab"
                  aria-selected={source === 'catalog'}
                  className={`flex items-center gap-1.5 px-3.5 h-7 rounded-full text-[13px] font-bold transition-colors ${
                    source === 'catalog' ? 'bg-white text-black' : 'text-[#a7a7a7] hover:text-white'
                  }`}
                >
                  <Disc3 size={13} />
                  Catalog
                </button>
                <button
                  onClick={() => setSource('youtube')}
                  role="tab"
                  aria-selected={source === 'youtube'}
                  className={`flex items-center gap-1.5 px-3.5 h-7 rounded-full text-[13px] font-bold transition-colors ${
                    source === 'youtube' ? 'bg-white text-black' : 'text-[#a7a7a7] hover:text-white'
                  }`}
                >
                  <Youtube size={13} />
                  YouTube
                </button>
              </div>
            )}
            {(loading || v2.phase === 'refining') && (
              <span className="flex items-center gap-1.5 text-[13px] text-[#a7a7a7] ml-1">
                <Loader2 size={13} className="animate-spin" />
                {mode === 'vibe' ? 'Reading the vibe…' : v2.phase === 'refining' ? 'Refining results…' : 'Searching…'}
              </span>
            )}
          </div>

          {/* VIBE results — same track list + one-tap playlist shortcut (unchanged) */}
          {mode === 'vibe' && (
            <div className="px-4 lg:px-6">
              <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                <div className="flex items-center gap-4">
                  {vibeTracksAsPlayer.length > 0 && (
                    <button
                      onClick={() => playQueue(vibeTracksAsPlayer, 0, `Vibe: ${debounced}`)}
                      className="flex items-center gap-2 text-sm text-[#1ed760] hover:scale-105 transition-transform font-bold"
                    >
                      <Play size={20} fill="currentColor" /> Play all
                    </button>
                  )}
                  {vibe && vibe.artistsLike.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[11px] uppercase tracking-wide text-[#7a7a7a] font-bold">Artists like</span>
                      {vibe.artistsLike.map((a) => (
                        <button
                          key={a.name}
                          onClick={() => {
                            setQuery(`${a.name} songs`)
                            setDebounced(`${a.name} songs`.trim())
                            setMode('keyword')
                          }}
                          className="px-3 h-7 rounded-full bg-white/[0.08] hover:bg-white/[0.16] text-xs text-white transition-colors active:scale-95"
                        >
                          {a.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {vibe && vibe.tracks.length > 0 && (
                  <button
                    onClick={() => {
                      setAiPrefill(vibe.vibePlaylistShortcut?.prompt || debounced)
                      setAiOpen(true)
                    }}
                    className="flex items-center gap-1.5 rounded-full bg-[#1ed760] text-black px-4 h-8 text-xs font-bold hover:scale-[1.04] active:scale-95 transition-transform"
                  >
                    <Wand2 size={13} />
                    Playlist this vibe
                  </button>
                )}
              </div>
              {vibeTracksAsPlayer.map((t, i) => (
                <TrackRow
                  key={t.videoId}
                  track={t}
                  index={i}
                  onPlay={() => {
                    // MINDBEAT: SEARCH_CLICK — rank = position in the rendered list
                    searchClick(t.videoId, i)
                    playQueue(vibeTracksAsPlayer, i, `Vibe: ${debounced}`)
                  }}
                />
              ))}
              {vibe && !vibe.tracks.length && !loading && <EmptyState query={debounced} />}
            </div>
          )}

          {/* KEYWORD results — the Search V2 surface */}
          {mode === 'keyword' && (
            <div className="px-4 lg:px-6">
              {/* first paint with nothing yet */}
              {v2.phase === 'loading' && rows.length === 0 && (
                <div className="py-16 flex flex-col items-center gap-3 text-[#a7a7a7]">
                  <Loader2 size={28} className="animate-spin text-[#1ed760]" />
                  <span className="text-sm">Searching&hellip;</span>
                </div>
              )}

              {/* honest failure (stream error with nothing to show) */}
              {rows.length === 0 && v2.phase === 'ready' && v2.error && (
                <div className="py-16 text-center">
                  <p className="text-xl font-bold text-white mb-2">Search hit a snag</p>
                  <p className="text-sm text-[#a7a7a7] mb-4">{v2.error}</p>
                  <button
                    onClick={() => searchV2.run(debounced, source)}
                    className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] hover:bg-white/[0.1] px-4 h-9 text-sm text-white transition-colors"
                  >
                    <RefreshCw size={14} /> Try again
                  </button>
                </div>
              )}

              {/* YouTube cooling-down honesty (kill-switch, never a bare "no results") */}
              {rows.length === 0 &&
                v2.phase === 'ready' &&
                !v2.error &&
                source === 'youtube' &&
                v2.final.ytUnavailable && (
                  <div className="py-16 text-center" data-testid="yt-cooling-down">
                    <Youtube size={40} className="mx-auto text-[#5a5a5a] mb-3" />
                    <p className="text-xl font-bold text-white mb-2">YouTube is cooling down</p>
                    <p className="text-sm text-[#a7a7a7] mb-4 max-w-md mx-auto">
                      Repeated stream failures put the source in a short cooldown — try again shortly.
                      Catalog search still works.
                    </p>
                    <button
                      onClick={() => setSource('catalog')}
                      className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] hover:bg-white/[0.1] px-4 h-9 text-sm text-white transition-colors"
                    >
                      <Disc3 size={14} /> Back to Catalog
                    </button>
                  </div>
                )}

              {/* honest zero + recovery chips */}
              {rows.length === 0 &&
                v2.phase === 'ready' &&
                !v2.error &&
                !(source === 'youtube' && v2.final.ytUnavailable) && (
                  <div className="py-16 text-center" data-testid="search-zero-state">
                    <Music4 size={40} className="mx-auto text-[#5a5a5a] mb-3" />
                    <p className="text-xl font-bold text-white mb-2">No results for &ldquo;{debounced}&rdquo;</p>
                    {didYouMean.length > 0 ? (
                      <div className="mt-4">
                        <div className="text-[13px] text-[#a7a7a7] mb-2">Did you mean</div>
                        <div className="flex items-center justify-center gap-2 flex-wrap">
                          {didYouMean.map((d) => (
                            <button
                              key={d}
                              onClick={() => runQuery(d)}
                              className="rounded-full bg-white/[0.06] hover:bg-white/[0.1] px-4 h-9 text-sm text-white transition-colors"
                            >
                              {d}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-[#a7a7a7]">
                        Check the spelling or try something else
                      </p>
                    )}
                  </div>
                )}

              {rows.length > 0 && (
                <>
                  {/* recovery banners — correction pair, relaxation, rescue, lyric, partial */}
                  {(corrected && corrected.toLowerCase() !== debounced.toLowerCase()) ||
                  (v2.phase === 'ready' && v2.final.relaxedQuery) ||
                  (v2.phase === 'ready' && v2.final.plan?.kind === 'lyric_fragment') ||
                  (v2.phase === 'ready' && v2.final.rescueRung) ||
                  (v2.phase === 'ready' && sigState === 'partial') ? (
                    <div className="space-y-2 mb-4" data-testid="search-banners">
                      {corrected && corrected.toLowerCase() !== debounced.toLowerCase() && (
                        <div
                          className="flex items-center gap-2 flex-wrap text-[13px]"
                          data-testid="search-correction"
                        >
                          <span className="text-[#a7a7a7]">Results for</span>
                          <button
                            onClick={() => runQuery(corrected!)}
                            className="rounded-full bg-[#1ed760]/15 border border-[#1ed760]/40 hover:bg-[#1ed760]/25 px-3 h-8 font-bold text-[#1ed760] transition-colors"
                          >
                            &ldquo;{corrected}&rdquo;
                          </button>
                          <span className="text-[#a7a7a7]">· searched for</span>
                          <span className="rounded-full bg-white/[0.06] px-3 h-8 flex items-center text-[#a7a7a7]">
                            &ldquo;{debounced}&rdquo;
                          </span>
                        </div>
                      )}
                      {v2.phase === 'ready' && v2.final.relaxedQuery && (
                        <div className="text-[13px] text-[#a7a7a7]" data-testid="search-relaxed">
                          Showing results for &ldquo;{v2.final.relaxedQuery}&rdquo;
                        </div>
                      )}
                      {v2.phase === 'ready' && v2.final.rescueRung && RESCUE_NOTES[v2.final.rescueRung] && (
                        <div className="text-[13px] text-[#a7a7a7]" data-testid="search-rescued">
                          {RESCUE_NOTES[v2.final.rescueRung]}
                        </div>
                      )}
                      {v2.phase === 'ready' && v2.final.plan?.kind === 'lyric_fragment' && (
                        <div className="text-[13px] text-[#a7a7a7]" data-testid="search-lyric-banner">
                          Showing songs whose lyrics match &ldquo;{debounced}&rdquo;
                        </div>
                      )}
                      {v2.phase === 'ready' && sigState === 'partial' && (
                        <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-4" data-testid="search-partial">
                          <div className="text-sm font-bold text-white truncate">
                            Songs matching &ldquo;{debounced}&rdquo;
                          </div>
                          <div className="text-[13px] text-[#a7a7a7] mt-0.5">
                            The artist&apos;s own version isn&apos;t available right now — did you mean:
                          </div>
                          {(v2.final.partialArtists?.length ?? 0) > 0 && (
                            <div className="flex items-center gap-2 flex-wrap mt-2.5">
                              {(v2.final.partialArtists ?? []).slice(0, 5).map((a) => (
                                <button
                                  key={a}
                                  onClick={() => {
                                    const base =
                                      plan?.titleTokens?.join(' ').trim() || debounced
                                    runQuery(`${base} ${a}`.trim())
                                  }}
                                  className="rounded-full bg-white/[0.06] hover:bg-white/[0.1] px-3.5 h-8 text-[13px] text-white transition-colors"
                                >
                                  {a}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : null}

                  {/* Top result hero + first rows (never duplicating row 0) */}
                  <div className="grid lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)] gap-4 lg:gap-6 items-start">
                    <div>
                      <h3 className="text-xl font-bold text-white mb-3">Top result</h3>
                      {showHero && heroRow && (
                        <TopResultHero
                          row={heroRow}
                          playable={!!heroRow.videoId}
                          onPlay={() => playRow(heroRow, 0)}
                        />
                      )}
                      {!showHero && heroRow && (
                        // S-PARTIAL: no confident hit — the banner + list speak
                        <div className="text-[13px] text-[#a7a7a7] px-1">
                          Matches are approximate — pick a row below, or refine with the chips above.
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-xl font-bold text-white mb-3">Songs</h3>
                      <div>
                        {restHead.map((row, i) => (
                          <SearchResultRow
                            key={row.id}
                            row={row}
                            rank={i + 1}
                            playable={!!row.videoId}
                            onPlay={() => playRow(row, i + 1)}
                          />
                        ))}
                      </div>
                    </div>
                  </div>

                  {restMore.length > 0 && (
                    <div className="mt-6">
                      <h3 className="text-xl font-bold text-white mb-3">More results</h3>
                      <div>
                        {restMore.map((row, i) => (
                          <SearchResultRow
                            key={row.id}
                            row={row}
                            rank={i + 1 + LIST_HEAD_COUNT}
                            playable={!!row.videoId}
                            onPlay={() => playRow(row, i + 1 + LIST_HEAD_COUNT)}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* F1 · infinite-pagination tail — sentinel + honest states.
                      Catalog appends continuation pages; YouTube/vibe are
                      bounded sets and say so instead of pretending. */}
                  {rows.length > 0 && (
                    <div className="mt-4 pb-2">
                      {more.loading && (
                        <div className="flex items-center justify-center gap-2 py-3 text-[13px] text-[#a7a7a7]">
                          <Loader2 size={14} className="animate-spin" /> Loading more results…
                        </div>
                      )}
                      {!more.loading && more.note && (
                        <div className="py-3 text-center text-[13px] text-[#a7a7a7] border-t border-white/5">
                          {more.note}
                        </div>
                      )}
                      {!more.loading && !more.note && more.error && (
                        <button
                          onClick={() => void searchV2.loadMore()}
                          className="mx-auto flex items-center gap-2 py-2 px-4 rounded-full text-[13px] text-white/80 border border-white/15 hover:border-white/40 transition-colors"
                        >
                          <RotateCcw size={13} /> Retry loading more
                        </button>
                      )}
                      {v2.phase === 'ready' && v2.source === 'youtube' && rows.length > 0 && !more.note && (
                        <div className="py-3 text-center text-[13px] text-[#a7a7a7] border-t border-white/5">
                          That&rsquo;s everything YouTube found
                        </div>
                      )}
                      <div ref={sentinelRef} className="h-px w-full" aria-hidden />
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      <AiPlaylistGenerator open={aiOpen} onOpenChange={setAiOpen} initialPrompt={aiPrefill} />
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
