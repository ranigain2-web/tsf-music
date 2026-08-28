'use client'

/**
 * TSF Music — Artist view
 * Spotify's artist layout: immersive hero, verified badge, top tracks
 * (expandable), discography shelf, related artists.
 */

import { useEffect, useState } from 'react'
import { Play, Shuffle, BadgeCheck, MoreHorizontal } from 'lucide-react'
import { usePlayer, type PlayerTrack } from '@/store/player'
import { api } from '@/store/nav'
import { TrackRow, Shelf, AlbumCard, ArtistCard } from '@/components/shared'
import type { YtmShelf } from '@/lib/ytm/parse'

export function ArtistView({ id }: { id: string }) {
  const [data, setData] = useState<{
    name: string
    thumbnail: string
    description: string
    subscribers: string
    shelves: YtmShelf[]
    topTracks: PlayerTrack[]
    offline: boolean
  } | null>(null)
  const [showAllTop, setShowAllTop] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const playQueue = usePlayer((s) => s.playQueue)
  const toggleShuffle = usePlayer((s) => s.toggleShuffle)
  const shuffle = usePlayer((s) => s.shuffle)
  const isPlaying = usePlayer((s) => s.isPlaying)
  const current = usePlayer((s) => s.queue[s.queueIndex])

  useEffect(() => {
    let cancelled = false
    setData(null)
    void api<{ name: string; thumbnail: string; description: string; subscribers: string; shelves: YtmShelf[]; topTracks: PlayerTrack[]; offline: boolean }>(`/api/ytm/artist?id=${encodeURIComponent(id)}`).then((r) => !cancelled && setData(r)).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id])

  if (!data) {
    return (
      <div className="pt-6 px-4 lg:px-6">
        <div className="h-[340px] rounded-lg bg-white/5 animate-pulse mb-6" />
        <div className="h-8 w-48 bg-white/5 rounded animate-pulse" />
      </div>
    )
  }

  const { name, thumbnail, description, subscribers, shelves, topTracks } = data
  const top = showAllTop ? topTracks : topTracks.slice(0, 5)
  const thisArtistPlaying = !!current && topTracks.some((t) => t.videoId === current.videoId) && isPlaying

  return (
    <div>
      {/* hero */}
      <header className="relative h-[340px] lg:h-[400px] flex items-end px-4 lg:px-6 pb-6 overflow-hidden">
        {thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbnail} alt={name} className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-b from-[#503750] to-[#1f1f1f]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-black/10" />
        <div className="relative">
          <div className="flex items-center gap-2 mb-3">
            <BadgeCheck size={22} className="text-[#3d91f4]" fill="currentColor" color="#121212" />
            <span className="text-[13px] font-medium text-white/95">Official Artist Channel</span>
          </div>
          <h1 className="text-5xl lg:text-8xl font-extrabold text-white tracking-tight leading-none mb-4 line-clamp-2">{name}</h1>
          <p className="text-sm text-white/90">{subscribers && subscribers !== '—' ? `${subscribers} monthly listeners` : 'Artist'}</p>
        </div>
      </header>

      {/* action bar */}
      <div className="sticky top-0 z-10 bg-[#121212]/95 backdrop-blur px-4 lg:px-6 py-4 flex items-center gap-6">
        <button
          onClick={() => topTracks.length && playQueue(topTracks, 0, name)}
          className="w-14 h-14 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-105 hover:bg-[#3be477] active:scale-95 transition-transform shadow-xl"
          aria-label={`Play ${name}`}
        >
          <Play size={24} fill="currentColor" className="translate-x-[1px]" />
        </button>
        <button
          onClick={() => {
            if (!shuffle) toggleShuffle()
            if (topTracks.length) playQueue(topTracks, Math.floor(Math.random() * topTracks.length), name)
          }}
          className={`transition-colors ${shuffle ? 'text-[#1ed760]' : 'text-[#b3b3b3] hover:text-white'}`}
          aria-label="Shuffle"
        >
          <Shuffle size={28} fill={shuffle ? 'currentColor' : 'none'} />
        </button>
        <button className="text-[#b3b3b3] hover:text-white transition-colors" aria-label="More">
          <MoreHorizontal size={28} />
        </button>
      </div>

      <div className="px-4 lg:px-6">
        {/* Popular */}
        {topTracks.length > 0 && (
          <section className="mb-8">
            <h2 className="text-xl lg:text-2xl font-bold text-white mb-3">Popular</h2>
            {top.map((t, i) => (
              <TrackRow key={t.videoId + i} track={t} index={i} showAlbum={false} onPlay={() => playQueue(topTracks, i, name)} />
            ))}
            {topTracks.length > 5 && (
              <button onClick={() => setShowAllTop(!showAllTop)} className="mt-2 ml-4 text-[13px] font-bold text-[#a7a7a7] hover:text-white uppercase tracking-wide">
                {showAllTop ? 'Show less' : 'See more'}
              </button>
            )}
          </section>
        )}

        {/* About */}
        {description && (
          <section className="mb-8">
            <h2 className="text-xl lg:text-2xl font-bold text-white mb-3">About</h2>
            <div
              className={`relative bg-[#181818] rounded-lg p-6 max-w-3xl cursor-pointer ${expanded ? '' : 'line-clamp-3'}`}
              onClick={() => setExpanded(!expanded)}
            >
              <p className={`text-sm text-white/90 leading-relaxed ${expanded ? '' : 'line-clamp-3'}`}>{description}</p>
              {!expanded && (
                <button className="text-[13px] font-bold text-white mt-2">Read more</button>
              )}
            </div>
          </section>
        )}
      </div>

      {/* Discography + related shelves */}
      {shelves
        .filter((s) => s.albums?.length)
        .map((s) => (
          <Shelf key={s.title} title={s.title}>
            {s.albums!.map((a) => (
              <AlbumCard
                key={a.browseId}
                id={a.browseId}
                name={a.name}
                artist={a.artistName}
                thumbnail={a.thumbnail}
                year={a.year}
                playTracks={async () => {
                  const res = await api<{ tracks: PlayerTrack[] }>(`/api/ytm/album?id=${encodeURIComponent(a.browseId)}`)
                  if (res.tracks?.length) playQueue(res.tracks, 0, a.name)
                }}
              />
            ))}
          </Shelf>
        ))}

      {shelves
        .filter((s) => s.artists?.length)
        .map((s) => (
          <Shelf key={s.title} title={s.title}>
            {s.artists!.map((a) => (
              <ArtistCard key={a.browseId} id={a.browseId} name={a.name} thumbnail={a.thumbnail} subscribers={a.subscribers} />
            ))}
          </Shelf>
        ))}

      {shelves
        .filter((s) => s.tracks?.length && s.title !== 'Top songs')
        .map((s) => (
          <Shelf key={s.title} title={s.title}>
            {s.tracks!.map((t, i) => (
              <div
                key={t.videoId + i}
                className="group relative w-[157px] lg:w-[180px] shrink-0 p-3 rounded-lg hover:bg-[#1f1f1f] transition-colors cursor-pointer snap-start"
                onClick={() => playQueue(s.tracks as PlayerTrack[], i, `${name} — ${s.title}`)}
              >
                <div className="relative mb-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={t.thumbnail} alt={t.title} className="w-full aspect-square object-cover rounded" loading="lazy" />
                </div>
                <div className="text-[15px] font-semibold text-white truncate">{t.title}</div>
                <div className="text-[13px] text-[#a7a7a7] truncate mt-0.5">{t.artistName}</div>
              </div>
            ))}
          </Shelf>
        ))}

      <div className="h-8" />
      {thisArtistPlaying && null}
    </div>
  )
}
