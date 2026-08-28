'use client'

/**
 * TSF Music — native MediaSession bridge.
 *
 * On native shells (Capacitor Android APK / iOS IPA) the web
 * navigator.mediaSession never reaches the OS, so a hand-rolled local plugin
 * (`TsfMediaSession`, see android/app/src/main/java/com/tsf/music/ and
 * ios/App/App/TsfMediaSessionPlugin.swift) projects playback onto the
 * platform surfaces:
 *   - Android: MediaSessionCompat + MediaStyle notification held by a
 *     foreground service (lockscreen + notification controls, process kept
 *     alive while the WebView plays in background)
 *   - iOS: MPNowPlayingInfoCenter + MPRemoteCommandCenter (lockscreen /
 *     Control Center player, headphone transport)
 *
 * On the plain web this module is a no-op — AudioEngine already wires
 * navigator.mediaSession directly. Every call is fire-and-forget with
 * catch-all error handling so a native hiccup can never touch playback.
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

/** true only inside a native shell (APK/IPA) */
export function isNativeShell(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

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
  TsfMediaSession.updateMetadata({
    title: track.title,
    artist: track.artistName,
    album: track.albumName || 'TSF Music',
    artworkUrl: absoluteArtwork(track.thumbnail),
    duration: track.duration && isFinite(track.duration) ? track.duration : 0,
  }).catch(() => {})
}

export function nativeUpdatePlaybackState(state: NativePlaybackState): void {
  if (!isNativeShell()) return
  TsfMediaSession.updatePlaybackState({
    isPlaying: state.isPlaying,
    position: state.position ?? 0,
    duration: state.duration ?? 0,
  }).catch(() => {})
}

export function nativeStop(): void {
  if (!isNativeShell()) return
  TsfMediaSession.stop().catch(() => {})
}

/**
 * Subscribe to native transport commands (lockscreen/headphone buttons).
 * Returns an unsubscribe fn; safe to call on web (no-op).
 */
export function onNativeCommand(handler: (action: string, seekTime?: number) => void): () => void {
  if (!isNativeShell()) return () => {}
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
