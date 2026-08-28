'use client'

/**
 * TSF Music — Add-to-playlist dialog
 *
 * Lists playlists with song counts; "New playlist" creates a date-named
 * playlist then adds the track. Lives in player/ (not shared/) so the
 * TrackContextMenu can import it without a circular module graph.
 */

import { useState } from 'react'
import { Plus } from 'lucide-react'
import type { PlayerTrack } from '@/store/player'
import { useLibrary } from '@/store/library'
import { Artwork } from '@/components/Artwork'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function AddToPlaylistDialog({
  track,
  open,
  onOpenChange,
}: {
  track: PlayerTrack
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const playlists = useLibrary((s) => s.playlists)
  const addToPlaylist = useLibrary((s) => s.addToPlaylist)
  const createPlaylist = useLibrary((s) => s.createPlaylist)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="bg-[#282828] border-none text-white max-w-[380px]">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold">Add to playlist</DialogTitle>
        </DialogHeader>
        <div className="max-h-72 overflow-y-auto -mx-2 px-2 space-y-1">
          <button
            onClick={async () => {
              const pl = await createPlaylist(`Playlist ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)
              if (pl) await addToPlaylist(pl.id, track)
              onOpenChange(false)
            }}
            className="w-full flex items-center gap-4 p-2 rounded-md hover:bg-white/10 transition-colors text-left"
          >
            <div className="w-12 h-12 rounded bg-white/10 flex items-center justify-center shrink-0">
              <Plus size={20} />
            </div>
            <span className="font-bold text-sm">New playlist</span>
          </button>

          {playlists.map((pl) => (
            <button
              key={pl.id}
              onClick={async () => {
                await addToPlaylist(pl.id, track)
                onOpenChange(false)
              }}
              className="w-full flex items-center gap-4 p-2 rounded-md hover:bg-white/10 transition-colors text-left"
            >
              <Artwork src={pl.coverTracks?.[0]?.thumbnail} alt="" className="w-12 h-12" iconSize={18} />
              <div className="min-w-0">
                <div className="font-bold text-sm truncate">{pl.name}</div>
                <div className="text-[13px] text-[#a7a7a7]">{pl.coverTracks?.length ?? 0} songs</div>
              </div>
            </button>
          ))}

          {creating && (
            <div className="flex gap-2 p-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Playlist name"
                className="flex-1 bg-[#3e3e3e] rounded-md px-3 h-10 text-sm outline-none"
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && name.trim()) {
                    const pl = await createPlaylist(name.trim())
                    if (pl) await addToPlaylist(pl.id, track)
                    onOpenChange(false)
                  }
                }}
              />
              <Button size="sm" className="rounded-full bg-white text-black" onClick={async () => {
                const pl = await createPlaylist(name.trim())
                if (pl) await addToPlaylist(pl.id, track)
                onOpenChange(false)
              }}>
                Create
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
