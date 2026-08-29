'use client'

/**
 * TSF Music — Player store (Zustand)
 * Single source of truth for playback. A separate <AudioEngine /> component
 * mounts the singleton <audio> element and reacts to store changes.
 *
 * SMART SHUFFLE V2 (MINDBEAT): rec slots come from the Mindbeat Decision
 * Engine (/api/mindbeat/next-up) with the constitution's cadence, QUEUE
 * HEALING (skipped rec slots re-query into the next rec slot) and vibe-lock
 * (SKIP_STORM stops interleaving for the session). Legacy fallback:
 * /api/ai/smart-shuffle — the toggle never breaks.
 */

import { create } from 'zustand'
import { SMART_SHUFFLE } from '@/lib/mindbeat/types'
import { notifyUserSkip, surfaceFlags } from '@/lib/mindbeat/client'
import { toast } from 'sonner'

/** True when the CURRENT transition was user-initiated — consumed by the
 * audio-engine cleanup to grade the leaving listen as TRACK_SKIP. Lives on
 * the store (a guaranteed singleton) because a module-level flag can be
 * duplicated across chunk graphs. */
let pendingUserSkip = false

export interface PlayerTrack {
  videoId: string
  title: string
  artistName: string
  artistId?: string
  albumName?: string
  albumId?: string
  duration: number
  thumbnail: string
  /** MINDBEAT: true when this slot is a smart-shuffle recommendation */
  __rec?: boolean
  /** MINDBEAT: engine reason line for rec slots (queue badge tooltip) */
  __reason?: string
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
  /** opts.auto: engine-initiated advance (stall/error recovery, natural end) — not a user skip. */
  next: (opts?: { auto?: boolean }) => void
  prev: (opts?: { auto?: boolean }) => void
  seek: (sec: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  addToQueue: (track: PlayerTrack) => void
  playNext: (track: PlayerTrack) => void
  removeFromQueue: (index: number) => void
  reorderQueue: (from: number, to: number) => void
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
  /** SMART SHUFFLE V2: fetch recs from the Mindbeat engine and apply.
   *  opts.explicit marks a user-initiated Smart press (default true) — only
   *  explicit presses may toast when the rec kill switch swallows the call. */
  requestSmartShuffle: (opts?: { explicit?: boolean }) => Promise<void>
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

// ---------------------------------------------------------------------------
// MINDBEAT Smart Shuffle v2 — in-session state (module-level, never persisted)
// ---------------------------------------------------------------------------

interface SessionListenLite {
  videoId: string
  artistName?: string
  energy?: number
}

let sessionRecent: SessionListenLite[] = []
let recSkipsInARow = 0 // consecutive skipped rec slots (heal backoff counter)
let recSavesInARow = 0 // consecutive completed rec slots (save tighten counter)
let recVibeLock = false // SKIP_STORM → stop interleaving recs for the session
let healsUsed = 0
const MAX_HEALS_PER_SESSION = 6
const SESSION_RECENT_CAP = 12 // constitution SESSION_WINDOW

function resetRecSessionState(): void {
  sessionRecent = []
  recSkipsInARow = 0
  recSavesInARow = 0
  recVibeLock = false
  healsUsed = 0
}

function pushSessionRecent(t: PlayerTrack | undefined): void {
  if (!t?.videoId) return
  if (sessionRecent.length && sessionRecent[sessionRecent.length - 1].videoId === t.videoId) return
  sessionRecent.push({ videoId: t.videoId, ...(t.artistName ? { artistName: t.artistName } : {}) })
  if (sessionRecent.length > SESSION_RECENT_CAP) sessionRecent.shift()
}

/**
 * Cadence divisor (1 rec per N tracks): base 3, backed off to 4 after 2
 * skipped recs (SMART_SHUFFLE.healBackoff), tightened to 2 after 2 saved recs
 * (SMART_SHUFFLE.saveTighten).
 */
function recCadenceDivisor(): number {
  if (recSkipsInARow >= 2) return SMART_SHUFFLE.healBackoff
  if (recSavesInARow >= 2) return SMART_SHUFFLE.saveTighten
  return SMART_SHUFFLE.cadenceOver15
}

/** Rec count for a queue of `len` tracks (constitution cadence table). */
function recCountFor(len: number): number {
  if (len < 6) return len >= 2 ? 1 : 0
  const per = Math.floor(len / recCadenceDivisor())
  return len > 15 ? per : Math.min(SMART_SHUFFLE.smallMaxRecs, per)
}

function toRecTrack(t: {
  videoId: string
  title: string
  artistName: string
  artistId?: string
  duration?: number
  thumbnail?: string
  albumName?: string
  albumId?: string
}, reason?: string): PlayerTrack {
  return {
    videoId: t.videoId,
    title: t.title,
    artistName: t.artistName,
    ...(t.artistId ? { artistId: t.artistId } : {}),
    ...(t.albumName ? { albumName: t.albumName } : {}),
    ...(t.albumId ? { albumId: t.albumId } : {}),
    duration: t.duration ?? 0,
    thumbnail: t.thumbnail ?? '',
    __rec: true,
    ...(reason ? { __reason: reason } : {}),
  }
}

interface EnginePickLite {
  track: { videoId: string; title: string; artistName: string; artistId?: string; duration?: number; thumbnail?: string }
  reasonLine?: string
}

/** Interleave recs 1 per cadence divisor after index > 0 (never before the playing track). */
function interleaveRecs(
  queue: PlayerTrack[],
  recs: PlayerTrack[]
): { tracks: PlayerTrack[]; insertedAt: number[] } {
  const result: PlayerTrack[] = []
  const insertedAt: number[] = []
  let k = 0
  const divisor = recCadenceDivisor()
  for (let i = 0; i < queue.length; i++) {
    result.push(queue[i])
    if (i > 0 && i % divisor === 0 && k < recs.length) {
      result.push(recs[k])
      insertedAt.push(result.length - 1)
      k++
    }
  }
  while (k < recs.length) {
    result.push(recs[k])
    insertedAt.push(result.length - 1)
    k++
  }
  return { tracks: result, insertedAt }
}

interface RecAugmentation {
  tracks: PlayerTrack[]
  insertedAt: number[]
}

async function fetchRecPicks(
  seeds: SessionListenLite[],
  count: number,
  exclude: string[]
): Promise<EnginePickLite[] | null> {
  if (count <= 0 || recVibeLock) return null
  // KILL SWITCH (plan §10.4): 'tsf-mindbeat-off' === 'on' → ZERO recs from
  // this store — neither batch augmentation nor queue healing reaches the
  // engine. Flags ride along so the route can enforce server-side too.
  const flags = surfaceFlags()
  if (flags.recsOff) return null
  try {
    const r = await fetch('/api/mindbeat/next-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seeds,
        count,
        surface: 'smart_shuffle_rec',
        exclude,
        session: { recent: sessionRecent, skipStormCount: recSkipsInARow },
        flags,
      }),
    })
    if (r.ok) {
      const j = (await r.json()) as { picks?: EnginePickLite[]; vibe?: string }
      if (j?.vibe === 'SKIP_STORM') {
        // VIBE-LOCK (constitution §7.2): stop interleaving recs for the rest of
        // the session — never apply a batch served during the storm either.
        recVibeLock = true
        return null
      }
      if (Array.isArray(j?.picks) && j.picks.length) return j.picks
    }
  } catch {
    /* fall through to the legacy endpoint */
  }
  return null
}

/** Legacy fallback — keeps the toggle working if the Mindbeat route fails. */
async function fetchLegacySmartShuffle(queue: PlayerTrack[], count: number): Promise<RecAugmentation | null> {
  try {
    const r = await fetch('/api/ai/smart-shuffle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: queue, count: Math.max(2, count) }),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { tracks?: PlayerTrack[]; insertedAt?: number[] }
    if (!j?.tracks?.length) return null
    const inserted = new Set(j.insertedAt ?? [])
    const tracks = j.tracks.map((t, i) => (inserted.has(i) ? { ...t, __rec: true } : t))
    return { tracks, insertedAt: j.insertedAt ?? [] }
  } catch {
    return null
  }
}

/** One healed pick for a skipped rec slot. */
async function fetchOneHealedPick(seed: SessionListenLite & { title?: string }, exclude: string[]): Promise<PlayerTrack | null> {
  const picks = await fetchRecPicks([{ videoId: seed.videoId, ...(seed.artistName ? { artistName: seed.artistName } : {}) }], 1, exclude)
  const p = picks?.[0]
  if (!p?.track?.videoId) return null
  return toRecTrack(p.track, p.reasonLine)
}

/**
 * QUEUE HEALING: a rec slot the user skipped re-queries the engine and
 * replaces the NEXT upcoming rec slot (same cadence position, better pick).
 * Backoff/tighten counters steer the next full augmentation's cadence.
 */
async function healRecSlot(skipped: PlayerTrack): Promise<void> {
  // KILL SWITCH: recs off → healing stays off too (passive path, never toasts).
  if (surfaceFlags().recsOff) return
  if (recVibeLock || healsUsed >= MAX_HEALS_PER_SESSION) return
  const { queue, queueIndex, smartShuffle } = usePlayer.getState()
  if (!smartShuffle) return
  const upcomingRecIdx = queue.findIndex((t, i) => i > queueIndex && t.__rec)
  if (upcomingRecIdx < 0) return // nothing to heal into — cadence stays untouched
  healsUsed++
  const exclude = queue.map((t) => t.videoId)
  const replacement = await fetchOneHealedPick(
    { videoId: skipped.videoId, ...(skipped.artistName ? { artistName: skipped.artistName } : {}) },
    exclude
  )
  if (!replacement) return
  const cur = usePlayer.getState()
  // queue changed mid-flight (reorder / removal) → abort safely
  if (cur.queue.length !== queue.length || cur.queue[upcomingRecIdx]?.videoId !== queue[upcomingRecIdx]?.videoId) return
  const q = [...cur.queue]
  q[upcomingRecIdx] = replacement
  usePlayer.setState({ queue: q })
  // MINDBEAT: re-stamp the healed slot so TRACK_START attributes it
  try {
    const m = await import('@/lib/mindbeat/client')
    m.markQueueSource([replacement], 'smart_shuffle_rec')
  } catch {
    /* instrumentation only */
  }
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
    // MINDBEAT v2: a new queue is a new session context — reset rec cadence,
    // heal counters and the SKIP_STORM vibe-lock.
    resetRecSessionState()
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

  next: (opts) => {
    const { queue, queueIndex, repeat, shuffle } = get()
    if (!queue.length) return
    const leaving = queue[queueIndex]
    // MINDBEAT: user-initiated advance → the NEXT trackEnd grades as TRACK_SKIP.
    // Lazy import keeps the store SSR/store-eval safe. Engine-initiated
    // advances pass { auto: true } and skip this entirely.
    if (!opts?.auto) {
      notifyUserSkip()
      pendingUserSkip = true
      // SMART SHUFFLE V2 — QUEUE HEALING: a skipped rec slot counters the
      // save streak and re-queries into the next rec slot.
      if (leaving?.__rec) {
        recSkipsInARow++
        recSavesInARow = 0
        void healRecSlot(leaving)
      }
    } else {
      pendingUserSkip = false
      if (leaving?.__rec) {
        // a rec that ran to natural completion counts as a save → tighten
        recSavesInARow++
        recSkipsInARow = 0
      }
    }
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

  prev: (opts) => {
    const { queue, queueIndex, position } = get()
    if (position > 3) {
      get().seek(0)
      return
    }
    if (queueIndex > 0) {
      // MINDBEAT: user-initiated advance → NEXT trackEnd grades as TRACK_SKIP
      if (!opts?.auto) {
        notifyUserSkip()
        pendingUserSkip = true
      } else {
        pendingUserSkip = false
      }
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

  addToQueue: (track) => {
    set((s) => ({ queue: [...s.queue, track] }))
    // MINDBEAT: QUEUE_ADD_MANUAL
    void import('@/lib/mindbeat/client').then((m) => m.queueAdd(track.videoId, 'user_queue'))
  },

  playNext: (track) => {
    set((s) => {
      const q = [...s.queue]
      q.splice(s.queueIndex + 1, 0, track)
      return { queue: q }
    })
    // MINDBEAT: QUEUE_ADD_MANUAL (play-next is still a manual queue add)
    void import('@/lib/mindbeat/client').then((m) => m.queueAdd(track.videoId, 'user_queue'))
  },

  removeFromQueue: (index) => {
    const removed = get().queue[index]
    set((s) => {
      if (index === s.queueIndex) return {} // can't remove the playing track
      const q = s.queue.filter((_, i) => i !== index)
      const newIdx = index < s.queueIndex ? s.queueIndex - 1 : s.queueIndex
      return { queue: q, queueIndex: newIdx }
    })
    // MINDBEAT: QUEUE_REMOVE (wasRecommended resolved from the rec-source stamp)
    if (removed && removed.videoId !== get().queue[get().queueIndex]?.videoId) {
      void import('@/lib/mindbeat/client').then((m) => m.queueRemove(removed.videoId))
    }
  },

  // Drag-and-drop reorder (upcoming tracks only; the playing track is pinned).
  reorderQueue: (from, to) =>
    set((s) => {
      if (from === to) return {}
      if (from <= s.queueIndex || to <= s.queueIndex) return {} // never move the playing track or above it
      if (from >= s.queue.length || to >= s.queue.length) return {}
      const q = [...s.queue]
      const [moved] = q.splice(from, 1)
      q.splice(to, 0, moved)
      return { queue: q, queueIndex: s.queueIndex }
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

  requestSmartShuffle: async (opts) => {
    const { queue, smartShuffle } = get()
    if (!smartShuffle || queue.length < 2 || recVibeLock) {
      set({ smartShuffleLoading: false })
      return
    }
    // KILL SWITCH (plan §10.4): 'tsf-mindbeat-off' === 'on' → the queue stays
    // classic (no recs injected, no legacy fallback, healing skipped). The
    // toast fires ONLY on the explicit Smart-button path — passive heal
    // entries never call this with a toast-worthy context.
    if (surfaceFlags().recsOff) {
      set({ smartShuffleLoading: false })
      if (opts?.explicit !== false) {
        try {
          toast('Recommendations are off — playing your music straight')
        } catch { /* toast is cosmetic */ }
      }
      return
    }
    set({ smartShuffleLoading: true })
    try {
      const count = recCountFor(queue.length)
      if (count > 0) {
        // seeds spread across the queue (first / middle / last)
        const seedIdx = [...new Set([0, Math.floor(queue.length / 2), queue.length - 1])]
        const seeds: SessionListenLite[] = seedIdx
          .map((i) => queue[i])
          .filter((t) => t?.videoId)
          .map((t) => ({ videoId: t.videoId, ...(t.artistName ? { artistName: t.artistName } : {}) }))
        const exclude = queue.map((t) => t.videoId)
        let augmentation: RecAugmentation | null = null
        const picks = await fetchRecPicks(seeds, count, exclude)
        if (picks?.length) {
          const recs = picks
            .filter((p) => p?.track?.videoId)
            .map((p) => toRecTrack(p.track, p.reasonLine))
          if (recs.length) augmentation = interleaveRecs(queue, recs)
        }
        // legacy fallback honors the kill switch too (flag may flip mid-flight)
        if (!augmentation && !recVibeLock && !surfaceFlags().recsOff) {
          augmentation = await fetchLegacySmartShuffle(queue, count)
        }
        if (augmentation) get().applySmartShuffle(augmentation.tracks, augmentation.insertedAt)
      }
    } finally {
      set({ smartShuffleLoading: false })
    }
  },

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
    // MINDBEAT: stamp ONLY the inserted recommendation slots so TRACK_START
    // attributes them to smart_shuffle_rec (wasRecommended + REC_EXPOSURE).
    try {
      const recs = (insertedAt || [])
        .map((i) => augmentedQueue[i])
        .filter((t) => t && t.videoId)
      if (recs.length) {
        void import('@/lib/mindbeat/client').then((m) => m.markQueueSource(recs, 'smart_shuffle_rec'))
      }
    } catch { /* instrumentation only */ }
  },
}))

async function recordHistory(track: PlayerTrack | undefined) {
  if (!track) return
  // MINDBEAT v2: feed the rec session payload (recent listens for vibe-lock)
  pushSessionRecent(track)
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

/** Read-and-clear the user-skip transition flag (audio-engine cleanup). */
export function consumePendingUserSkip(): boolean {
  const v = pendingUserSkip
  pendingUserSkip = false
  return v
}
