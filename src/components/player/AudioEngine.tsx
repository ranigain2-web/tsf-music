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
import {
  nativeUpdateMetadata,
  nativeUpdatePlaybackState,
  nativeStop,
  onNativeCommand,
} from '@/lib/nativeMedia'
// MINDBEAT client instrumentation (self-initializing; additive, never blocks playback)
import * as mb from '@/lib/mindbeat/client'
import { consumePendingUserSkip } from '@/store/player'

/**
 * Touch devices (phones) AND the native desktop shell stream through the
 * server (?proxy=1): same-origin bytes sidestep WebKit's cross-origin
 * 307+Range fragility (the #1 cause of mid-play stalls — WKWebView advances
 * the media timeline in silence while a starved redirect target never
 * delivers the next range) and Android WebView CORS quirks. The proxy also
 * gives every client the server's self-heal ladder (403/416 → re-sign →
 * retry) instead of leaving recovery to the audio element, which has none.
 * Plain desktop browsers keep the zero-load 307 redirect.
 */
declare global {
  interface Window { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown }
}
function streamModeParam(): string {
  if (typeof window === 'undefined') return ''
  const isNativeShell = window.__TAURI__ !== undefined || window.__TAURI_INTERNALS__ !== undefined
  const isTouch = window.matchMedia?.('(hover: none), (pointer: coarse)').matches
  if (isNativeShell || isTouch) return '&proxy=1'
  return ''
}

export function AudioEngine() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const pendingPlayRef = useRef(false)
  // One-shot cache-bust retry per track. Stale IP-bound googlevideo URLs
  // (network change mid-session) surface as audio error 2/4; we re-resolve
  // with ?fresh=1 exactly once before declaring the track dead.
  const freshRetryRef = useRef(false)
  // ---- STALL WATCHDOG (the "music stops but the timer keeps moving" fix) --
  // WebKit/WKWebView advances the media timeline while the pipeline is
  // starved: the elapsed counter climbs over silence. The watchdog samples
  // the element every second and recovers when playhead progress OR buffer
  // growth stops while `isPlaying` is asserted.
  const stallTicksRef = useRef(0)
  const lastWatchPosRef = useRef(-1)
  const stallRecoveredRef = useRef(false)
  // pending seek position for a mid-track fresh re-resolve (resume in place
  // instead of restarting from 0:00)
  const resumeAtRef = useRef<number | null>(null)
  const recoveringRef = useRef(false)
  // last listen-start wall clock + accumulated listen ms (real msPlayed for
  // history — was always recorded as 0 before)
  const listenStartRef = useRef<number | null>(null)
  const listenAccumRef = useRef(0)
  const prevVideoIdRef = useRef<string | null>(null)
  // MINDBEAT: id of the track currently loaded + the surface context it
  // STARTED with (consumed by the cleanup that emits TRACK_END/TRACK_SKIP)
  const currentTrackIdRef = useRef<string | null>(null)
  const trackCtxRef = useRef<{ id: string; ctx: mb.PlaybackContext } | null>(null)
  // last time the native playback-state was pushed (1/s throttle)
  const lastNativeStateRef = useRef(0)
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
      // native lockscreen elapsed-time refresh (throttled to 1/s)
      const now = Date.now()
      if (now - lastNativeStateRef.current > 1000) {
        lastNativeStateRef.current = now
        nativeUpdatePlaybackState({
          isPlaying: !audio.paused,
          position: audio.currentTime,
          duration: isFinite(audio.duration) ? audio.duration : 0,
        })
      }
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
      // Resume-in-place after a stall recovery: jump to where the listener
      // actually was instead of restarting the track from 0:00.
      if (resumeAtRef.current != null && isFinite(audio.duration)) {
        try { audio.currentTime = Math.min(resumeAtRef.current, Math.max(0, audio.duration - 0.5)) } catch { /* seek before data — best effort */ }
        resumeAtRef.current = null
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
      // listen-ms accounting: a fresh play run starts now (was playing →
      // keep the accumulated ms from the earlier run)
      if (listenStartRef.current == null) listenStartRef.current = Date.now()
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'
      nativeUpdatePlaybackState({
        isPlaying: true,
        position: audio.currentTime,
        duration: isFinite(audio.duration) ? audio.duration : 0,
      })
    }
    const onPause = () => {
      setIsPlaying(false)
      if (listenStartRef.current != null) {
        listenAccumRef.current += Date.now() - listenStartRef.current
        listenStartRef.current = null
      }
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'
      nativeUpdatePlaybackState({
        isPlaying: false,
        position: audio.currentTime,
        duration: isFinite(audio.duration) ? audio.duration : 0,
      })
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

    // ---- STALL WATCHDOG TICK (1 Hz) -------------------------------------
    // A stall = isPlaying asserted, element not paused, but (playhead frozen
    // AND buffer not ahead) OR readyState dropped below HAVE_FUTURE_DATA for
    // two consecutive samples. Recovery ladder: one in-place fresh
    // re-resolve per track; a second stall on the same track skips forward.
    const bufferedAhead = (el: HTMLAudioElement): number => {
      try {
        const b = el.buffered
        for (let i = 0; i < b.length; i++) {
          if (b.start(i) <= el.currentTime && el.currentTime <= b.end(i)) return b.end(i) - el.currentTime
        }
        if (b.length > 0) return b.end(b.length - 1) - el.currentTime
      } catch { /* buffered API unavailable */ }
      return 0
    }
    const recoverStall = (fromSec: number) => {
      if (recoveringRef.current) return
      recoveringRef.current = true
      const s = usePlayer.getState()
      const track = s.queue[s.queueIndex]
      if (!track) return
      setError('Reconnecting the stream…')
      const dur = track.duration && isFinite(track.duration) ? `&dur=${Math.round(track.duration)}` : ''
      const meta = `&title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artistName || '')}`
      resumeAtRef.current = fromSec > 2 ? fromSec : null
      pendingPlayRef.current = true
      audio.src = `/api/stream?id=${encodeURIComponent(track.videoId)}${dur}${meta}&fresh=1${streamModeParam()}`
      audio.load()
      const p = audio.play()
      if (p && typeof p.catch === 'function') p.catch(() => { /* retried on canplay */ })
      // recoveringRef clears once the element proves it is delivering again
      const prove = () => {
        recoveringRef.current = false
        stallTicksRef.current = 0
        audio.removeEventListener('playing', prove)
      }
      audio.addEventListener('playing', prove)
      setTimeout(() => { recoveringRef.current = false }, 15_000)
    }
    const watchTick = () => {
      const s = usePlayer.getState()
      if (!s.isPlaying || audio.paused || audio.ended) {
        stallTicksRef.current = 0
        lastWatchPosRef.current = audio.currentTime
        return
      }
      const pos = audio.currentTime
      const ahead = bufferedAhead(audio)
      const moved = Math.abs(pos - lastWatchPosRef.current)
      lastWatchPosRef.current = pos
      const starving = audio.readyState < 3 // HAVE_CURRENT_DATA or worse
      const frozen = moved < 0.04 && ahead < 0.7
      if (starving || frozen) {
        stallTicksRef.current += 1
        if (stallTicksRef.current >= 3) {
          if (!stallRecoveredRef.current) {
            stallRecoveredRef.current = true
            recoverStall(pos)
          } else if (!recoveringRef.current) {
            // already healed once and it stalled again — this stream is dead
            setError('Stream kept breaking — skipping ahead')
            s.next({ auto: true }) // engine-initiated → NOT a user skip
          }
        }
      } else {
        stallTicksRef.current = 0
      }
    }
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
      // Recover transparently: re-resolve once, bypassing the cache,
      // resuming at the position the listener was at.
      if ((code === 2 || code === 4) && !freshRetryRef.current) {
        freshRetryRef.current = true
        setError('Refreshing stream…')
        const s = usePlayer.getState()
        const track = s.queue[s.queueIndex]
        if (track) {
          const dur = track.duration && isFinite(track.duration) ? `&dur=${Math.round(track.duration)}` : ''
          const meta = `&title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artistName || '')}`
          const from = audio.currentTime
          resumeAtRef.current = from > 2 ? from : null
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
        if (s.isPlaying || s.isLoading) s.next({ auto: true }) // engine-initiated → NOT a user skip
      }, 1200)
    }
    const onEnded = () => {
      // Premature-end guard: a truncated upstream (proxy connection dropped,
      // expired URL) can end the element at 40–90% while the provider was
      // full-length. That is a stall wearing an 'ended' costume — heal it
      // instead of betraying the listener with an instant next-track jump.
      const s = usePlayer.getState()
      const track = s.queue[s.queueIndex]
      const expect = track?.duration && isFinite(track.duration) ? track.duration : 0
      const at = audio.currentTime
      const likelyTruncated = expect > 45 && at > 5 && at < expect * 0.88
      if (likelyTruncated && !stallRecoveredRef.current) {
        stallRecoveredRef.current = true
        recoverStall(at)
        return
      }
      if (s.repeat === 'one') {
        audio.currentTime = 0
        void audio.play()
      } else {
        s.next({ auto: true }) // natural end → graded TRACK_END, not TRACK_SKIP
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
    lastWatchPosRef.current = audio.currentTime
    const watchdog = window.setInterval(watchTick, 1000)

    // MINDBEAT: APP_BACKGROUND when the tab is hidden mid-session
    // (only meaningful once a track has actually started)
    const onVisForMindbeat = () => {
      if (document.visibilityState === 'hidden' && currentTrackIdRef.current) mb.appBackground()
    }
    document.addEventListener('visibilitychange', onVisForMindbeat)

    // native shell transport commands (lockscreen / headphone buttons) → store
    const offNative = onNativeCommand((action, seekTime) => {
      const s = usePlayer.getState()
      switch (action) {
        case 'play':
          s.setIsPlaying(true)
          break
        case 'pause':
          s.setIsPlaying(false)
          break
        case 'toggle':
          s.setIsPlaying(!s.isPlaying)
          break
        case 'next':
          s.next()
          break
        case 'previous':
          s.prev()
          break
        case 'stop':
          s.setIsPlaying(false)
          break
        case 'seekto':
          if (typeof seekTime === 'number' && isFinite(seekTime)) seekTo(seekTime)
          break
        case 'seekby':
          // signed delta from native menu/dock/tray ("Seek Back/Forward 10s")
          if (typeof seekTime === 'number' && isFinite(seekTime) && seekTime !== 0) {
            seekTo(Math.max(0, usePlayer.getState().position + seekTime))
          }
          break
        case 'volume':
          // souvlaki SetVolume (system media UI) → store volume (0..1 clamped in store)
          if (typeof seekTime === 'number' && isFinite(seekTime)) usePlayer.getState().setVolume(seekTime)
          break
        case 'voldelta':
          // native menu Volume Up/Down — signed delta around current volume
          if (typeof seekTime === 'number' && isFinite(seekTime) && seekTime !== 0) {
            const s = usePlayer.getState()
            s.setVolume(s.volume + seekTime)
          }
          break
        default:
          break
      }
    })

    return () => {
      window.clearInterval(watchdog)
      document.removeEventListener('visibilitychange', onVisForMindbeat)
      mb.stopHeartbeats()
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
      offNative()
      nativeStop()
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

    prevVideoIdRef.current = track.videoId

    // MINDBEAT: resolve the surface context for THIS track up front so the
    // cleanup below can grade the leaving track with the context it started
    // with (rec-source stamps win over the module playback context).
    const startCtx = mb.resolveTrackContext(track.videoId)
    trackCtxRef.current = { id: track.videoId, ctx: startCtx }
    currentTrackIdRef.current = track.videoId

    usePlayer.getState().setLoading(true)
    usePlayer.getState().setError(null)

    // Setting src aborts any in-flight play(); remember the intent so
    // we can retry when bytes arrive.
    pendingPlayRef.current = usePlayer.getState().isPlaying
    freshRetryRef.current = false // new track → retry budget restored
    stallRecoveredRef.current = false // new track → one stall-heal budget
    stallTicksRef.current = 0
    recoveringRef.current = false
    resumeAtRef.current = null
    listenStartRef.current = usePlayer.getState().isPlaying ? Date.now() : null
    listenAccumRef.current = 0
    setMediaSession(track)
    nativeUpdateMetadata(track)

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

    // MINDBEAT: TRACK_START for the new track + the 10s heartbeat loop
    // (heartbeats fire only while playing — the getter returns null when paused).
    mb.trackStart(
      { videoId: track.videoId, artistId: track.artistId, artistName: track.artistName },
      {
        surface: startCtx.surface,
        wasRecommended: startCtx.wasRecommended,
        reasonCode: startCtx.reasonCode,
        queuePosition: queueIndex,
        duration: track.duration && isFinite(track.duration) && track.duration > 0 ? track.duration : undefined,
      }
    )
    mb.startHeartbeats(
      () => (usePlayer.getState().isPlaying ? currentTrackIdRef.current : null),
      () => listenAccumRef.current + (listenStartRef.current != null ? Date.now() - listenStartRef.current : 0)
    )

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

    // Flush the PREVIOUS track's real listened-ms into history (was always
    // recorded as 0 — the number every downstream "how much did you play"
    // feature needs). Runs on track change AND on unmount.
    //
    // READ THE REF, NOT A CLOSURE: React runs this cleanup BEFORE the next
    // effect body advances prevVideoIdRef, so the ref IS the leaving track —
    // a closure captured at body start is null for the first track after
    // mount and loses that track's end event entirely (verified live).
    return () => {
      const leavingId = prevVideoIdRef.current
      const stNow = usePlayer.getState()
      const continuing = stNow.queue[stNow.queueIndex]
      // Queue mutated but the SAME track keeps playing (smart-shuffle
      // augmentation, queue reorder) — nothing is leaving, don't flush.
      if (continuing && continuing.videoId === leavingId) return
      if (leavingId) {
        const ms = listenAccumRef.current + (listenStartRef.current != null ? Date.now() - listenStartRef.current : 0)
        listenAccumRef.current = 0
        listenStartRef.current = usePlayer.getState().isPlaying ? Date.now() : null
        const at = audio.currentTime
        const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
        // MINDBEAT: grade the leaving listen (TRACK_SKIP when notifyUserSkip()
        // just fired — i.e. the user pressed next/prev). Additive to the
        // history PATCH below; never blocks it.
        if (ms > 250) {
          const endCtx =
            trackCtxRef.current && trackCtxRef.current.id === leavingId
              ? trackCtxRef.current.ctx
              : mb.getPlaybackContext()
          // duration fallback chain: element → store track duration (synth
          // streams can end without finite element metadata)
          const st = usePlayer.getState()
          const stTrack = st.queue[st.queueIndex]
          const stLeaving = st.queue.find((t) => t.videoId === leavingId)
          const durSec = dur > 0 ? dur : (stLeaving?.duration || stTrack?.duration || 0)
          const durMs = durSec > 0 ? Math.round(durSec * 1000) : 0
          const completionRatio = durMs > 0 ? Math.min(1, ms / durMs) : 0
          // The store-carried flag (set synchronously inside next/prev's
          // user path) is the reliable user-skip signal; the module flag is
          // the fallback for any path that only had the lazy import.
          const userSkip = consumePendingUserSkip()
          mb.trackEnd(leavingId, {
            listenedMs: Math.round(ms),
            durationMs: durMs,
            grade: mb.gradeOf(ms, durMs),
            completionRatio,
            skipBucket: mb.skipBucketOf(completionRatio),
            wasRecommended: endCtx.wasRecommended,
            reasonCode: endCtx.reasonCode,
            surface: endCtx.surface,
            forceType: userSkip ? 'TRACK_SKIP' : undefined,
          })
        }
        if (ms > 1500) {
          try {
            const body = JSON.stringify({ videoId: leavingId, msPlayed: Math.round(ms), completed: dur > 0 && at >= dur * 0.9, lastPosition: Math.round(at) })
            // PATCH (not sendBeacon — beacon always POSTs and would create a
            // second history row). keepalive survives page unload.
            fetch('/api/library/history', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {})
          } catch { /* non-fatal */ }
        }
      }
    }
  }, [queueIndex, queueVersion])

  // ---- Deep Warm: idle background full-length upgrades ----
  // When a track has been playing steadily for 10s, offer the server the
  // current + next few queue ids. Tracks cached as 30s previews/synth get a
  // full provider re-race (yt-dlp + POT hero path) so the NEXT play is
  // full-length. Server-side guards (in-flight set, 20s batch gap) make
  // repeat calls cheap no-ops.
  const deepWarmDoneRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isPlaying) return
    const { queue, queueIndex } = usePlayer.getState()
    const cur = queue[queueIndex]
    if (!cur) return
    if (deepWarmDoneRef.current === cur.videoId) return
    const timer = setTimeout(() => {
      const { queue: q, queueIndex: qi } = usePlayer.getState()
      const upcoming = q.slice(qi, qi + 6)
      if (!upcoming.length) return
      deepWarmDoneRef.current = upcoming[0].videoId
      const meta: Record<string, { title?: string; artist?: string; durationSec?: number }> = {}
      for (const t of upcoming) {
        meta[t.videoId] = {
          title: t.title,
          artist: t.artistName || undefined,
          durationSec: t.duration && isFinite(t.duration) ? Math.round(t.duration) : 0,
        }
      }
      fetch('/api/stream/warm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: upcoming.map((t) => t.videoId), meta }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { warmed?: Array<{ id: string; provider: string; full: boolean }> } | null) => {
          const upgraded = (j?.warmed || []).filter((w) => w.full).length
          if (upgraded > 0) {
            // Upcoming tracks just became full-length in cache — refresh the
            // prefetch pool so next-track handoff uses the upgraded URLs.
            try {
              const prefetch = (window as unknown as { __tsfPrefetch?: Map<string, unknown> }).__tsfPrefetch
              prefetch?.clear?.()
            } catch { /* optional hook only */ }
          }
        })
        .catch(() => {})
    }, 10_000)
    return () => clearTimeout(timer)
  }, [isPlaying, queueIndex, queueVersion])

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
  // MINDBEAT: TRACK_SEEK (throttled to 1 per 2s inside the client module)
  try {
    const s = usePlayer.getState()
    const tid = s.queueIndex >= 0 ? s.queue[s.queueIndex]?.videoId : undefined
    if (tid) mb.seek(tid, Math.round((s.position || 0) * 1000), Math.round(sec * 1000))
  } catch { /* instrumentation only */ }
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
