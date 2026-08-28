'use client'

/**
 * TSF Music — native MediaSession bridge (three backends, one API).
 *
 * 1. Capacitor shells (Android APK / iOS IPA): hand-rolled local plugin
 *    `TsfMediaSession` (android/.../MediaSessionPlugin.java,
 *    ios/App/TsfMediaSessionPlugin.swift) projects playback onto
 *    MediaSessionCompat / MPNowPlayingInfoCenter.
 *
 * 2. Tauri desktop shell (macOS .app): the Rust core owns souvlaki
 *    (MPNowPlayingInfoCenter + MPRemoteCommandCenter). Web → native is the
 *    `media_update` IPC command; native → web arrives as a
 *    `tsf-media-command` CustomEvent (see src-tauri/src/lib.rs).
 *
 * 3. Plain web: no-op — AudioEngine already wires navigator.mediaSession.
 *
 * Every call is fire-and-forget with catch-all error handling so a native
 * hiccup can never touch playback.
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface NativeMetadata {
  title: string
  artist?: string
  album?: string
  /** absolute URL — native loaders can't resolve app-relative paths */
  artworkUrl?: string
  duration?: number
}

export interface NativePlaybackState {
  isPlaying: boolean
  position?: number
  duration?: number
}

export interface NativeMediaSessionPlugin {
  updateMetadata(options: NativeMetadata): Promise<void>
  updatePlaybackState(options: NativePlaybackState): Promise<void>
  stop(): Promise<void>
  addListener(
    eventName: 'command',
    listenerFunc: (data: { action: string; seekTime?: number }) => void,
  ): Promise<PluginListenerHandle> & PluginListenerHandle
}

const TsfMediaSession = registerPlugin<NativeMediaSessionPlugin>('TsfMediaSession')

// ---------------------------------------------------------------------------
// Tauri (desktop) backend
// ---------------------------------------------------------------------------

interface TauriWindow {
  __TAURI_INTERNALS__?: unknown
  __TAURI__?: { core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }
}

/** true only inside the Tauri desktop shell (macOS .app / Windows / Linux) */
export function isTauriShell(): boolean {
  try {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as unknown as TauriWindow)
  } catch {
    return false
  }
}

function tauriInvoke(cmd: string, payload: Record<string, unknown>): void {
  try {
    const t = (window as unknown as TauriWindow).__TAURI__
    const invoke = t?.core?.invoke
    if (typeof invoke === 'function') {
      invoke('media_update', { cmd, payload }).catch(() => {})
    }
  } catch {
    /* never let the bridge touch playback */
  }
}

/** true inside any native shell (Capacitor mobile OR Tauri desktop) */
export function isNativeShell(): boolean {
  if (isTauriShell()) return true
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Backend-agnostic API
// ---------------------------------------------------------------------------

/** thumbnail fields can be app-relative (/icon.svg) — native needs absolute */
function absoluteArtwork(src?: string | null): string | undefined {
  if (!src) return undefined
  try {
    return new URL(src, window.location.origin).toString()
  } catch {
    return undefined
  }
}

export function nativeUpdateMetadata(track: {
  title: string
  artistName?: string
  albumName?: string
  thumbnail?: string | null
  duration?: number
}): void {
  if (!isNativeShell()) return
  const meta: NativeMetadata = {
    title: track.title,
    artist: track.artistName,
    album: track.albumName || 'TSF Music',
    artworkUrl: absoluteArtwork(track.thumbnail),
    duration: track.duration && isFinite(track.duration) ? track.duration : 0,
  }
  if (isTauriShell()) {
    tauriInvoke('metadata', { ...meta })
  } else {
    TsfMediaSession.updateMetadata(meta).catch(() => {})
  }
}

export function nativeUpdatePlaybackState(state: NativePlaybackState): void {
  if (!isNativeShell()) return
  if (isTauriShell()) {
    tauriInvoke('state', {
      playing: state.isPlaying,
      position: state.position ?? 0,
      duration: state.duration ?? 0,
    })
  } else {
    TsfMediaSession.updatePlaybackState({
      isPlaying: state.isPlaying,
      position: state.position ?? 0,
      duration: state.duration ?? 0,
    }).catch(() => {})
  }
}

export function nativeStop(): void {
  if (!isNativeShell()) return
  if (isTauriShell()) {
    tauriInvoke('stop', {})
  } else {
    TsfMediaSession.stop().catch(() => {})
  }
}

/**
 * Subscribe to native transport commands (lockscreen/headphone/media keys).
 * Returns an unsubscribe fn; safe to call on web (no-op).
 */
export function onNativeCommand(handler: (action: string, seekTime?: number) => void): () => void {
  if (!isNativeShell()) return () => {}

  if (isTauriShell()) {
    const listener = (e: Event): void => {
      const detail = (e as CustomEvent<{ type?: string; seconds?: number; dir?: string; volume?: number; delta?: number }>).detail
      if (!detail || typeof detail.type !== 'string') return
      switch (detail.type) {
        case 'play':
        case 'pause':
        case 'toggle':
        case 'next':
        case 'previous':
        case 'stop':
          handler(detail.type)
          break
        case 'seekto':
          if (typeof detail.seconds === 'number') handler('seekto', detail.seconds)
          break
        case 'seekby':
          // signed delta: backward is negative (from souvlaki SeekDirection)
          if (typeof detail.seconds === 'number') {
            const delta = detail.dir === 'backward' ? -detail.seconds : detail.seconds
            handler('seekby', delta)
          }
          break
        case 'volume':
          if (typeof detail.volume === 'number') handler('volume', detail.volume)
          break
        case 'voldelta':
          // menu-bar Volume Up/Down — signed delta around current volume
          if (typeof detail.delta === 'number') handler('voldelta', detail.delta)
          break
        default:
          break
      }
    }
    window.addEventListener('tsf-media-command', listener)
    return () => window.removeEventListener('tsf-media-command', listener)
  }

  let handle: PluginListenerHandle | null = null
  TsfMediaSession.addListener('command', (data) => {
    if (data && typeof data.action === 'string') {
      handler(data.action, data.seekTime)
    }
  })
    .then((h) => {
      handle = h
    })
    .catch(() => {})
  return () => {
    try {
      handle?.remove()
    } catch {
      /* already gone */
    }
  }
}
