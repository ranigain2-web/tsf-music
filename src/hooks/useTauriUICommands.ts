'use client'

/**
 * TSF Music — Tauri desktop shell UI commands.
 *
 * The Rust shell's native menu bar (View ▸ Lyrics ⇧⌘L) and tray dispatch
 * `tsf-ui-command` CustomEvents into the page. This hook maps them to store
 * actions. No-op outside the Tauri shell (web/mobile use in-app controls).
 *
 * See src-tauri/src/lib.rs for the dispatching side.
 */

import { useEffect } from 'react'
import { isTauriShell } from '@/lib/nativeMedia'
import { usePlayer } from '@/store/player'

interface UICommandDetail {
  action?: string
}

export function useTauriUICommands(): void {
  useEffect(() => {
    if (!isTauriShell()) return
    const listener = (e: Event): void => {
      const detail = (e as CustomEvent<UICommandDetail>).detail
      const action = detail?.action
      switch (action) {
        case 'toggle-lyrics':
          usePlayer.getState().toggleLyrics()
          break
        case 'open-queue':
          usePlayer.getState().toggleQueue()
          break
        default:
          break
      }
    }
    window.addEventListener('tsf-ui-command', listener)
    return () => window.removeEventListener('tsf-ui-command', listener)
  }, [])
}
