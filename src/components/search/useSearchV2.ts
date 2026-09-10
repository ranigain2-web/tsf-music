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
import { YT_END_NOTE, YT_RETRY_NOTE } from '@/lib/search-v2/yt-append'

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
  // ---- R8-P3 · YouTube continuation walk (gen-keyed single-flight) -------
  // The scroll sentinel + eager top-up can fire concurrently — same-gen
  // calls share ONE fetchMore; a new query never queues behind a doomed
  // walk (its results would be stale-swallowed anyway).
  const ytContRef = useRef<string | null>(null)
  const ytInflightRef = useRef<{ gen: number; p: Promise<void> } | null>(null)

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
      ytContRef.current = null
      ytInflightRef.current = null
      setMore({ loading: false, hasMore: false, note: null, error: false })
      return
    }
    setState({ phase: 'loading', source })
    // fresh query → pagination resets (catalog: JioSaavn pages; youtube:
    // continuation walk — both can load more; vibe never)
    rowsRef.current = []
    ytContRef.current = null
    ytInflightRef.current = null
    moreRef.current = { page: 1, loading: false, hasMore: source !== 'catalog' ? false : true }
    setMore({ loading: false, hasMore: source === 'catalog', note: null, error: false })

    const onEarly = (early: SearchEarly) => {
      if (genRef.current !== myGen || ctrl.signal.aborted) return
      setState({ phase: 'refining', source, early })
    }
    const onFinal = (result: SearchV2Final | undefined, error?: string) => {
      if (genRef.current !== myGen || ctrl.signal.aborted) return
      setState({ phase: 'ready', source, final: result ?? { rows: [] }, error })
      // youtube deep pagination primes here (R8-P3)
      if (source === 'youtube') {
        const cont = (result as SearchV2Final & { ytContinuation?: string | null })?.ytContinuation ?? null
        ytContRef.current = cont
        moreRef.current = { page: 1, loading: false, hasMore: !!cont }
        setMore({ loading: false, hasMore: !!cont, note: null, error: false })
      }
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
    ytContRef.current = null
    ytInflightRef.current = null
    setMore({ loading: false, hasMore: false, note: null, error: false })
  }, [])

  /**
   * Append the next page — catalog (JioSaavn pages, reference v3.4.1) or
   * youtube (InnerTube continuation walk, R8-P3 single-flight + retryable).
   * Never for vibe. YouTube transport failures keep the token + hasMore
   * (a network blip is not end-of-catalog); honest end paints YT_END_NOTE.
   */
  const loadMore = useCallback(async (): Promise<void> => {
    const st = state
    if (st.phase !== 'ready' || moreRef.current.loading) return
    if (st.final?.vibe) return
    const myGen = genRef.current

    // ── youtube continuation walk (R8-P3) ──
    if (st.source === 'youtube') {
      const inflight = ytInflightRef.current
      if (inflight && inflight.gen === myGen) return inflight.p
      const cont = ytContRef.current
      if (!cont) return
      moreRef.current.loading = true
      setMore((m) => ({ ...m, loading: true, note: null, error: false }))
      const slot: { gen: number; p: Promise<void> } = { gen: myGen, p: Promise.resolve() }
      slot.p = (async () => {
        try {
          const res = await fetch('/api/ytm/search-yt-more', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ continuation: cont }),
          })
          if (genRef.current !== myGen) return
          const j = (await res.json()) as {
            tracks?: SearchRow[]
            continuation?: string | null
            end?: boolean
            error?: boolean
          }
          if (genRef.current !== myGen) return
          if (j.error) {
            // transport failure — keep token, stay retryable
            moreRef.current = { ...moreRef.current, loading: false }
            setMore((m) => ({ ...m, loading: false, error: true, note: YT_RETRY_NOTE, hasMore: true }))
            return
          }
          const fresh = j.tracks ?? []
          const before = rowsRef.current
          const have = new Set(before.map((r) => r.id))
          const freshRows = fresh.filter((r) => !have.has(r.id))
          const merged = [...before, ...freshRows]
          ytContRef.current = j.continuation ?? null
          const hasMore = !!j.continuation && !j.end
          moreRef.current = { page: moreRef.current.page + 1, loading: false, hasMore }
          setState((prev) =>
            prev.phase === 'ready' && prev.source === 'youtube'
              ? { ...prev, final: { ...prev.final, rows: merged, ytContinuation: j.continuation ?? null } }
              : prev,
          )
          setMore({
            loading: false,
            hasMore,
            // productive append clears any stale retry note
            note: hasMore ? null : YT_END_NOTE,
            error: false,
          })
        } catch {
          if (genRef.current !== myGen) return
          moreRef.current = { ...moreRef.current, loading: false }
          setMore((m) => ({ ...m, loading: false, error: true, note: YT_RETRY_NOTE, hasMore: true }))
        } finally {
          if (ytInflightRef.current === slot) ytInflightRef.current = null
          moreRef.current.loading = false
          if (genRef.current === myGen) {
            setMore((m) => ({ ...m, loading: false }))
          }
        }
      })()
      ytInflightRef.current = slot
      return slot.p
    }

    // ── catalog (existing JioSaavn pages) ──
    if (st.source !== 'catalog') return
    const q = st.final?.plan?.raw ?? ''
    if (!q) return
    const catGen = genRef.current
    moreRef.current.loading = true
    setMore((m) => ({ ...m, loading: true, note: null, error: false }))
    try {
      const seenIds = rowsRef.current.map((r) => r.id)
      const res = await fetch('/api/ytm/search-more', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, page: moreRef.current.page + 1, seenIds }),
      })
      if (genRef.current !== catGen) return // superseded by a new query
      const j = (await res.json()) as {
        rows?: SearchRow[]
        page?: number
        end?: boolean
        note?: string
        error?: boolean
      }
      if (genRef.current !== catGen) return
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
      if (genRef.current !== catGen) return
      moreRef.current = { ...moreRef.current, loading: false }
      setMore((m) => ({ ...m, loading: false, error: true, note: "Couldn't load more — check your connection" }))
    }
  }, [state])

  // unmount → kill the stream (and its server-side probes)
  useEffect(() => () => abortRef.current?.abort(), [])

  return { gen, state, run, reset, loadMore, more }
}
