'use client'

/**
 * TSF Music — Preferences (profile data filled during onboarding)
 *
 * TWO-TIER PERSISTENCE (the "nothing is stored" fix):
 *   Tier 1 (server): Settings table via /api/onboarding — the source of truth.
 *   Tier 2 (client): localStorage mirror `tsf-profile-cache` — written on every
 *     save/complete. If the server is unreachable, resets, or its DB is fresh
 *     (packaged app pointing at a wiped DB, dev server restart with a new db
 *     file, transient boot race), the gate hydrates from the mirror and
 *     SELF-HEALS the server in the background instead of re-running onboarding.
 *
 * The mirror only upgrades resilience — server data always wins when present.
 */

import { create } from 'zustand'
import type { SelectedArtist } from '@/app/api/onboarding/route'

export interface Preferences {
  name?: string
  bio?: string
  artists: SelectedArtist[]
  genres: string[]
  complete: boolean
}

const LS_KEY = 'tsf-profile-cache'

function readMirror(): Preferences | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const j = JSON.parse(raw) as Preferences
    if (typeof j.complete !== 'boolean') return null
    if (!Array.isArray(j.artists)) j.artists = []
    if (!Array.isArray(j.genres)) j.genres = []
    return j
  } catch {
    return null
  }
}

function writeMirror(p: Preferences) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...p, savedAt: Date.now() }))
  } catch { /* storage full/blocked — tier 1 still works */ }
}

interface PreferencesState extends Preferences {
  loaded: boolean
  load: () => Promise<void>
  setName: (n: string) => void
  setBio: (b: string) => void
  setArtists: (a: SelectedArtist[]) => void
  setGenres: (g: string[]) => void
  /** Persist current store state to server + mirror (saves profile.* keys). */
  save: () => Promise<void>
  /** Mark onboarding complete (sets onboarding.complete=true server-side + mirror). */
  complete_: () => Promise<void>
  /** Reset: wipe server profile, mark incomplete, clear mirror + memory. */
  reset: () => Promise<void>
}

export const usePreferences = create<PreferencesState>((set, get) => ({
  name: undefined,
  bio: undefined,
  artists: [],
  genres: [],
  complete: false,
  loaded: false,

  load: async () => {
    const mirror = readMirror()
    try {
      const r = await fetch('/api/onboarding')
      const j = (await r.json()) as Preferences
      if (j.complete) {
        // Server truth wins; refresh the mirror so it never goes stale.
        writeMirror(j)
        set({ ...j, loaded: true })
        return
      }
      // Server says incomplete but the mirror remembers a completed profile —
      // the server DB was reset/wiped behind our back. Hydrate from the mirror
      // and heal the server in the background. The user must NEVER re-onboard.
      if (mirror?.complete) {
        set({ ...mirror, loaded: true })
        void (async () => {
          try {
            await fetch('/api/onboarding', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'save', name: mirror.name, bio: mirror.bio, artists: mirror.artists, genres: mirror.genres }),
            })
            await fetch('/api/onboarding', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'complete' }),
            })
          } catch { /* next load retries the heal */ }
        })()
        return
      }
      set({ ...j, loaded: true })
    } catch {
      // Server unreachable entirely — trust the mirror (offline-first).
      if (mirror?.complete) {
        set({ ...mirror, loaded: true })
      } else {
        set({ loaded: true })
      }
    }
  },

  setName: (n) => set({ name: n }),
  setBio: (b) => set({ bio: b }),
  setArtists: (a) => set({ artists: a }),
  setGenres: (g) => set({ genres: g }),

  save: async () => {
    const { name, bio, artists, genres } = get()
    // Mirror FIRST — even if the server write fails, nothing is lost.
    writeMirror({ name, bio, artists, genres, complete: get().complete })
    try {
      await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', name, bio, artists, genres }),
      })
    } catch { /* mirror already holds it */ }
  },

  complete_: async () => {
    set({ complete: true })
    writeMirror(get())
    await get().save()
    try {
      await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete' }),
      })
    } catch { /* mirror complete=true already gates the shell */ }
  },

  reset: async () => {
    try {
      localStorage.removeItem(LS_KEY)
    } catch { /* ignore */ }
    try {
      await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      })
    } catch { /* ignore */ }
    set({ name: undefined, bio: undefined, artists: [], genres: [], complete: false })
  },
}))
