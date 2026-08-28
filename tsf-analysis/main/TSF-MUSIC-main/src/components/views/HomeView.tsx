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

import { useEffect, useState } from 'react'
import { Play, Sparkles, Wand2, Compass, Satellite, AlarmClock, Repeat2, type LucideIcon } from 'lucide-react'
import { usePlayer, type PlayerTrack } from '@/store/player'
import { api, useNav } from '@/store/nav'
import { useLibrary } from '@/store/library'
import { usePreferences } from '@/store/preferences'
import { Shelf, AlbumCard, ArtistCard } from '@/components/shared'
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
  shelves: YtmShelf[]
  mixes: DailyMix[]
  topArtists: { id: string; name: string; thumbnail?: string }[]
  greeting: string
  name?: string
  needsOnboarding?: boolean
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

export function HomeView() {
  const [data, setData] = useState<AiHome | null>(null)
  const [featured, setFeatured] = useState<FeaturedResponse | null>(null)
  const [recent, setRecent] = useState<HistoryTrack[]>([])
  const [loading, setLoading] = useState(true)
  const [aiOpen, setAiOpen] = useState(false)
  const playQueue = usePlayer((s) => s.playQueue)
  const likedTracks = useLibrary((s) => s.likedTracks)
  const push = useNav((s) => s.push)
  const prefs = usePreferences()

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
        }
      } catch {
        if (!cancelled) { setData(null); setFeatured(null) }
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

  const cards = featured?.cards || []
  const moods = featured?.moods || []

  return (
    <div className="pb-8">
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
                className="group flex items-center gap-2 h-[56px] max-lg:h-[52px] rounded-md bg-white/[0.08] hover:bg-white/20 transition-colors overflow-hidden text-left"
              >
                <Artwork src={t.thumbnail} alt="" className="h-full w-12 max-lg:w-11 object-cover" iconSize={16} />
                <span className="flex-1 min-w-0 text-[13px] lg:text-sm font-bold text-white line-clamp-1 pr-1">{t.title}</span>
                <span className="card-play-btn mr-2 w-9 h-9 max-lg:w-8 max-lg:h-8 rounded-full bg-[#1ed760] text-black flex items-center justify-center shrink-0">
                  <Play size={14} fill="currentColor" />
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
              <div className="text-[15px] font-semibold text-white truncate">AI Playlist</div>
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

      {/* personalized shelves from /api/ai/home */}
      {!loading && shelves.map((shelf) => (
        <Shelf key={shelf.title} title={shelf.title} subtitle={shelf.subtitle}>
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
      ))}

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

      {/* footer */}
      <footer className="mt-10 px-4 lg:px-6 text-[11px] text-[#6a6a6a]">
        TSF Music · audio streams from YouTube via InnerTube · Lyrics by LRCLIB · Personalized with your onboarding preferences · Curated by TSF AI
      </footer>

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
        <Artwork
          src={card.cover}
          alt={card.title}
          className="w-full aspect-square object-cover shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
          rounded="rounded"
          iconSize={36}
        />
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
      <div className="text-[15px] font-semibold text-white truncate">{card.title}</div>
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
      <div className="text-[15px] font-semibold text-white truncate">{mix.title}</div>
      <div className="text-[13px] text-[#a7a7a7] truncate mt-0.5">{mix.subtitle}</div>
    </div>
  )
}

function TrackChip({
  track,
  index,
  list,
  context,
}: {
  track: PlayerTrack
  index: number
  list: PlayerTrack[]
  context?: string
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
      <div className="text-[15px] font-semibold text-white truncate">{track.title}</div>
      <div className="text-[13px] text-[#a7a7a7] truncate mt-0.5">{track.artistName}</div>
    </div>
  )
}
