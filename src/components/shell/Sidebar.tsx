'use client'

/**
 * TSF Music — Sidebar
 * Two stacked cards like Spotify: nav (Home/Search) + Your Library
 * with playlists list and create button.
 */

import { useEffect, useState } from 'react'
import { Home, Search, Library, Plus, Heart, Clock3, Wand2 } from 'lucide-react'
import { useNav, type View } from '@/store/nav'
import { useLibrary } from '@/store/library'
import { usePlayer } from '@/store/player'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AiPlaylistGenerator } from '@/components/ai/AiPlaylistGenerator'
import { Artwork } from '@/components/Artwork'

export function Sidebar() {
  const view = useNav((s) => s.view)
  const push = useNav((s) => s.push)
  const playlists = useLibrary((s) => s.playlists)
  const createPlaylist = useLibrary((s) => s.createPlaylist)
  const current = usePlayer((s) => s.queue[s.queueIndex])
  const [createOpen, setCreateOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [createMenuOpen, setCreateMenuOpen] = useState(false)

  const activeType = view.type
  const isActive = (t: View['type']) =>
    (t === 'library' && (activeType === 'library' || activeType === 'playlist' || activeType === 'liked')) || t === activeType

  return (
    <>
      <nav className="rounded-lg bg-[#121212] p-2 pb-3">
        <button
          onClick={() => push({ type: 'home' })}
          className={`w-full flex items-center gap-4 px-3 py-2.5 rounded-md text-[15px] font-bold transition-colors ${
            activeType === 'home' ? 'text-white' : 'text-[#b3b3b3] hover:text-white'
          }`}
        >
          <Home size={24} strokeWidth={isActive('home') ? 2.5 : 2} />
          Home
        </button>
        <button
          onClick={() => push({ type: 'search' })}
          className={`w-full flex items-center gap-4 px-3 py-2.5 rounded-md text-[15px] font-bold transition-colors ${
            activeType === 'search' ? 'text-white' : 'text-[#b3b3b3] hover:text-white'
          }`}
        >
          <Search size={24} strokeWidth={isActive('search') ? 2.5 : 2} />
          Search
        </button>
      </nav>

      <div className="flex-1 min-h-0 rounded-lg bg-[#121212] flex flex-col">
        <div className="p-2 pb-0">
          <button
            onClick={() => push({ type: 'library' })}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-[15px] font-bold transition-colors ${
              activeType === 'library' ? 'text-white' : 'text-[#b3b3b3] hover:text-white'
            }`}
          >
            <Library size={24} />
            Your Library
          </button>

          <div className="flex items-center justify-between px-3 py-1 relative">
            <button
              onClick={() => setCreateMenuOpen((s) => !s)}
              className="text-[#b3b3b3] hover:text-white p-1.5 rounded-full transition-colors"
              title="Create playlist"
              aria-label="Create playlist"
            >
              <Plus size={20} />
            </button>
            {createMenuOpen && (
              <div className="absolute left-3 top-full mt-1 z-10 w-56 rounded-md bg-[#282828] border border-white/10 shadow-xl p-1">
                <button
                  onClick={() => {
                    setCreateMenuOpen(false)
                    setCreateOpen(true)
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm text-white hover:bg-white/10 rounded text-left"
                >
                  <Plus size={18} />
                  Create a playlist
                </button>
                <button
                  onClick={() => {
                    setCreateMenuOpen(false)
                    setAiOpen(true)
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm text-white hover:bg-white/10 rounded text-left"
                >
                  <Wand2 size={18} className="text-[#1ed760]" />
                  Create with AI
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-0.5">
          {/* Liked Songs pinned entry */}
          <SidebarItem
            onClick={() => push({ type: 'liked' })}
            active={activeType === 'liked'}
            icon={
              <div className="w-12 h-12 rounded flex items-center justify-center bg-gradient-to-br from-[#4300b0] via-[#7f5af0] to-[#b8a9ff] shrink-0">
                <Heart size={20} className="text-white" fill="currentColor" />
              </div>
            }
            title="Liked Songs"
            subtitle="Playlist"
          />

          {/* section divider — separates pinned from user playlists */}
          {playlists.length > 0 && (
            <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#a7a7a7] select-none">Playlists</span>
              <span className="text-[11px] text-[#6a6a6a] tabular-nums">{playlists.length}</span>
              <span className="flex-1 h-px bg-white/[0.06]" />
            </div>
          )}

          {playlists.map((pl) => {
            const cover = pl.coverTracks?.[0]?.thumbnail
            return (
              <SidebarItem
                key={pl.id}
                onClick={() => push({ type: 'playlist', id: pl.id })}
                active={view.type === 'playlist' && view.id === pl.id}
                icon={
                  <Artwork src={cover} alt="" className="w-12 h-12" rounded="rounded" iconSize={18} />
                }
                title={pl.name}
                subtitle={pl.source === 'ai' ? 'AI Playlist' : 'Playlist'}
                playing={current && pl.coverTracks?.some((t) => t.videoId === current.videoId)}
              />
            )
          })}

          {playlists.length === 0 && (
            <div className="px-3 py-6 text-[#b3b3b3] text-sm">
              <p className="font-bold text-white mb-2">Create your first playlist</p>
              <p className="text-[13px] mb-3">It&apos;s easy, we&apos;ll help you.</p>
              <Button
                size="sm"
                className="rounded-full bg-white text-black hover:scale-105 font-bold"
                onClick={() => setCreateOpen(true)}
              >
                Create playlist
              </Button>
              <button
                onClick={() => setAiOpen(true)}
                className="mt-3 w-full text-left text-[13px] text-[#1ed760] hover:underline"
              >
                Or generate one with AI →
              </button>
            </div>
          )}
        </div>
      </div>

      {/* create playlist dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="bg-[#282828] border-none text-white max-w-[360px]">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold text-white">Create playlist</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Playlist name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim()) {
                void createPlaylist(newName.trim())
                setNewName('')
                setCreateOpen(false)
              }
            }}
            className="bg-[#3e3e3e] border-none text-white h-12 rounded-md focus-visible:ring-white"
          />
          <DialogFooter>
            <Button
              className="rounded-full bg-white text-black hover:scale-105 font-bold px-8"
              disabled={!newName.trim()}
              onClick={() => {
                void createPlaylist(newName.trim())
                setNewName('')
                setCreateOpen(false)
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI playlist generator */}
      <AiPlaylistGenerator open={aiOpen} onOpenChange={setAiOpen} />
    </>
  )
}

function SidebarItem({
  icon,
  title,
  subtitle,
  active,
  playing,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  active?: boolean
  playing?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 p-2 rounded-md text-left transition-colors my-0.5 ${
        active ? 'bg-[#232323]' : 'hover:bg-[#1a1a1a]'
      }`}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-medium truncate ${playing ? 'text-[#1ed760]' : 'text-white'}`}>{title}</div>
        <div className="text-[13px] text-[#b3b3b3] truncate">{subtitle}</div>
      </div>
      {playing && (
        <div className="flex items-end gap-[2px] h-4 shrink-0 mr-1">
          <span className="eq-bar" />
          <span className="eq-bar" />
          <span className="eq-bar" />
          <span className="eq-bar" />
        </div>
      )}
    </button>
  )
}

export { Clock3 }
