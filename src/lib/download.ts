'use client'

/**
 * TSF Music — the ONE track download manager (client).
 *
 * WHY THIS EXISTS (reported from real use: "it just statically gets
 * downloaded"):
 *
 * Downloading was a bare `fetch → blob → <a download>` copy-pasted into four
 * components. It buffered the ENTIRE track in memory before anything appeared
 * on disk, reported nothing while it did, and the only affordance was a
 * spinner that lived inside the row's hover state — so the moment the pointer
 * left the row, even that vanished. A 4-minute song therefore looked like a
 * dead button for a minute and then silently produced a file.
 *
 * This module owns one download per track, exposes live progress to every
 * surface (row, context menu, player bar, full-screen player), and narrates it
 * through sonner toasts. It streams the response instead of buffering blindly,
 * so `Content-Length` gives a real percentage rather than a guess.
 */

import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'

export type DownloadStatus = 'idle' | 'downloading' | 'done' | 'error'

export interface DownloadState {
  status: DownloadStatus
  /** 0..1 when the server sent Content-Length; null = indeterminate */
  progress: number | null
  bytes: number
  error?: string
}

export interface DownloadTarget {
  videoId: string
  title: string
  artistName?: string
  duration?: number
}

const IDLE: DownloadState = { status: 'idle', progress: null, bytes: 0 }

const states = new Map<string, DownloadState>()
const listeners = new Set<() => void>()

/** Snapshot for useSyncExternalStore — `set()` always stores a NEW object, so
 *  the reference is stable between updates and React can bail out correctly. */
function snapshotFor(videoId: string | undefined): DownloadState {
  if (!videoId) return IDLE
  return states.get(videoId) ?? IDLE
}

function set(videoId: string, next: DownloadState): void {
  states.set(videoId, next)
  for (const l of listeners) l()
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/** Live download state for one track (re-renders as the percentage moves). */
export function useDownloadState(videoId: string | undefined): DownloadState {
  return useSyncExternalStore(
    subscribe,
    () => snapshotFor(videoId),
    () => IDLE,
  )
}

/** Non-reactive read (event handlers, tests). */
export function downloadStateOf(videoId: string): DownloadState {
  return snapshotFor(videoId)
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

function sanitize(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'track'
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke on the next macrotask: revoking synchronously can race the
  // browser's fetch of the object URL on some engines.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** How often the UI may re-render during a transfer (chunk-burst throttle). */
const UI_TICK_MS = 180

/**
 * Start (or observe) the download of one track. Idempotent: calling it again
 * while the same track is downloading is a no-op rather than a second fetch.
 */
export async function startDownload(track: DownloadTarget): Promise<void> {
  const current = states.get(track.videoId)
  if (current?.status === 'downloading') return

  set(track.videoId, { status: 'downloading', progress: null, bytes: 0 })
  const toastId = `tsf-dl-${track.videoId}`
  toast.loading(`Downloading “${track.title}”…`, { id: toastId })

  let lastTick = 0
  try {
    const qs = new URLSearchParams({
      id: track.videoId,
      title: track.title,
      artist: track.artistName || '',
      dur: String(track.duration || 0),
    })
    const res = await fetch(`/api/download?${qs.toString()}`)
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(detail || `server returned ${res.status}`)
    }

    const total = Number(res.headers.get('content-length') || 0) || 0
    const mime = res.headers.get('content-type') || 'audio/mp4'
    const ext = mime.includes('wav') ? 'wav' : 'm4a'

    const chunks: Uint8Array[] = []
    let received = 0

    if (res.body) {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          chunks.push(value)
          received += value.byteLength
        }
        const now = Date.now()
        if (now - lastTick >= UI_TICK_MS) {
          lastTick = now
          const pct = total > 0 ? Math.min(1, received / total) : null
          set(track.videoId, { status: 'downloading', progress: pct, bytes: received })
          toast.loading(
            `Downloading “${track.title}”… ${
              pct === null ? fmtBytes(received) : `${Math.round(pct * 100)}%`
            }`,
            { id: toastId },
          )
        }
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer())
      chunks.push(buf)
      received = buf.byteLength
    }

    if (received === 0) throw new Error('the server sent no audio')

    const blob = new Blob(chunks as BlobPart[], { type: mime })
    const base = track.artistName ? `${track.artistName} - ${track.title}` : track.title
    saveBlob(blob, `${sanitize(base)}.${ext}`)

    set(track.videoId, { status: 'done', progress: 1, bytes: received })
    toast.success(`Downloaded “${track.title}” · ${fmtBytes(received)}`, { id: toastId })

    // MINDBEAT: a download is strong positive evidence (2x). Loaded lazily so
    // the download manager never drags the taste graph into every bundle.
    void import('@/lib/mindbeat/client')
      .then((m) => m.download(track.videoId))
      .catch(() => undefined)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    set(track.videoId, { status: 'error', progress: null, bytes: 0, error: msg })
    toast.error(`Download failed — ${msg}`, { id: toastId })
    // fall through — the transient state clears below either way
  } finally {
    const settle: DownloadStatus = states.get(track.videoId)?.status === 'done' ? 'done' : 'error'
    setTimeout(() => {
      if (states.get(track.videoId)?.status === settle) set(track.videoId, IDLE)
    }, settle === 'done' ? 6000 : 5000)
  }
}

/** Test hook. */
export function __resetDownloads(): void {
  states.clear()
  for (const l of listeners) l()
}
