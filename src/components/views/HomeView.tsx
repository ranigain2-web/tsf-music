'use client'

/**
 * TSF Music — Home view (PERSONALIZED + AI-FEATURED)
 *
 * Two main rows from AI:
 *   1. Featured AI hubs (Discover Weekly, Release Radar, Daylist, On Repeat)
 *   2. Mood hubs (10 moods)
 *
 * Plus:
 *   - Quick picks (history or favorite-artist top tracks)
 *   - "Made for [Name]" Daily Mix cards
 *   - Personalized shelves (top artists, top tracks, more like, discography,
 *     "Because you like [genre]")
 *
 * NO generic trending YouTube Music content. Everything is derived from
 * the user's onboarding selections.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Sparkles, Wand2, Compass, Satellite, AlarmClock, Repeat2, Mic2, BookOpenText, Loader2, RotateCcw, Infinity as InfinityIcon, type LucideIcon } from 'lucide-react'
import { usePlayer, type PlayerTrack } from '@/store/player'
import { api, useNav } from '@/store/nav'
import { useLibrary } from '@/store/library'
import { usePreferences } from '@/store/preferences'
import { markQueueSource, shelfExposure } from '@/lib/mindbeat/client'
import type { SourceSurface } from '@/lib/mindbeat/types'
import { Shelf, AlbumCard, ArtistCard, TrackRow } from '@/components/shared'
import { Artwork } from '@/components/Artwork'
import { AiPlaylistGenerator } from '@/components/ai/AiPlaylistGenerator'
import type { YtmShelf } from '@/lib/ytm/parse'

interface HistoryTrack extends PlayerTrack {
  _historyBrand?: symbol
}

interface DailyMix {
  id: string
  title: string
  subtitle: string
  cover?: string
  tracks: PlayerTrack[]
}

interface AiHome {
  shelves: (YtmShelf & { id?: string })[]
  mixes: DailyMix[]
  topArtists: { id: string; name: string; thumbnail?: string }[]
  greeting: string
  name?: string
  needsOnboarding?: boolean
  /** Shelf-bandit transparency (task 15-c): live = a champion earned the top slot. */
  bandit?: { mode: 'live' | 'cold'; champion?: string; dayBucket: number }
}

interface FeaturedCard {
  id: string
  kind: 'playlist' | 'mood-hub'
  title: string
  subtitle: string
  cover?: string
  gradient?: [string, string]
  emoji?: string
  icon?: string
  endpoint: string
  view?: 'playlist' | 'ai-generated'
}

interface MoodCard {
  key: string
  title: string
  subtitle: string
  gradient: [string, string]
  emoji: string
}

interface FeaturedResponse {
  cards: FeaturedCard[]
  moods: MoodCard[]
  needsOnboarding?: boolean
}

const FEATURED_ICONS: Record<string, React.ReactNode> = {
  Compass: <Compass size={46} className="text-white/85" strokeWidth={1.5} />,
  Satellite: <Satellite size={46} className="text-white/85" strokeWidth={1.5} />,
  AlarmClock: <AlarmClock size={46} className="text-white/85" strokeWidth={1.5} />,
  Repeat2: <Repeat2 size={46} className="text-white/85" strokeWidth={1.5} />,
}

/**
 * Shelf-bandit telemetry (task 15-c): the rec surface a shelf's track plays
 * attribute to. Shelves without a mapping ('top-artists', 'more-like-*',
 * 'albums-*') have no direct track plays from the shelf itself.
 */
function shelfSurfaceForId(id: string): SourceSurface | null {
  if (id === 'now-sound') return 'daylist'
  if (id === 'on-the-rise') return 'discovery'
  if (id.startsWith('daily-mix-')) return 'daily_mix'
  if (id.startsWith('genre-')) return 'ai_playlist'
  if (id.startsWith('artist-top-')) return 'artist'
  return null
}

/** Daily Mix card ids (dm-N) → the bandit's daily-mix-N shelf id space. */
function mixShelfId(mixId: string): string {
  return mixId.startsWith('dm-') ? `daily-mix-${mixId.slice(3)}` : mixId
}

export function HomeView() {
  // ---- INSTANT PAINT (the "opening takes a while" fix) --------------------
  // The last home payload is mirrored in localStorage; the very first render
  // paints from it and the network refresh swaps in behind it. Cold LLM
  // latency (first open / cache expiry) never blocks the shell again.
  const HOME_SNAPSHOT_KEY = 'tsf-home-snapshot'
  const readSnapshot = (): { data: AiHome | null; featured: FeaturedResponse | null } => {
    try {
      const raw = localStorage.getItem(HOME_SNAPSHOT_KEY)
      if (!raw) return { data: null, featured: null }
      const j = JSON.parse(raw)
      return { data: j.data ?? null, featured: j.featured ?? null }
    } catch { return { data: null, featured: null } }
  }
  const [snap] = useState(readSnapshot)
  const [data, setData] = useState<AiHome | null>(snap.data)
  const [featured, setFeatured] = useState<FeaturedResponse | null>(snap.featured)
  const [recent, setRecent] = useState<HistoryTrack[]>([])
  const [loading, setLoading] = useState(!snap.data)
  const [aiOpen, setAiOpen] = useState(false)
  const playQueue = usePlayer((s) => s.playQueue)
  const likedTracks = useLibrary((s) => s.likedTracks)
  const push = useNav((s) => s.push)
  const prefs = usePreferences()

  // ---- F2 · ENDLESS FEED (reference v3.4.1 port) --------------------------
  // The Spotify-style scroll-forever tail of Home: alternating songs/albums
  // batches from rotating query ladders, deduped against everything the
  // shelves already show, honest exhaustion/retry states (never call again
  // after the server says done).
  interface FeedSongRow { videoId: string; title: string; artistName: string; duration: number; thumbnail: string }
  interface FeedAlbumRow { id: string; name: string; artist?: string; thumbnail: string; year?: number }
  type FeedBatchRow =
    | { kind: 'songs'; title: string; rows: FeedSongRow[] }
    | { kind: 'albums'; title: string; rows: FeedAlbumRow[] }
  const [feedBatches, setFeedBatches] = useState<FeedBatchRow[]>([])
  const [feedStatus, setFeedStatus] = useState<'idle' | 'loading' | 'ready' | 'retry' | 'done'>('idle')
  const feedSessionRef = useRef<string | null>(null)
  const feedBusyRef = useRef(false)
  // IntersectionObserver pitfall guard: if the sentinel fires while a fetch
  // is in flight, the event is DROPPED and (the element staying in view)
  // never re-fires — queue exactly one pending fetch and chain it in finally.
  const feedPendingRef = useRef(false)
  const feedSentinelRef = useRef<HTMLDivElement | null>(null)
  const shelvesRef = useRef<AiHome['shelves']>([])

  const fetchNextFeedBatch = useMemo(
    () =>
      async (mode: 'auto' | 'retry'): Promise<void> => {
        if (feedBusyRef.current) {
          feedPendingRef.current = true
          return
        }
        feedBusyRef.current = true
        setFeedStatus('loading')
        try {
          const seed =
            feedSessionRef.current || mode === 'retry'
              ? undefined
              : {
                  songIds: shelvesRef.current.flatMap((s) => (s.tracks ?? []).map((t) => t.videoId)).filter(Boolean),
                  albumIds: shelvesRef.current.flatMap((s) => (s.albums ?? []).map((a) => a.browseId)).filter(Boolean),
                }
          const res = await api<{
            batch: FeedBatchRow | { kind: 'retry' } | null
            sessionKey: string
            exhausted: boolean
          }>('/api/ai/feed', {
            method: 'POST',
            body: JSON.stringify({
              sessionKey: feedSessionRef.current ?? undefined,
              seed,
            }),
          })
          feedSessionRef.current = res.sessionKey
          if (res.exhausted || res.batch === null) {
            setFeedStatus('done')
          } else if (res.batch.kind === 'retry') {
            setFeedStatus('retry')
          } else {
            setFeedBatches((prev) => [...prev, res.batch as FeedBatchRow])
            setFeedStatus('ready')
          }
        } catch {
          setFeedStatus('retry')
        } finally {
          feedBusyRef.current = false
          if (feedPendingRef.current) {
            feedPendingRef.current = false
            void fetchNextFeedBatch('auto')
          }
        }
      },
    [],
  )

  // Arm the feed once the home payload (shelves) is on screen — priming
  // against the REAL visible ids so the tail never repeats them.
  useEffect(() => {
    if (!data?.shelves?.length || feedStatus !== 'idle') return
    shelvesRef.current = data.shelves
    void fetchNextFeedBatch('auto')
  }, [data?.shelves, feedStatus, fetchNextFeedBatch])

  // Preference change → the tail restarts cleanly. GUARD: prefs hydrate
  // async (loaded flips after mount) — without a first-settled sentinel the
  // reset fires AFTER the feed armed and wipes every appended batch.
  const prefsSigRef = useRef<string | null>(null)
  useEffect(() => {
    if (!prefs.loaded) return
    const sig = `${prefs.complete}|${prefs.artists.length}|${prefs.genres.length}`
    if (prefsSigRef.current === null) {
      prefsSigRef.current = sig
      return
    }
    if (prefsSigRef.current === sig) return
    prefsSigRef.current = sig
    feedSessionRef.current = null
    setFeedBatches([])
    setFeedStatus('idle')
  }, [prefs.loaded, prefs.complete, prefs.artists.length, prefs.genres.length])

  // Sentinel — deterministic scroll check (throttled): when the tail marker
  // comes within 600px of the container's bottom edge, fetch the next batch.
  // The listener attaches to the APP-LEVEL scroll container (always exists)
  // and reads the sentinel LAZILY at scroll time — the home refresh flips
  // `loading` true and unmounts the feed block; an effect tied to the
  // sentinel's mounting cleaned itself up and never re-armed (the silent
  // feed-death bug this replaces).
  useEffect(() => {
    if (feedStatus === 'done' || feedStatus === 'idle') return
    const container = document.querySelector('main .overflow-y-auto') as HTMLElement | null
    if (!container) return
    let last = 0
    const onScroll = () => {
      const now = Date.now()
      if (now - last < 700) return
      last = now
      const el = feedSentinelRef.current
      if (!el) return
      const cr = container.getBoundingClientRect()
      const er = el.getBoundingClientRect()
      if (er.top < cr.bottom + 600) void fetchNextFeedBatch('auto')
    }
    onScroll() // already-in-view case (short pages)
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [feedStatus, fetchNextFeedBatch])

  useEffect(() => {
    if (!prefs.loaded) void prefs.load()
  }, [prefs])

  // Refresh home whenever prefs change
  useEffect(() => {
    if (!prefs.loaded) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const [homeRes, featRes] = await Promise.all([
          api<AiHome>('/api/ai/home'),
          api<FeaturedResponse>('/api/ai/featured'),
        ])
        if (!cancelled) {
          setData(homeRes)
          setFeatured(featRes)
          try { localStorage.setItem(HOME_SNAPSHOT_KEY, JSON.stringify({ data: homeRes, featured: featRes, savedAt: Date.now() })) } catch { /* quota — non-fatal */ }
        }
      } catch {
        // keep the snapshot on failures — a stale home beats an empty one
        if (!cancelled) setLoading(false)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [prefs.loaded, prefs.complete, prefs.artists.length, prefs.genres.length])

  // History
  useEffect(() => {
    let cancelled = false
    void api<{ tracks: HistoryTrack[] }>('/api/library/history?limit=8')
      .then((r) => !cancelled && setRecent(r.tracks || []))
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // MINDBEAT: stamp the shelves' tracks so plays attribute to the right rec
  // surface AND the shelf that served them (markQueueSource … shelfId →
  // payload.shelfId on TRACK_START/TRACK_END = the shelf bandit's starts).
  // Re-stamped on every data arrival — stamps are TTL/cap-evicted client state.
  useEffect(() => {
    const shelves = data?.shelves
    const mixes = data?.mixes
    if (!shelves?.length && !mixes?.length) return
    try {
      for (const shelf of shelves ?? []) {
        if (!shelf.id || !shelf.tracks?.length) continue
        const surface = shelfSurfaceForId(shelf.id)
        if (surface) markQueueSource(shelf.tracks as PlayerTrack[], surface, undefined, shelf.id)
      }
      for (const mix of mixes ?? []) {
        if (!mix.tracks?.length) continue
        markQueueSource(mix.tracks as PlayerTrack[], 'daily_mix', undefined, mixShelfId(mix.id))
      }
    } catch { /* instrumentation only */ }
  }, [data])

  // MINDBEAT shelf bandit: SHELF_EXPOSURE once per shelf per Home open — the
  // attention denominator the bandit scores starts/saves against. ONE batched
  // enqueue per open (ref-guarded; the snapshot→network data swap must not
  // double-fire), never per scroll frame.
  const shelfExposedRef = useRef(false)
  useEffect(() => {
    if (shelfExposedRef.current) return
    const shelves = data?.shelves
    if (!shelves?.length) return
    shelfExposedRef.current = true
    try {
      shelves.forEach((shelf, position) => {
        if (!shelf.id) return
        shelfExposure(shelf.id, position, shelf.tracks?.length ?? 0)
      })
      ;(data?.mixes || []).forEach((mix, position) => {
        shelfExposure(mixShelfId(mix.id), position, mix.tracks?.length ?? 0)
      })
    } catch { /* telemetry only */ }
  }, [data])

  // Fallback quick picks from user's first favorite artist
  const [fallbackPicks, setFallbackPicks] = useState<HistoryTrack[]>([])
  useEffect(() => {
    if (recent.length) return
    if (!prefs.loaded || !prefs.artists.length) return
    let cancelled = false
    const a = prefs.artists[0]
    void api<{ topTracks?: HistoryTrack[]; tracks?: HistoryTrack[] }>(
      `/api/ytm/artist?id=${encodeURIComponent(a.id)}`
    )
      .then((r) => {
        if (cancelled) return
        const picks = (r.topTracks || r.tracks || []).slice(0, 8)
        setFallbackPicks(picks)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [recent.length, prefs.loaded, prefs.artists.length])

  const shelves = data?.shelves || []
  const mixes = data?.mixes || []

  const quickPicks = (
    recent.length
      ? recent
      : fallbackPicks.length
        ? fallbackPicks
        : (shelves.flatMap((s) => s.tracks || []).slice(0, 8) as HistoryTrack[])
  ).slice(0, 8)

  const greeting = data?.greeting || 'Good evening'
  const name = data?.name || prefs.name
  const heading = name ? `${greeting}, ${name}` : greeting

  // Shelf-bandit transparency: the champion shelf's subtitle gains a subtle
  // '· rising' suffix — render-time only, never persisted into the snapshot.
  const bandit = data?.bandit
  const championId = bandit?.mode === 'live' ? bandit.champion : undefined

  // Spotify 2023+ home anatomy (BAR-B §2.2): filter chips Music / Podcasts /
  // Audiobooks. TSF is music-only — non-music tabs get an honest empty state.
  const [homeFilter, setHomeFilter] = useState<'music' | 'podcasts' | 'audiobooks'>('music')

  const cards = featured?.cards || []
  const moods = featured?.moods || []

  return (
    <div className="pb-8">
      {/* Spotify 2023+ filter chips (BAR-B): active = white pill / black text,
          inactive = #2a2a2a pill / white text, horizontal scroll row */}
      <div className="px-4 lg:px-6 pt-3 pb-1 flex gap-2 overflow-x-auto no-scrollbar" role="tablist" aria-label="Home filter">
        {([
          ['music', 'Music'],
          ['podcasts', 'Podcasts'],
          ['audiobooks', 'Audiobooks'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={homeFilter === key}
            onClick={() => setHomeFilter(key)}
            className={`h-8 px-4 rounded-full text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors ${
              homeFilter === key ? 'bg-white text-black' : 'bg-[#2a2a2a] text-white hover:bg-[#3a3a3a]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {homeFilter !== 'music' ? (
        <div className="flex flex-col items-center justify-center py-24 px-8 text-center" role="tabpanel">
          <div className="w-16 h-16 rounded-full bg-white/[0.06] flex items-center justify-center mb-4">
            {homeFilter === 'podcasts' ? <Mic2 size={26} className="text-white/40" /> : <BookOpenText size={26} className="text-white/40" />}
          </div>
          <p className="text-white font-bold mb-1">No {homeFilter === 'podcasts' ? 'podcasts' : 'audiobooks'} yet</p>
          <p className="text-sm text-[#a7a7a7] max-w-[280px]">TSF is a music-only station — switch back to Music for the full drop.</p>
        </div>
      ) : (
      <>
      {/* quick picks grid */}
      {quickPicks.length > 0 && (
        <section className="px-4 lg:px-6 pt-2 pb-6 tsf-rise">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-[26px] lg:text-[30px] font-extrabold text-white tracking-tight tsf-balance">{heading}</h1>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setAiOpen(true)}
                className="flex items-center gap-2 text-[#1ed760] hover:scale-105 active:scale-95 transition-transform text-xs font-bold"
                title="Create with AI"
              >
                <Wand2 size={16} /> <span className="max-lg:hidden">AI Playlist</span>
              </button>
              {prefs.complete && (
                <button
                  onClick={async () => {
                    if (confirm('Re-open onboarding? Your picks will be kept.')) {
                      await usePreferences.getState().reset()
                      window.location.reload()
                    }
                  }}
                  className="text-white/40 hover:text-white text-xs max-lg:hidden"
                >
                  Edit onboarding
                </button>
              )}
            </div>
          </div>
          {/* Spotify mobile: 2-col compact tiles; tablet+ wider grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-3 gap-2">
            {quickPicks.map((t, idx) => (
              <button
                key={t.videoId + '-' + idx}
                onClick={() => playQueue(quickPicks, idx, 'Quick picks')}
                className="group flex items-center gap-1 h-[56px] max-lg:h-[52px] rounded-md bg-white/[0.08] hover:bg-white/20 transition-colors overflow-hidden text-left"
              >
                <Artwork src={t.thumbnail} alt="" className="h-full w-11 object-cover" iconSize={16} />
                <span className="flex-1 min-w-0 text-[13px] lg:text-sm font-bold text-white line-clamp-1">{t.title}</span>
                <span className="card-play-btn mr-1 w-8 h-8 rounded-full bg-[#1ed760] text-black flex items-center justify-center shrink-0">
                  <Play size={13} fill="currentColor" />
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Featured AI Hubs row — Discover Weekly, Release Radar, Daylist, On Repeat */}
      {cards.length > 0 && (
        <section className="px-4 lg:px-6 pb-6 tsf-rise tsf-rise-1">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                <Sparkles size={20} className="text-[#1ed760]" />
                Made for {name || 'you'}
              </h2>
              <p className="text-[#a7a7a7] text-sm mt-0.5">
                AI-curated playlists that update on their own schedule
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-6">
            {cards.map((c) => (
              <FeaturedCard key={c.id} card={c} name={name} />
            ))}
            {/* AI Playlist Generator card */}
            <button
              onClick={() => setAiOpen(true)}
              className="group relative cursor-pointer rounded-lg bg-[#181818] hover:bg-[#282828] transition-colors p-3 text-left"
            >
              <div className="relative mb-3">
                <div className="w-full aspect-square rounded shadow-[0_8px_24px_rgba(0,0,0,0.5)] bg-gradient-to-br from-[#1ed760] via-[#0d73ec] to-[#503750] flex items-center justify-center">
                  <Wand2 size={40} className="text-black/70 group-hover:scale-110 transition-transform" />
                </div>
                <span className="card-play-btn absolute bottom-2 right-2 w-12 h-12 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105 hover:bg-[#3be477] active:scale-95 shadow-lg">
                  <Sparkles size={20} fill="currentColor" />
                </span>
              </div>
              <div className="text-base font-normal text-white truncate">AI Playlist</div>
              <div className="text-[13px] text-[#a7a7a7] truncate mt-0.5">Generate from prompt</div>
            </button>
          </div>
        </section>
      )}

      {/* Daily Mixes row */}
      {mixes.length > 0 && (
        <section className="px-4 lg:px-6 pb-6 tsf-rise tsf-rise-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-2xl font-bold text-white">Your Daily Mixes</h1>
              <p className="text-[#a7a7a7] text-sm mt-0.5">
                Personal mixes from your favorite artists. Refreshed every 12 hours.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-6">
            {mixes.map((m) => (
              <DailyMixCard key={m.id} mix={m} onPlay={() => playQueue(m.tracks, 0, m.title)} />
            ))}
          </div>
        </section>
      )}

      {/* Mood Hubs */}
      {moods.length > 0 && (
        <section className="px-4 lg:px-6 pb-6 tsf-rise tsf-rise-3">
          <h2 className="text-2xl font-bold text-white mb-1">Moods & Genres</h2>
          <p className="text-[#a7a7a7] text-sm mb-4">Pick a vibe and we&apos;ll spin up a playlist instantly</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 gap-2.5">
            {moods.map((m) => (
              <button
                key={m.key}
                onClick={() => push({ type: 'mood', mood: m.key, title: m.title, gradient: m.gradient, emoji: m.emoji })}
                className="relative h-[110px] rounded-lg overflow-hidden text-left p-4 transition-transform hover:scale-[1.02]"
                style={{ background: `linear-gradient(135deg, ${m.gradient[0]}, ${m.gradient[1]})` }}
              >
                <span className="text-2xl absolute top-3 right-3">{m.emoji}</span>
                <span className="text-lg font-bold text-white block">{m.title}</span>
                <span className="text-[11px] text-white/70 uppercase tracking-wide">{m.subtitle}</span>
                <div className="absolute -bottom-3 -right-3 w-[68px] h-[68px] rounded shadow-2xl rotate-[25deg]" style={{ background: m.gradient[1] }} />
              </button>
            ))}
          </div>
        </section>
      )}

      {/* liked shortcut */}
      {likedTracks.length > 0 && (
        <Shelf title="Your likes" subtitle="Songs you've saved">
          {likedTracks.slice(0, 10).map((t, i) => (
            <TrackChip key={t.videoId} track={t} index={i} list={likedTracks} />
          ))}
        </Shelf>
      )}

      {/* loading skeletons */}
      {loading && (
        <div className="px-4 lg:px-6 space-y-6">
          {[0, 1].map((i) => (
            <div key={i}>
              <div className="h-8 w-56 tsf-skeleton mb-4" />
              <div className="flex gap-4 overflow-hidden">
                {Array.from({ length: 6 }).map((_, j) => (
                  <div key={j} className="w-[180px] shrink-0">
                    <div className="aspect-square tsf-skeleton mb-3" />
                    <div className="h-4 w-3/4 tsf-skeleton" />
                    <div className="h-3 w-1/2 tsf-skeleton mt-2" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* personalized shelves from /api/ai/home (bandit order) */}
      {!loading && shelves.map((shelf) => {
        const isChampion = !!championId && !!shelf.id && shelf.id === championId
        // champion transparency: '· rising' appended in the existing muted
        // style (a subtitle-less shelf — e.g. genre rows — shows just 'rising')
        const subtitle = !isChampion
          ? shelf.subtitle
          : shelf.subtitle && !shelf.subtitle.includes('· rising')
            ? `${shelf.subtitle} · rising`
            : 'rising'
        return (
        <Shelf key={shelf.title} title={shelf.title} subtitle={subtitle}>
          {shelf.albums?.map((a) => (
            <AlbumCard
              key={a.browseId}
              id={a.browseId}
              name={a.name}
              artist={a.artistName}
              thumbnail={a.thumbnail}
              year={a.year}
              playTracks={async () => {
                const res = await api<{ tracks: PlayerTrack[]; title?: string }>(`/api/ytm/album?id=${encodeURIComponent(a.browseId)}`)
                if (res.tracks?.length) playQueue(res.tracks, 0, res.title || a.name)
              }}
            />
          ))}
          {shelf.tracks?.map((t, i) => (
            <TrackChip
              key={t.videoId + i}
              track={t as PlayerTrack}
              index={i}
              list={shelf.tracks as PlayerTrack[]}
              context={shelf.title}
              subline={shelf.id === 'on-the-rise' ? (t as PlayerTrack & { chain?: string }).chain : undefined}
            />
          ))}
          {shelf.artists?.map((ar) => (
            <ArtistCard
              key={ar.browseId}
              id={ar.browseId}
              name={ar.name}
              thumbnail={ar.thumbnail}
              subscribers={ar.subscribers}
            />
          ))}
        </Shelf>
        )
      })}

      {/* needs onboarding */}
      {!loading && data?.needsOnboarding && (
        <div className="px-6 py-12 text-center">
          <p className="text-white/60">
            Tell us your taste and we&apos;ll build a home just for you.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-5 py-2 rounded-full bg-[#1ed760] text-black font-semibold"
          >
            Get started
          </button>
        </div>
      )}

      {/* F2 · ENDLESS FEED — the scroll-forever tail (reference v3.4.1 port).
          Alternating real songs / tappable albums from rotating ladders,
          deduped against the shelves, honest retry + end states. */}
      {!loading && (feedBatches.length > 0 || feedStatus === 'loading' || feedStatus === 'retry') && (
        <div className="mt-2" data-feed-count={feedBatches.length} data-feed-status={feedStatus}>
          {feedBatches.map((batch, bi) =>
            batch.kind === 'songs' ? (
              <section key={`f-${bi}`} className="px-4 lg:px-6 py-4 tsf-rise">
                <h2 className="text-xl lg:text-2xl font-bold text-white tracking-tight">{batch.title}</h2>
                <p className="text-[13px] text-[#a7a7a7] mt-0.5 mb-2">Fresh finds for endless listening</p>
                <div className="max-h-[420px] overflow-y-auto hide-scrollbar pr-1">
                  {batch.rows.map((t, i) => (
                    <TrackRow
                      key={t.videoId + '-' + bi + '-' + i}
                      track={t as PlayerTrack}
                      index={i}
                      compact
                      showAlbum={false}
                      onPlay={() => {
                        const list = batch.rows as unknown as PlayerTrack[]
                        markQueueSource(list, 'endless_feed')
                        playQueue(list, i, batch.title)
                      }}
                    />
                  ))}
                </div>
              </section>
            ) : (
              <Shelf
                key={`f-${bi}`}
                title="More albums to explore"
                subtitle={batch.title !== 'More albums to explore' ? `Because you browse ${batch.title.toLowerCase()}` : 'Dig deeper — every card opens the full record'}
              >
                {batch.rows.map((a) => (
                  <AlbumCard
                    key={a.id}
                    id={a.id}
                    name={a.name}
                    artist={a.artist}
                    thumbnail={a.thumbnail}
                    year={a.year}
                  />
                ))}
              </Shelf>
            ),
          )}

          {/* tail states — honest, never a fake forever */}
          <div className="px-4 lg:px-6 py-6 flex flex-col items-center gap-2" ref={feedSentinelRef} data-render-s={feedStatus}>
            {feedStatus === 'loading' && (
              <div className="flex items-center gap-2 text-[13px] text-[#a7a7a7]">
                <Loader2 size={14} className="animate-spin" /> Digging up more music…
              </div>
            )}
            {feedStatus === 'retry' && (
              <button
                onClick={() => void fetchNextFeedBatch('retry')}
                className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] text-white/80 border border-white/15 hover:border-white/40 transition-colors"
              >
                <RotateCcw size={13} /> Couldn&apos;t load more — retry
              </button>
            )}
            {feedStatus === 'done' && (
              <div className="flex items-center gap-2 text-[13px] text-[#a7a7a7] border-t border-white/5 pt-4">
                <InfinityIcon size={14} className="text-[#1ed760]" aria-hidden />
                You&apos;ve reached the end — tomorrow the feed digs again
              </div>
            )}
          </div>
        </div>
      )}

      {/* footer */}
      <footer className="mt-10 px-4 lg:px-6 text-[11px] text-[#6a6a6a]">
        TSF Music · audio streams from YouTube via InnerTube · Lyrics by LRCLIB · Personalized with your onboarding preferences · Curated by TSF AI
      </footer>
      </>
      )}

      <AiPlaylistGenerator open={aiOpen} onOpenChange={setAiOpen} />
    </div>
  )
}

function FeaturedCard({ card, name }: { card: FeaturedCard; name?: string }) {
  const push = useNav((s) => s.push)
  const playQueue = usePlayer((s) => s.playQueue)
  const [tracks, setTracks] = useState<PlayerTrack[] | null>(null)

  // Lazy-load tracks when user hovers (first hover only)
  const loadTracks = async () => {
    if (tracks) return
    try {
      const r = await api<{ tracks: PlayerTrack[] }>(card.endpoint)
      setTracks(r.tracks || [])
    } catch { /* skip */ }
  }

  const open = () => {
    push({
      type: 'ai-generated',
      endpoint: card.endpoint,
      title: card.title,
      subtitle: card.subtitle,
      gradient: card.gradient,
      emoji: card.emoji,
    })
  }

  return (
    <div
      className="group relative cursor-pointer rounded-lg bg-[#181818] hover:bg-[#282828] transition-colors p-3"
      onClick={open}
      onMouseEnter={loadTracks}
    >
      <div className="relative mb-3">
        {card.cover ? (
          <Artwork
            src={card.cover}
            alt={card.title}
            className="w-full aspect-square object-cover shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
            rounded="rounded"
            iconSize={36}
          />
        ) : (
          // Branded gradient tile — hub cover hasn't been built yet (or hub is empty)
          <div
            className="w-full aspect-square rounded flex items-center justify-center shadow-[0_8px_24px_rgba(0,0,0,0.5)] overflow-hidden relative"
            style={{
              background: card.gradient
                ? `linear-gradient(135deg, ${card.gradient[0]}, ${card.gradient[1]})`
                : 'linear-gradient(135deg, #333, #181818)',
            }}
          >
            {/* soft radial highlight, Spotify-hub feel */}
            <div
              className="absolute inset-0 opacity-60"
              style={{
                background:
                  'radial-gradient(120% 80% at 20% 0%, rgba(255,255,255,0.22), transparent 55%)',
              }}
            />
            <span className="relative text-4xl drop-shadow-[0_4px_12px_rgba(0,0,0,0.45)] select-none">
              {card.emoji || '✦'}
            </span>
          </div>
        )}
        {tracks && tracks.length > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              playQueue(tracks, 0, card.title)
            }}
            className="card-play-btn absolute bottom-2 right-2 w-12 h-12 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105 hover:bg-[#3be477] active:scale-95 shadow-lg"
            aria-label={`Play ${card.title}`}
          >
            <Play size={20} fill="currentColor" className="translate-x-[1px]" />
          </button>
        )}
      </div>
      <div className="text-base font-normal text-white truncate">{card.title}</div>
      <div className="text-[13px] text-[#a7a7a7] truncate mt-0.5">{card.subtitle}</div>
      {name && (
        <div className="text-[10px] text-[#7a7a7a] uppercase tracking-wide mt-1">{name}</div>
      )}
    </div>
  )
}

function DailyMixCard({ mix, onPlay }: { mix: DailyMix; onPlay: () => void }) {
  return (
    <div
      className="group relative cursor-pointer rounded-lg bg-[#181818] hover:bg-[#282828] transition-colors p-3"
      onClick={onPlay}
    >
      <div className="relative mb-3">
        <Artwork
          src={mix.cover}
          alt={mix.title}
          className="w-full aspect-square object-cover shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
          rounded="rounded"
          iconSize={36}
        />
        <button
          onClick={(e) => { e.stopPropagation(); onPlay() }}
          className="card-play-btn absolute bottom-2 right-2 w-12 h-12 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105 hover:bg-[#3be477] active:scale-95 shadow-lg"
          aria-label={`Play ${mix.title}`}
        >
          <Play size={20} fill="currentColor" className="translate-x-[1px]" />
        </button>
      </div>
      <div className="text-base font-normal text-white truncate">{mix.title}</div>
      <div className="text-[13px] text-[#a7a7a7] truncate mt-0.5">{mix.subtitle}</div>
    </div>
  )
}

function TrackChip({
  track,
  index,
  list,
  context,
  subline,
}: {
  track: PlayerTrack
  index: number
  list: PlayerTrack[]
  context?: string
  /** overrides the artist line — used to surface discovery chains */
  subline?: string
}) {
  const playQueue = usePlayer((s) => s.playQueue)
  return (
    <div
      className="group relative w-[157px] lg:w-[180px] shrink-0 p-3 rounded-lg hover:bg-[#1f1f1f] transition-colors cursor-pointer snap-start"
      onClick={() => playQueue(list, index, context || 'Quick picks')}
    >
      <div className="relative mb-3">
        <Artwork
          src={track.thumbnail}
          alt={track.title}
          className="w-full aspect-square object-cover shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
          rounded="rounded"
          iconSize={32}
        />
        <button
          onClick={(e) => {
            e.stopPropagation()
            playQueue(list, index, context || 'Quick picks')
          }}
          className="card-play-btn absolute bottom-2 right-2 w-12 h-12 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105 hover:bg-[#3be477] active:scale-95"
          aria-label={`Play ${track.title}`}
        >
          <Play size={20} fill="currentColor" className="translate-x-[1px]" />
        </button>
      </div>
      <div className="text-base font-normal text-white truncate">{track.title}</div>
      <div className="text-[13px] text-[#a7a7a7] truncate mt-0.5">{subline || track.artistName}</div>
    </div>
  )
}
