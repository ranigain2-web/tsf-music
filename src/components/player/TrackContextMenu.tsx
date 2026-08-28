'use client'

/**
 * TSF Music — Track context menu (right-click on any track row)
 *
 * Spotify-signature interaction. Wraps any child (typically a TrackRow) with
 * a Radix context menu offering: Play, Play next, Add to queue, Like,
 * Add to playlist, Go to artist/album, Start radio, Download, Copy link.
 *
 * "Start radio" is new: it hits /api/ytm/radio for the seed track and
 * replaces the queue with the generated radio (context title = song name).
 */

import { useState } from 'react'
import {
  Play,
  ListPlus,
  ListStart,
  Heart,
  Plus,
  User,
  Disc3,
  Radio,
  Download,
  Link2,
  Loader2,
  Check,
} from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { usePlayer, type PlayerTrack } from '@/store/player'
import { useLibrary } from '@/store/library'
import { useNav } from '@/store/nav'
import { AddToPlaylistDialog } from '@/components/player/AddToPlaylistDialog'

export function TrackContextMenu({
  track,
  children,
}: {
  track: PlayerTrack
  children: React.ReactNode
}) {
  const playNext = usePlayer((s) => s.playNext)
  const addToQueue = usePlayer((s) => s.addToQueue)
  const playQueue = usePlayer((s) => s.playQueue)
  const likes = useLibrary((s) => s.likes)
  const toggleLike = useLibrary((s) => s.toggleLike)
  const push = useNav((s) => s.push)

  const [addOpen, setAddOpen] = useState(false)
  const [downloadState, setDownloadState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [radioLoading, setRadioLoading] = useState(false)
  const liked = likes.has(track.videoId)

  const onDownload = async () => {
    if (downloadState === 'loading') return
    setDownloadState('loading')
    try {
      const r = await fetch(
        `/api/download?id=${encodeURIComponent(track.videoId)}&title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artistName || '')}&dur=${track.duration || 0}`,
      )
      if (!r.ok) throw new Error('download failed')
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${track.title} - ${track.artistName}.m4a`.replace(/[/\\:*?"<>|]/g, '_')
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setDownloadState('done')
      setTimeout(() => setDownloadState('idle'), 2000)
    } catch {
      setDownloadState('idle')
    }
  }

  const startRadio = async () => {
    if (radioLoading) return
    setRadioLoading(true)
    try {
      const r = await fetch(`/api/ytm/radio?id=${encodeURIComponent(track.videoId)}`)
      if (!r.ok) throw new Error('radio failed')
      const j = (await r.json()) as { tracks?: PlayerTrack[] }
      const tracks = (j.tracks || []).filter((t) => t?.videoId)
      // always lead with the seed track itself (radio API already does, but be safe)
      if (tracks[0]?.videoId !== track.videoId) tracks.unshift(track)
      if (tracks.length > 0) playQueue(tracks, 0, `${track.title} · Radio`)
    } catch {
      // fall back to just playing the track
      playQueue([track], 0, track.artistName || 'Radio')
    } finally {
      setRadioLoading(false)
    }
  }

  const copyLink = async () => {
    const url = `https://music.youtube.com/watch?v=${track.videoId}`
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      /* clipboard unavailable — non-fatal */
    }
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-56 bg-[#282828] border-white/10 text-white">
          <ContextMenuItem
            onClick={() => playQueue([track], 0, track.albumName || track.artistName)}
            className="gap-2.5 font-semibold text-[#1ed760] focus:text-[#1ed760] focus:bg-white/10"
          >
            <Play size={14} fill="currentColor" /> Play now
          </ContextMenuItem>
          <ContextMenuItem onClick={() => playNext(track)} className="gap-2.5 focus:bg-white/10">
            <ListStart size={14} /> Play next
          </ContextMenuItem>
          <ContextMenuItem onClick={() => addToQueue(track)} className="gap-2.5 focus:bg-white/10">
            <ListPlus size={14} /> Add to queue
          </ContextMenuItem>

          <ContextMenuSeparator className="bg-white/10" />

          <ContextMenuItem
            onClick={() => toggleLike(track)}
            className="gap-2.5 focus:bg-white/10"
          >
            <Heart size={14} fill={liked ? '#1ed760' : 'none'} color={liked ? '#1ed760' : undefined} />
            {liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setAddOpen(true)} className="gap-2.5 focus:bg-white/10">
            <Plus size={14} /> Add to playlist…
          </ContextMenuItem>

          <ContextMenuSeparator className="bg-white/10" />

          {track.artistId && (
            <ContextMenuItem
              onClick={() => push({ type: 'artist', id: track.artistId!, title: track.artistName })}
              className="gap-2.5 focus:bg-white/10"
            >
              <User size={14} /> Go to artist
            </ContextMenuItem>
          )}
          {track.albumId && (
            <ContextMenuItem
              onClick={() => push({ type: 'album', id: track.albumId!, title: track.albumName })}
              className="gap-2.5 focus:bg-white/10"
            >
              <Disc3 size={14} /> Go to album
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onClick={startRadio}
            disabled={radioLoading}
            className="gap-2.5 focus:bg-white/10"
          >
            {radioLoading ? <Loader2 size={14} className="animate-spin" /> : <Radio size={14} />}
            Start radio
          </ContextMenuItem>

          <ContextMenuSeparator className="bg-white/10" />

          <ContextMenuItem
            onClick={onDownload}
            disabled={downloadState !== 'idle'}
            className="gap-2.5 focus:bg-white/10"
          >
            {downloadState === 'loading' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : downloadState === 'done' ? (
              <Check size={14} className="text-[#1ed760]" />
            ) : (
              <Download size={14} />
            )}
            Download file
          </ContextMenuItem>
          <ContextMenuItem onClick={copyLink} className="gap-2.5 focus:bg-white/10">
            <Link2 size={14} /> Copy song link
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AddToPlaylistDialog open={addOpen} onOpenChange={setAddOpen} track={track} />
    </>
  )
}
