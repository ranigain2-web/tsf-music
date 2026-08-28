'use client'

/**
 * TSF Music — Audio engine (HARDENED v2)
 *
 * PROBLEMS THIS REWRITE FIXES:
 *   1. Music not playing at all — `audio.play()` was called IMMEDIATELY after
 *      `audio.src = ...` + `audio.load()`, before any bytes were buffered.
 *      The play() promise rejected with AbortError ("The play() request was
 *      interrupted by a new load request"), which our catch handler then
 *      mis-interpreted as "autoplay blocked" and set isPlaying=false. The
 *      store therefore showed the Play icon again — so even after the audio
 *      HAD loaded, the user saw a paused UI.
 *
 *   2. Duration showing 0:00 in mini-player while fullscreen showed 0:14 —
 *      the duration fallback logic was inconsistent. Now both bars use the
 *      same effectiveDuration = audio.duration || track.duration.
 *
 *   3. Stream resolution slow (8.7s in dev log) — when all InnerTube/Piped/
 *      Invidious providers fail, the chain took up to 60s to fall back to
 *      demo-tone. We now fail-fast: 3s timeout per provider, and we render
 *      a tiny silent pre-buffer so the audio element fires `loadedmetadata`
 *      immediately and the UI never looks frozen.
 *
 * STRATEGY:
 *   - Use a real React `<audio>` element via JSX (not `new Audio()`) so the
 *     DOM lifecycle is React-managed and StrictMode remount works cleanly.
 *   - On track change: set src, call load(), then ATTEMPT play(). If play()
 *     rejects with AbortError, set a "pendingPlay" flag and retry when the
 *     `canplay' event fires.
 *   - Never set isPlaying=false on AbortError — only on NotAllowedError
 *     (genuine autoplay block) or real fetch errors.
 */

import { useEffect, useRef } from 'react'
import { usePlayer } from '@/store/player'
import { setAudioHandle } from '@/store/audio'

/**
 * Touch devices (phones) stream through the Mac server (?proxy=1):
 * same-origin bytes sidestep WebKit's cross-origin 307+Range fragility and
 * Android WebView CORS quirks. Desktop keeps the zero-load 307 redirect.
 */
function streamModeParam(): string {
  if (typeof window !== 'undefined' && window.matchMedia?.('(hover: none), (pointer: coarse)').matches) {
    return '&proxy=1'
  }
  return ''
}

export function AudioEngine() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const pendingPlayRef = useRef(false)
  // One-shot cache-bust retry per track. Stale IP-bound googlevideo URLs
  // (network change mid-session) surface as audio error 2/4; we re-resolve
  // with ?fresh=1 exactly once before declaring the track dead.
  const freshRetryRef = useRef(false)
  // ---- SponsorBlock "straight to the music" (Musify-ported) ----
  // Community-curated non-music segments (intros/outros/sponsor plugs) for
  // the CURRENT track. Empty for most studio recordings; when present the
  // timeupdate handler hops the playhead straight over them.
  const skipSegmentsRef = useRef<Array<{ start: number; end: number; category: string }>>([])
  const skipEnabled = () => {
    try {
      return localStorage.getItem('tsf-skip-segments') !== 'off'
    } catch {
      return true
    }
  }

  // ---- store subscriptions (select narrowly to avoid re-renders) ----
  const queueIndex = usePlayer((s) => s.queueIndex)
  const queueVersion = usePlayer((s) => s.queue) // identity changes on queue mutation
  const isPlaying = usePlayer((s) => s.isPlaying)
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)

  // ---- wire up the <audio> element to the store + Media Session ----
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    setAudioHandle({ audio })

    const setPosition = usePlayer.getState().setPosition
    const setDuration = usePlayer.getState().setDuration
    const setIsPlaying = usePlayer.getState().setIsPlaying
    const setLoading = usePlayer.getState().setLoading
    const setStreamProvider = usePlayer.getState().setStreamProvider
    const setError = usePlayer.getState().setError

    const onTimeUpdate = () => {
      // ---- SponsorBlock auto-skip ----
      // If the playhead enters a non-music segment (intro/outro/sponsor
      // plug), hop straight to its end. Seeks are local and instant — the
      // listener hears the music flow without the non-music part.
      if (skipSegmentsRef.current.length > 0) {
        const t = audio.currentTime
        for (const seg of skipSegmentsRef.current) {
          if (t >= seg.start && t < seg.end - 0.15) {
            try {
              audio.currentTime = seg.end
            } catch { /* seek not ready — try again next tick */ }
            break
          }
        }
      }
      setPosition(audio.currentTime)
      updateMediaPositionState(audio)
    }
    const onDurationChange = () => {
      if (isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration)
        updateMediaPositionState(audio)
      }
    }
    const onLoadedMeta = () => {
      setLoading(false)
      if (isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration)
      }
      // If a play request was pending (waiting for bytes), fire it now.
      if (pendingPlayRef.current) {
        pendingPlayRef.current = false
        const p = audio.play()
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            const name = (err && err.name) || ''
            // Only reset on genuine autoplay block — NOT on AbortError
            if (name === 'NotAllowedError') {
              usePlayer.getState().setIsPlaying(false)
            }
            // AbortError: ignore; will retry on next canplay
          })
        }
      }
    }
    const onCanPlay = () => {
      setLoading(false)
      // Retry pending play when enough has buffered.
      if (pendingPlayRef.current) {
        pendingPlayRef.current = false
        const p = audio.play()
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            const name = (err && err.name) || ''
            if (name === 'NotAllowedError') {
              usePlayer.getState().setIsPlaying(false)
            }
          })
        }
      }
    }
    const onPlay = () => {
      setIsPlaying(true)
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'
    }
    const onPause = () => {
      setIsPlaying(false)
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'
    }
    const onPlaying = () => {
      setLoading(false)
      setError(null)
      // re-apply volume in case browser reset on track switch
      const s = usePlayer.getState()
      audio.volume = s.muted ? 0 : s.volume
      audio.muted = s.muted
    }
    const onWaiting = () => setLoading(true)
    const onStalled = () => setLoading(true)
    const onVolumeChange = () => {
      if (!usePlayer.getState().muted && Math.abs(usePlayer.getState().volume - audio.volume) > 0.01) {
        usePlayer.setState({ volume: audio.volume })
      }
    }
    const onError = () => {
      setLoading(false)
      const code = audio.error?.code || 0
      // 1=ABORTED 2=NETWORK_ERROR 3=DECODE_ERROR 4=SRC_NOT_SUPPORTED.
      // Codes 2/4 are the signature of a dead/expired redirect target
      // (e.g. IP-bound googlevideo URL cached before a network change).
      // Recover transparently: re-resolve once, bypassing the cache.
      if ((code === 2 || code === 4) && !freshRetryRef.current) {
        freshRetryRef.current = true
        setError('Refreshing stream…')
        const s = usePlayer.getState()
        const track = s.queue[s.queueIndex]
        if (track) {
          const dur = track.duration && isFinite(track.duration) ? `&dur=${Math.round(track.duration)}` : ''
          const meta = `&title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artistName || '')}`
          audio.src = `/api/stream?id=${encodeURIComponent(track.videoId)}${dur}${meta}&fresh=1${streamModeParam()}`
          audio.load()
          if (s.isPlaying || pendingPlayRef.current) {
            pendingPlayRef.current = true
            const p = audio.play()
            if (p && typeof p.catch === 'function') p.catch(() => { /* retried on canplay */ })
          }
          return
        }
      }
      setError(`Playback failed (code ${code}) — trying next track`)
      // auto-skip after a short delay on stream failure
      setTimeout(() => {
        const s = usePlayer.getState()
        if (s.isPlaying || s.isLoading) s.next()
      }, 1200)
    }
    const onEnded = () => {
      const { repeat } = usePlayer.getState()
      if (repeat === 'one') {
        audio.currentTime = 0
        void audio.play()
      } else {
        usePlayer.getState().next()
      }
    }

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('durationchange', onDurationChange)
    audio.addEventListener('loadedmetadata', onLoadedMeta)
    audio.addEventListener('canplay', onCanPlay)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('stalled', onStalled)
    audio.addEventListener('volumechange', onVolumeChange)
    audio.addEventListener('error', onError)
    audio.addEventListener('ended', onEnded)

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('durationchange', onDurationChange)
      audio.removeEventListener('loadedmetadata', onLoadedMeta)
      audio.removeEventListener('canplay', onCanPlay)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('stalled', onStalled)
      audio.removeEventListener('volumechange', onVolumeChange)
      audio.removeEventListener('error', onError)
      audio.removeEventListener('ended', onEnded)
      setAudioHandle(null)
    }
  }, [])

  // ---- load the current track whenever queueIndex / queue changes ----
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const { queue, queueIndex } = usePlayer.getState()
    const track = queue[queueIndex]
    if (!track) return

    usePlayer.getState().setLoading(true)
    usePlayer.getState().setError(null)

    // Setting src aborts any in-flight play(); remember the intent so
    // we can retry when bytes arrive.
    pendingPlayRef.current = usePlayer.getState().isPlaying
    freshRetryRef.current = false // new track → retry budget restored
    setMediaSession(track)

    // ---- SponsorBlock: fetch this track's non-music segments ----
    // Fire-and-forget in the background — playback starts regardless; if
    // segments arrive after the intro already started we still catch the
    // outro. Failures degrade to "no skipping" (never blocks playback).
    skipSegmentsRef.current = []
    if (skipEnabled() && track.videoId) {
      const sbDur = track.duration && isFinite(track.duration) ? `&dur=${Math.round(track.duration)}` : ''
      fetch(`/api/sponsorblock?id=${encodeURIComponent(track.videoId)}${sbDur}`)
        .then((r) => (r.ok ? r.json() : { segments: [] }))
        .then((j: { segments?: Array<{ start: number; end: number; category: string }> }) => {
          if (Array.isArray(j.segments)) skipSegmentsRef.current = j.segments
        })
        .catch(() => {})
    }
    // dur → the synth fallback renders the track's REAL length
    // title/artist → lets the resolver find the REAL recording on Apple's
    // catalog (iTunes preview provider) instead of falling to synth.
    const dur = track.duration && isFinite(track.duration) ? `&dur=${Math.round(track.duration)}` : ''
    const meta = `&title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artistName || '')}`
    audio.src = `/api/stream?id=${encodeURIComponent(track.videoId)}${dur}${meta}${streamModeParam()}`
    audio.load()

    // Optimistically call play() — most browsers will queue it. If the
    // promise rejects with AbortError (because load() interrupted), our
    // canplay/loadedmetadata handler will retry.
    if (usePlayer.getState().isPlaying) {
      const p = audio.play()
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          const name = (err && err.name) || ''
          if (name === 'NotAllowedError') {
            // genuine autoplay block — needs user gesture
            usePlayer.getState().setIsPlaying(false)
            pendingPlayRef.current = false
          } else if (name === 'AbortError') {
            // expected — will retry when canplay fires
            pendingPlayRef.current = true
          }
          // else: unknown — leave it for the error event
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueIndex, queueVersion])

  // ---- play / pause (toggle from UI) ----
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) {
      // If src just changed, canplay will fire and pick up the play.
      // Otherwise just play directly.
      if (audio.readyState >= 2) {
        // HAVE_CURRENT_DATA or better — safe to play
        const p = audio.play()
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            const name = (err && err.name) || ''
            if (name === 'NotAllowedError') {
              usePlayer.getState().setIsPlaying(false)
            } else if (name === 'AbortError') {
              pendingPlayRef.current = true
            }
          })
        }
      } else {
        // Not ready yet — defer until canplay
        pendingPlayRef.current = true
      }
    } else {
      pendingPlayRef.current = false
      audio.pause()
    }
  }, [isPlaying])

  // ---- volume ----
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = muted ? 0 : volume
    audio.muted = muted
  }, [volume, muted])

  // ---- read stream provider header via HEAD preflight on track change ----
  // We do a HEAD request to learn the provider; the audio element itself uses
  // native HTTP and bypasses fetch, so we can't intercept it any other way.
  // This ALSO warms the server-side resolve cache so the subsequent GET is fast.
  useEffect(() => {
    const track = usePlayer.getState().queue[queueIndex]
    if (!track) return
    let cancelled = false
    const dur = track.duration && isFinite(track.duration) ? `&dur=${Math.round(track.duration)}` : ''
    const meta = `&title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artistName || '')}`
    // Reset per-track stream meta so nothing bleeds across transitions.
    usePlayer.getState().setStreamProvider('')
    fetch(`/api/stream?id=${encodeURIComponent(track.videoId)}${dur}${meta}`, { method: 'HEAD' })
      .then((r) => {
        if (cancelled) return
        const prov = r.headers.get('x-stream-provider')
        if (prov) usePlayer.getState().setStreamProvider(prov)
        const bitrate = parseInt(r.headers.get('x-stream-bitrate') || '', 10)
        const art = r.headers.get('x-stream-art') || ''
        usePlayer.getState().setStreamMeta({
          bitrate: Number.isFinite(bitrate) ? bitrate : 0,
          artUrl: art || undefined,
        })
      })
      .catch(() => {})

    // Prefetch the next 3 tracks (staggered 120ms so we don't burst every
    // upstream provider at once — circuit-breaker friendly). Warms the
    // resolve cache + memory LRU so skipping ahead is ~0ms tap-to-sound.
    const PREFETCH_DEPTH = 3
    const { queue } = usePlayer.getState()
    for (let d = 1; d <= PREFETCH_DEPTH; d++) {
      const upcoming = queue[queueIndex + d]
      if (!upcoming) break
      setTimeout(() => {
        if (cancelled) return
        const udur = upcoming.duration && isFinite(upcoming.duration) ? `&dur=${Math.round(upcoming.duration)}` : ''
        const umeta = `&title=${encodeURIComponent(upcoming.title)}&artist=${encodeURIComponent(upcoming.artistName || '')}`
        fetch(`/api/stream?id=${encodeURIComponent(upcoming.videoId)}${udur}${umeta}`, { method: 'HEAD' }).catch(() => {})
      }, (d - 1) * 120)
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueIndex, queueVersion])

  return (
    <audio
      ref={audioRef}
      /* metadata (not auto): iOS Safari's first-tap play works reliably and
         the phone doesn't prefetch megabytes for rows scrolling past view */
      preload="metadata"
      playsInline
      aria-hidden="true"
      style={{ position: 'fixed', left: '-9999px', top: '-9999px', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
    />
  )
}

/**
 * Lock-screen / notification scrubber accuracy (iOS 15.4+, Chrome Android).
 * Without setPositionState the OS shows no elapsed time or a wrong one.
 * Guarded: Chrome throws if duration is Infinity/NaN or position > duration.
 */
function updateMediaPositionState(audio: HTMLAudioElement) {
  if (typeof navigator === 'undefined' || !navigator.mediaSession?.setPositionState) return
 const d = audio.duration
  if (!isFinite(d) || d <= 0) return
  const p = Math.min(Math.max(audio.currentTime, 0), d)
  try {
    navigator.mediaSession.setPositionState({ duration: d, position: p, playbackRate: audio.playbackRate || 1 })
  } catch { /* invalid state — ignore */ }
}

export function seekTo(sec: number) {
  import('@/store/audio').then((m) => m.seekTo(sec))
}

function setMediaSession(track: { title: string; artistName: string; thumbnail: string; albumName?: string }) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artistName,
    album: track.albumName || 'TSF Music',
    artwork: [
      { src: track.thumbnail, sizes: '96x96', type: 'image/jpeg' },
      { src: track.thumbnail, sizes: '256x256', type: 'image/jpeg' },
      { src: track.thumbnail, sizes: '512x512', type: 'image/jpeg' },
    ],
  })
  if (navigator.mediaSession.playbackState !== undefined) {
    navigator.mediaSession.playbackState = usePlayer.getState().isPlaying ? 'playing' : 'paused'
  }

  const ms = navigator.mediaSession
  ms.setActionHandler('play', () => usePlayer.getState().setIsPlaying(true))
  ms.setActionHandler('pause', () => usePlayer.getState().setIsPlaying(false))
  ms.setActionHandler('previoustrack', () => usePlayer.getState().prev())
  ms.setActionHandler('nexttrack', () => usePlayer.getState().next())
  ms.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) seekTo(details.seekTime)
  })
  try {
    ms.setActionHandler('seekbackward', (details) => {
      const s = usePlayer.getState()
      seekTo(Math.max(0, s.position - (details.seekOffset || 10)))
    })
    ms.setActionHandler('seekforward', (details) => {
      const s = usePlayer.getState()
      seekTo(s.position + (details.seekOffset || 10))
    })
  } catch { /* not supported */ }
}
