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
import type { SearchEarly, SearchRow, SearchSourceKey, SearchV2Final, SearchV2State } from './types'

export interface SearchV2Run {
  /** increments on every run() — the UI keys ledger/recents side-effects on it */
  gen: number
  state: SearchV2State
  run: (q: string, source: SearchSourceKey) => void
  reset: () => void
  /** F1 · infinite pagination — appends the next catalog page (deduped). */
  loadMore: () => Promise<void>
  /** F1 pagination state (mirrors the reference's honest contract). */
  more: { loading: boolean; hasMore: boolean; note: string | null; error: boolean }
}

/** A page worth <25% fresh rows ends the feed (route parity). */
const FRESH_PAGE_RATIO = 0.25

export function useSearchV2(): SearchV2Run {
  const [state, setState] = useState<SearchV2State>({ phase: 'idle' })
  const [gen, setGen] = useState(0)
  const genRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  // ---- F1 · infinite pagination state -----------------------------------
  // live mirror of the result rows (the engine's LRCLIB verify/reorder lands
  // AFTER the final event — reading a stale closure would strip lyric chips
  // on the first append; reference P1-2) + last appended page number.
  const [more, setMore] = useState<SearchV2Run['more']>({ loading: false, hasMore: false, note: null, error: false })
  const moreRef = useRef<{ page: number; loading: boolean; hasMore: boolean }>({
    page: 1,
    loading: false,
    hasMore: false,
  })
  const rowsRef = useRef<SearchRow[]>([])
  rowsRef.current = state.phase === 'ready' ? state.final?.rows ?? [] : []

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
      moreRef.current = { page: 1, loading: false, hasMore: false }
      setMore({ loading: false, hasMore: false, note: null, error: false })
      return
    }
    setState({ phase: 'loading', source })
    // fresh query → pagination resets (catalog pages can load more; youtube/vibe never)
    rowsRef.current = []
    moreRef.current = { page: 1, loading: false, hasMore: source === 'catalog' }
    setMore({ loading: false, hasMore: source === 'catalog', note: null, error: false })

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
    moreRef.current = { page: 1, loading: false, hasMore: false }
    setMore({ loading: false, hasMore: false, note: null, error: false })
  }, [])

  /**
   * F1 · append the next JioSaavn page when the sentinel scrolls into view
   * (reference v3.4.1 parity). Dedupe by id, honest-end contract (<25%
   * fresh), muted-artist parity server-side; rows are PLAYABLE saavn-<id>
   * catalog rows resolved by the stream route. Never for youtube/vibe.
   */
  const loadMore = useCallback(async (): Promise<void> => {
    const st = state
    if (st.phase !== 'ready' || moreRef.current.loading) return
    if (st.source !== 'catalog' || st.final?.vibe) return
    const q = st.final?.plan?.raw ?? ''
    if (!q) return
    const myGen = genRef.current
    moreRef.current.loading = true
    setMore((m) => ({ ...m, loading: true, note: null, error: false }))
    try {
      const seenIds = rowsRef.current.map((r) => r.id)
      const res = await fetch('/api/ytm/search-more', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, page: moreRef.current.page + 1, seenIds }),
      })
      if (genRef.current !== myGen) return // superseded by a new query
      const j = (await res.json()) as {
        rows?: SearchRow[]
        page?: number
        end?: boolean
        note?: string
        error?: boolean
      }
      if (genRef.current !== myGen) return
      if (j.error) {
        moreRef.current = { ...moreRef.current, loading: false }
        setMore((m) => ({ ...m, loading: false, error: true, note: "Couldn't load more — check your connection" }))
        return
      }
      const fresh = j.rows ?? []
      const before = rowsRef.current
      const have = new Set(before.map((r) => r.id))
      const freshRows = fresh.filter((r) => !have.has(r.id))
      const merged = [...before, ...freshRows]
      const freshRatio = fresh.length > 0 ? freshRows.length / fresh.length : 0
      const end = !!j.end || (fresh.length > 0 && freshRatio < FRESH_PAGE_RATIO)
      moreRef.current = { page: j.page ?? moreRef.current.page + 1, loading: false, hasMore: !end }
      // append into the SAME final payload (top-result hero untouched)
      setState((prev) =>
        prev.phase === 'ready' && prev.source === 'catalog'
          ? { ...prev, final: { ...prev.final, rows: merged } }
          : prev,
      )
      setMore({
        loading: false,
        hasMore: !end,
        note: end ? (j.note ?? 'End of results') : null,
        error: false,
      })
    } catch {
      if (genRef.current !== myGen) return
      moreRef.current = { ...moreRef.current, loading: false }
      setMore((m) => ({ ...m, loading: false, error: true, note: "Couldn't load more — check your connection" }))
    }
  }, [state])

  // unmount → kill the stream (and its server-side probes)
  useEffect(() => () => abortRef.current?.abort(), [])

  return { gen, state, run, reset, loadMore, more }
}
