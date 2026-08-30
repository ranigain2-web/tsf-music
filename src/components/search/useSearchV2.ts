'use client'

/**
 * SEARCH V2 · generation-managed streaming search hook.
 *
 * • One AbortController per generation — a new run() (per keystroke /
 *   source flip) aborts the previous fetch, whose req.signal kills the
 *   server's in-flight provider probes.
 * • Progressive paint: the 'early' NDJSON line renders rows immediately
 *   (phase 'refining'); the 'final' line swaps in the full result
 *   (phase 'ready').
 * • Never throws: a failed stream becomes phase 'ready' with an error
 *   string so the UI can render an honest failure state.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { streamNdjson } from './stream'
import type { SearchEarly, SearchSourceKey, SearchV2Final, SearchV2State } from './types'

export interface SearchV2Run {
  /** increments on every run() — the UI keys ledger/recents side-effects on it */
  gen: number
  state: SearchV2State
  run: (q: string, source: SearchSourceKey) => void
  reset: () => void
}

export function useSearchV2(): SearchV2Run {
  const [state, setState] = useState<SearchV2State>({ phase: 'idle' })
  const [gen, setGen] = useState(0)
  const genRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const run = useCallback((q: string, source: SearchSourceKey) => {
    const query = q.trim()
    genRef.current += 1
    const myGen = genRef.current
    setGen(myGen)
    abortRef.current?.abort() // kill the previous generation's stream
    const ctrl = new AbortController()
    abortRef.current = ctrl

    if (!query) {
      setState({ phase: 'idle' })
      return
    }
    setState({ phase: 'loading', source })

    const onEarly = (early: SearchEarly) => {
      if (genRef.current !== myGen || ctrl.signal.aborted) return
      setState({ phase: 'refining', source, early })
    }
    const onFinal = (result: SearchV2Final | undefined, error?: string) => {
      if (genRef.current !== myGen || ctrl.signal.aborted) return
      setState({ phase: 'ready', source, final: result ?? { rows: [] }, error })
    }

    const url = `/api/ytm/search-v2?q=${encodeURIComponent(query)}&source=${source}`
    void streamNdjson(url, ctrl.signal, (line) => {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (parsed.type === 'early') {
        onEarly(parsed as unknown as SearchEarly)
      } else if (parsed.type === 'final') {
        const f = parsed as { result?: SearchV2Final; error?: string }
        onFinal(f.result, typeof f.error === 'string' ? f.error : undefined)
      }
    }).catch((err: unknown) => {
      if (ctrl.signal.aborted || genRef.current !== myGen) return // superseded — drop
      const message = err instanceof Error ? err.message : 'search failed'
      setState({ phase: 'ready', source, final: { rows: [] }, error: message })
    })
  }, [])

  const reset = useCallback(() => {
    genRef.current += 1
    setGen(genRef.current)
    abortRef.current?.abort()
    abortRef.current = null
    setState({ phase: 'idle' })
  }, [])

  // unmount → kill the stream (and its server-side probes)
  useEffect(() => () => abortRef.current?.abort(), [])

  return { gen, state, run, reset }
}
