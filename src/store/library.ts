'use client'

/**
 * TSF Music — library store (likes, playlists)
 * Optimistic updates against /api/library.
 */

import { create } from 'zustand'
import type { PlayerTrack } from './player'

export interface Playlist {
  id: string
  name: string
  description?: string | null
  coverUrl?: string | null
  source: string
  createdAt: string
  updatedAt: string
  coverTracks?: PlayerTrack[]
  trackCount?: number
}

interface LibraryState {
  likes: Set<string>
  likedTracks: PlayerTrack[]
  playlists: Playlist[]
  loaded: boolean

  refresh: () => Promise<void>
  toggleLike: (track: PlayerTrack) => Promise<void>
  isLiked: (videoId: string) => boolean
  createPlaylist: (name: string) => Promise<Playlist | null>
  deletePlaylist: (id: string) => Promise<void>
  addToPlaylist: (playlistId: string, track: PlayerTrack) => Promise<void>
  removeFromPlaylist: (playlistId: string, videoId: string) => Promise<void>
  renamePlaylist: (id: string, name: string) => Promise<void>
}

export const useLibrary = create<LibraryState>((set, get) => ({
  likes: new Set(),
  likedTracks: [],
  playlists: [],
  loaded: false,

  refresh: async () => {
    try {
      const [likesRes, plsRes] = await Promise.all([
        fetch('/api/library/likes').then((r) => r.json()),
        fetch('/api/library/playlists').then((r) => r.json()),
      ])
      set({
        likes: new Set((likesRes.tracks || []).map((t: any) => t.id)),
        likedTracks: likesRes.tracks || [],
        playlists: plsRes.playlists || [],
        loaded: true,
      })
    } catch {
      set({ loaded: true })
    }
  },

  toggleLike: async (track) => {
    const { likes } = get()
    const wasLiked = likes.has(track.videoId)
    // optimistic
    const next = new Set(likes)
    if (wasLiked) next.delete(track.videoId)
    else next.add(track.videoId)
    set({ likes: next })

    try {
      await fetch('/api/library/likes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: track.videoId, track }),
      })
    } catch {
      // revert
      set({ likes: likes })
    }
  },

  isLiked: (videoId) => get().likes.has(videoId),

  createPlaylist: async (name) => {
    try {
      const res = await fetch('/api/library/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', name }),
      })
      const j = await res.json()
      await get().refresh()
      return j.playlist
    } catch {
      return null
    }
  },

  deletePlaylist: async (id) => {
    await fetch('/api/library/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', playlistId: id }),
    })
    await get().refresh()
  },

  addToPlaylist: async (playlistId, track) => {
    await fetch('/api/library/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'addTrack', playlistId, videoId: track.videoId, track }),
    })
    await get().refresh()
  },

  removeFromPlaylist: async (playlistId, videoId) => {
    await fetch('/api/library/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'removeTrack', playlistId, videoId }),
    })
  },

  renamePlaylist: async (id, name) => {
    await fetch('/api/library/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rename', playlistId: id, name }),
    })
    await get().refresh()
  },
}))
