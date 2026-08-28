'use client'

/**
 * TSF Music — Preferences (profile data filled during onboarding)
 *
 * Stored server-side in the Settings table; mirrored in-memory for fast UI
 * access. Rehydrated once on app boot.
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

interface PreferencesState extends Preferences {
  loaded: boolean
  load: () => Promise<void>
  setName: (n: string) => void
  setBio: (b: string) => void
  setArtists: (a: SelectedArtist[]) => void
  setGenres: (g: string[]) => void
  /** Persist current store state to server (saves profile.* keys). */
  save: () => Promise<void>
  /** Mark onboarding complete (sets onboarding.complete=true server-side). */
  complete_: () => Promise<void>
  /** Reset: wipe server profile, mark incomplete, clear in-memory. */
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
    try {
      const r = await fetch('/api/onboarding')
      const j = (await r.json()) as Preferences
      set({ ...j, loaded: true })
    } catch {
      set({ loaded: true })
    }
  },

  setName: (n) => set({ name: n }),
  setBio: (b) => set({ bio: b }),
  setArtists: (a) => set({ artists: a }),
  setGenres: (g) => set({ genres: g }),

  save: async () => {
    const { name, bio, artists, genres } = get()
    await fetch('/api/onboarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', name, bio, artists, genres }),
    })
  },

  complete_: async () => {
    await get().save()
    await fetch('/api/onboarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'complete' }),
    })
    set({ complete: true })
  },

  reset: async () => {
    await fetch('/api/onboarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset' }),
    })
    set({ name: undefined, bio: undefined, artists: [], genres: [], complete: false })
  },
}))
