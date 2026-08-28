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
  Share2,
  Loader2,
  Check,
  Ban,
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
import { toast } from 'sonner'
import { AddToPlaylistDialog } from '@/components/player/AddToPlaylistDialog'
// MINDBEAT: taste-feedback + download signals from the track menu
import { download, notForMe, surfaceForNavView } from '@/lib/mindbeat/client'
import { fetchMindbeatRadio } from '@/lib/radio-v2'

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
  const view = useNav((s) => s.view)

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
      // MINDBEAT: TRACK_DOWNLOAD is strong positive evidence (2.5×)
      try {
        download(track.videoId)
      } catch { /* instrumentation only */ }
      setTimeout(() => setDownloadState('idle'), 2000)
    } catch {
      setDownloadState('idle')
    }
  }

  const startRadio = async () => {
    if (radioLoading) return
    setRadioLoading(true)
    try {
      // RADIO V2: Mindbeat Decision Engine first (multi-seed + drift control
      // + 7-day dedup); the raw InnerTube radio stays as the fallback.
      const picks = await fetchMindbeatRadio(track, 25)
      if (picks?.length) {
        const tracks = picks[0]?.videoId === track.videoId ? picks : [track, ...picks]
        playQueue(tracks, 0, `${track.title} · Radio`)
        return
      }
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

  const trackUrl = () => `https://music.youtube.com/watch?v=${track.videoId}`

  // Web Share API (native share sheet on mobile) → clipboard fallback.
  // Spotify parity: share is a first-class row in the track menu.
  const shareTrack = async () => {
    const url = trackUrl()
    const shareData = {
      title: track.title,
      text: `${track.title} — ${track.artistName}`,
      url,
    }
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share(shareData)
        return
      }
      throw new Error('unsupported')
    } catch (err) {
      // user-cancelled share sheets abort with AbortError — stay silent
      if ((err as DOMException)?.name === 'AbortError') return
      try {
        await navigator.clipboard.writeText(url)
        toast.success('Link copied to clipboard')
      } catch {
        toast.error('Sharing is not available here')
      }
    }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(trackUrl())
      toast.success('Link copied to clipboard')
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
          <ContextMenuItem onClick={shareTrack} className="gap-2.5 focus:bg-white/10">
            <Share2 size={14} /> Share
          </ContextMenuItem>
          <ContextMenuItem onClick={copyLink} className="gap-2.5 focus:bg-white/10">
            <Link2 size={14} /> Copy song link
          </ContextMenuItem>

          <ContextMenuSeparator className="bg-white/10" />

          {/* MINDBEAT: explicit negative taste signal (−4.0 track evidence) —
              the Decision Engine backs this artist/track off hard. */}
          <ContextMenuItem
            onClick={() => {
              try {
                notForMe(track.videoId, surfaceForNavView(view))
                toast.success(
                  track.artistName
                    ? `Okay — we'll play less ${track.artistName}`
                    : 'Got it — we\'ll tune your recommendations'
                )
              } catch { /* instrumentation only */ }
            }}
            className="gap-2.5 focus:bg-white/10"
          >
            <Ban size={14} /> Not for me
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AddToPlaylistDialog open={addOpen} onOpenChange={setAddOpen} track={track} />
    </>
  )
}
