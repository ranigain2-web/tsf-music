'use client'

/**
 * TSF Music — Player store (Zustand)
 * Single source of truth for playback. A separate <AudioEngine /> component
 * mounts the singleton <audio> element and reacts to store changes.
 */

import { create } from 'zustand'

export interface PlayerTrack {
  videoId: string
  title: string
  artistName: string
  artistId?: string
  albumName?: string
  albumId?: string
  duration: number
  thumbnail: string
}

export type RepeatMode = 'off' | 'all' | 'one'

interface PlayerState {
  queue: PlayerTrack[]
  queueIndex: number
  originalQueue: PlayerTrack[] // pre-shuffle order
  isPlaying: boolean
  isLoading: boolean
  position: number
  duration: number
  volume: number
  prevVolume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  contextTitle: string
  streamProvider: string
  streamBitrate: number // resolver-reported kbps (X-Stream-Bitrate)
  streamArt: string | null // hi-res catalog art (X-Stream-Art)
  error: string | null

  // UI overlays
  nowPlayingOpen: boolean
  queueOpen: boolean
  lyricsOpen: boolean
  sleepTimerMs: number | null // remaining ms
  sleepTimerStartedAt: number | null
  crossfadeMs: number // 0 = off
  smartShuffle: boolean // when on, shuffling sprinkles in AI recommendations
  smartShuffleLoading: boolean

  // internal (set by AudioEngine)
  setPosition: (p: number) => void
  setDuration: (d: number) => void
  setLoading: (l: boolean) => void
  setStreamProvider: (p: string) => void
  setStreamMeta: (m: { bitrate?: number; artUrl?: string }) => void
  setError: (e: string | null) => void
  setIsPlaying: (p: boolean) => void

  // public actions
  playQueue: (tracks: PlayerTrack[], startIndex?: number, contextTitle?: string) => void
  playTrackAt: (index: number) => void
  toggle: () => void
  next: () => void
  prev: () => void
  seek: (sec: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  addToQueue: (track: PlayerTrack) => void
  playNext: (track: PlayerTrack) => void
  removeFromQueue: (index: number) => void
  clearQueue: () => void
  current: () => PlayerTrack | null

  // UI actions
  openNowPlaying: () => void
  closeNowPlaying: () => void
  toggleQueue: () => void
  toggleLyrics: () => void
  startSleepTimer: (minutes: number) => void
  cancelSleepTimer: () => void
  tickSleepTimer: (deltaMs: number) => void
  setCrossfade: (ms: number) => void
  toggleSmartShuffle: () => void
  applySmartShuffle: (augmentedQueue: PlayerTrack[], insertedAt: number[]) => void
}

function shuffleWithFirst<T>(arr: T[], firstIndex: number): T[] {
  const first = arr[firstIndex]
  const rest = arr.filter((_, i) => i !== firstIndex)
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j], rest[i]]
  }
  return [first, ...rest]
}

export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [],
  queueIndex: -1,
  originalQueue: [],
  isPlaying: false,
  isLoading: false,
  position: 0,
  duration: 0,
  volume: 1,
  prevVolume: 1,
  muted: false,
  shuffle: false,
  repeat: 'off',
  contextTitle: '',
  streamProvider: '',
  streamBitrate: 0,
  streamArt: null,
  error: null,
  nowPlayingOpen: false,
  queueOpen: false,
  lyricsOpen: false,
  sleepTimerMs: null,
  sleepTimerStartedAt: null,
  crossfadeMs: 0,
  smartShuffle: false,
  smartShuffleLoading: false,

  setPosition: (p) => set({ position: p }),
  setDuration: (d) => set({ duration: d }),
  setLoading: (l) => set({ isLoading: l }),
  setStreamProvider: (p) => set({ streamProvider: p }),
  setStreamMeta: (m: { bitrate?: number; artUrl?: string }) =>
    set((s) => ({
      streamBitrate: m.bitrate ?? s.streamBitrate,
      streamArt: m.artUrl !== undefined ? m.artUrl : s.streamArt,
    })),
  setError: (e) => set({ error: e }),
  setIsPlaying: (p) => set({ isPlaying: p }),

  playQueue: (tracks, startIndex = 0, contextTitle = '') => {
    if (!tracks.length) return
    // filter out malformed tracks (no videoId)
    const valid = tracks.filter((t) => t && t.videoId)
    if (!valid.length) return
    const idx = Math.min(startIndex, valid.length - 1)
    const { shuffle } = get()
    const queue = shuffle ? shuffleWithFirst(valid, idx) : [...valid]
    set({
      queue,
      originalQueue: [...valid],
      queueIndex: shuffle ? 0 : idx,
      contextTitle,
      position: 0,
      duration: queue[shuffle ? 0 : idx]?.duration || 0,
      isPlaying: true,
      isLoading: true,
      error: null,
    })
    void recordHistory(queue[shuffle ? 0 : idx])
  },

  playTrackAt: (index) => {
    const { queue } = get()
    if (index < 0 || index >= queue.length) return
    set({ queueIndex: index, isPlaying: true, isLoading: true, position: 0, duration: queue[index].duration || 0, error: null })
    void recordHistory(queue[index])
  },

  toggle: () => set((s) => ({ isPlaying: !s.isPlaying })),

  next: () => {
    const { queue, queueIndex, repeat, shuffle } = get()
    if (!queue.length) return
    if (queueIndex < queue.length - 1) {
      const i = queueIndex + 1
      set({ queueIndex: i, isPlaying: true, isLoading: true, position: 0, duration: queue[i].duration || 0, error: null })
      void recordHistory(queue[i])
    } else if (repeat === 'all') {
      set({ queueIndex: 0, isPlaying: true, isLoading: true, position: 0, duration: queue[0].duration || 0, error: null })
      void recordHistory(queue[0])
    } else if (shuffle) {
      // reshuffle and start over
      const reshuffled = shuffleWithFirst(queue, queueIndex)
      set({ queue: reshuffled, queueIndex: 0, isPlaying: true, isLoading: true, position: 0, error: null })
    } else {
      set({ isPlaying: false, position: 0 })
    }
  },

  prev: () => {
    const { queue, queueIndex, position } = get()
    if (position > 3) {
      get().seek(0)
      return
    }
    if (queueIndex > 0) {
      const i = queueIndex - 1
      set({ queueIndex: i, isPlaying: true, isLoading: true, position: 0, duration: queue[i].duration || 0, error: null })
      void recordHistory(queue[i])
    } else {
      get().seek(0)
    }
  },

  seek: (sec) => set({ position: sec }),

  setVolume: (v) => set({ volume: Math.max(0, Math.min(1, v)), muted: v === 0 ? true : false, prevVolume: v === 0 ? get().prevVolume : v }),

  toggleMute: () => {
    const { muted, volume, prevVolume } = get()
    if (muted) set({ muted: false, volume: prevVolume || 0.5 })
    else set({ muted: true, prevVolume: volume || 0.5, volume: 0 })
  },

  toggleShuffle: () => {
    const { shuffle, queue, queueIndex, originalQueue } = get()
    const current = queue[queueIndex]
    if (!shuffle) {
      const shuffled = shuffleWithFirst(queue, queueIndex)
      set({ shuffle: true, queue: shuffled, queueIndex: 0 })
    } else {
      // restore original order, keep current track
      const idx = Math.max(0, originalQueue.findIndex((t) => t.videoId === current?.videoId))
      set({ shuffle: false, queue: [...originalQueue], queueIndex: idx })
    }
  },

  cycleRepeat: () => set((s) => ({ repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off' })),

  addToQueue: (track) => set((s) => ({ queue: [...s.queue, track] })),

  playNext: (track) =>
    set((s) => {
      const q = [...s.queue]
      q.splice(s.queueIndex + 1, 0, track)
      return { queue: q }
    }),

  removeFromQueue: (index) =>
    set((s) => {
      if (index === s.queueIndex) return {} // can't remove the playing track
      const q = s.queue.filter((_, i) => i !== index)
      const newIdx = index < s.queueIndex ? s.queueIndex - 1 : s.queueIndex
      return { queue: q, queueIndex: newIdx }
    }),

  clearQueue: () => set({ queue: [], queueIndex: -1, isPlaying: false, contextTitle: '' }),

  current: () => {
    const { queue, queueIndex } = get()
    return queueIndex >= 0 ? queue[queueIndex] : null
  },

  openNowPlaying: () => set({ nowPlayingOpen: true }),
  closeNowPlaying: () => set({ nowPlayingOpen: false }),
  toggleQueue: () => set((s) => ({ queueOpen: !s.queueOpen, lyricsOpen: false })),
  toggleLyrics: () => set((s) => ({ lyricsOpen: !s.lyricsOpen, queueOpen: false })),

  startSleepTimer: (minutes) =>
    set({ sleepTimerMs: minutes * 60 * 1000, sleepTimerStartedAt: Date.now() }),
  cancelSleepTimer: () => set({ sleepTimerMs: null, sleepTimerStartedAt: null }),

  tickSleepTimer: (deltaMs) => {
    const { sleepTimerMs, isPlaying } = get()
    if (sleepTimerMs == null) return
    const remaining = sleepTimerMs - deltaMs
    if (remaining <= 0) {
      set({ sleepTimerMs: null, sleepTimerStartedAt: null, isPlaying: false })
    } else {
      set({ sleepTimerMs: remaining })
    }
    void isPlaying
  },

  setCrossfade: (ms) => set({ crossfadeMs: ms }),

  toggleSmartShuffle: () => set((s) => ({ smartShuffle: !s.smartShuffle })),

  applySmartShuffle: (augmentedQueue, insertedAt) => {
    const { queueIndex } = get()
    // If we can find the currently playing track in the augmented queue,
    // keep queueIndex pointed at it; otherwise reset to 0.
    const current = get().queue[queueIndex]
    let newIndex = 0
    if (current) {
      const idx = augmentedQueue.findIndex((t) => t.videoId === current.videoId)
      if (idx >= 0) newIndex = idx
    }
    set({
      queue: augmentedQueue,
      queueIndex: newIndex,
      shuffle: true,
      smartShuffleLoading: false,
      // keep originalQueue as the pre-smart-shuffle queue so toggling off restores
    })
    void insertedAt
  },
}))

async function recordHistory(track: PlayerTrack | undefined) {
  if (!track) return
  try {
    await fetch('/api/library/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: track.videoId, track }),
    })
  } catch { /* non-fatal */ }
}

/** Format seconds → m:ss or h:mm:ss */
export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

// expose for debugging in browser
if (typeof window !== 'undefined') {
  ;(window as any).__player = usePlayer
}
