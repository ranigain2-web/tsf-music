'use client'

/**
 * TSF Music — screen Wake Lock.
 *
 * Requests the Web Wake Lock API while `active` is true (lyrics open +
 * playing — like Spotify, which keeps the screen alive while lyrics show).
 * Silently re-acquires across visibilitychange (the API auto-releases when
 * the tab/app is backgrounded) and no-ops where unsupported (iOS Safari
 * < 16.4 / insecure contexts).
 */

import { useEffect, useRef } from 'react'

type Sentinel = {
  release: () => Promise<void>
  released?: boolean
  addEventListener?: (type: string, listener: () => void) => void
}

export function useWakeLock(active: boolean): void {
  const sentinelRef = useRef<Sentinel | null>(null)

  useEffect(() => {
    let cancelled = false

    const supported =
      typeof navigator !== 'undefined' &&
      'wakeLock' in navigator &&
      typeof navigator.wakeLock?.request === 'function'

    async function acquire() {
      if (!supported || cancelled || sentinelRef.current) return
      try {
        const s = (await navigator.wakeLock.request('screen')) as Sentinel
        if (cancelled) {
          void s.release().catch(() => {})
          return
        }
        sentinelRef.current = s
        s.addEventListener?.('release', () => {
          if (sentinelRef.current === s) sentinelRef.current = null
        })
      } catch {
        /* denied or unsupported — non-fatal */
      }
    }

    async function release() {
      const s = sentinelRef.current
      sentinelRef.current = null
      try {
        await s?.release()
      } catch {
        /* already released */
      }
    }

    const onVisibility = () => {
      // the browser drops the lock whenever the page hides — re-request
      if (document.visibilityState === 'visible' && sentinelRef.current === null) {
        void acquire()
      }
    }

    if (active) {
      void acquire()
      document.addEventListener('visibilitychange', onVisibility)
    } else {
      void release()
    }

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      void release()
    }
  }, [active])
}
