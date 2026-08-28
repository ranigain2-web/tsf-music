'use client'

/**
 * TSF Music — client-side navigation
 * The app is a single route; views are stacked like a native app with
 * browser-history integration (back button works).
 */

import { create } from 'zustand'

export type View =
  | { type: 'home' }
  | { type: 'search'; q?: string }
  | { type: 'album'; id: string; title?: string }
  | { type: 'artist'; id: string; title?: string }
  | { type: 'library'; tab?: 'playlists' | 'liked' | 'history' }
  | { type: 'playlist'; id: string }
  | { type: 'liked' }
  | { type: 'ai' }
  | { type: 'ai-generated'; endpoint: string; title: string; subtitle?: string; gradient?: [string, string]; emoji?: string }
  | { type: 'mood'; mood: string; title: string; gradient: [string, string]; emoji: string }

interface NavState {
  stack: View[]
  view: View
  push: (v: View) => void
  replace: (v: View) => void
  pop: () => void
  goHome: () => void
}

export const useNav = create<NavState>((set, get) => ({
  stack: [{ type: 'home' }],
  view: { type: 'home' },

  push: (v) => {
    const { stack } = get()
    set({ stack: [...stack, v], view: v })
    try { window.history.pushState({ tsf: stack.length + 1 }, '') } catch {}
  },

  replace: (v) => {
    const { stack } = get()
    if (stack.length <= 1) set({ stack: [v], view: v })
    else set({ stack: [...stack.slice(0, -1), v], view: v })
  },

  pop: () => {
    const { stack } = get()
    if (stack.length <= 1) return
    const newStack = stack.slice(0, -1)
    set({ stack: newStack, view: newStack[newStack.length - 1] })
  },

  goHome: () => set({ stack: [{ type: 'home' }], view: { type: 'home' } }),
}))

// browser back button pops our stack
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    const { stack } = useNav.getState()
    if (stack.length > 1) useNav.getState().pop()
  })
}

/** Small client fetch helper */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}
