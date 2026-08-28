'use client'

/**
 * TSF Music — singleton audio element ref
 * Both the AudioEngine and UI controls talk to the same <audio>.
 */

import type { AudioEngineHandle } from './engine-types'

let handle: AudioEngineHandle | null = null

export function setAudioHandle(h: AudioEngineHandle | null) {
  handle = h
}

export function getAudio(): HTMLAudioElement | null {
  return handle?.audio ?? null
}

/** Seek the audio element (bypasses the store for immediate feedback). */
export function seekTo(sec: number) {
  if (handle?.audio) {
    handle.audio.currentTime = sec
  }
}
