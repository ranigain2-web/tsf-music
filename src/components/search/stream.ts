'use client'

/**
 * SEARCH V2 · transport — plain-NDJSON reader + typeahead fetcher.
 *
 * The search-v2 route streams lines of JSON: {"type":"early",…} then
 * {"type":"final",…}. Each parsed line is handed to onLine as it lands
 * (progressive paint). The request's AbortSignal is honored end-to-end —
 * aborting the fetch also kills every in-flight provider probe on the
 * server (req.signal → controller.close()).
 */

export async function streamNdjson(
  url: string,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<void> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/x-ndjson' } })
  if (!res.ok || !res.body) throw new Error(`search-v2 ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) onLine(line)
    }
  }
  if (buf.trim()) onLine(buf.trim()) // trailing line without newline
}

export async function fetchTypeahead(q: string, signal: AbortSignal): Promise<TypeaheadResponse> {
  const res = await fetch(`/api/ytm/typeahead?q=${encodeURIComponent(q)}`, { signal })
  if (!res.ok) throw new Error(`typeahead ${res.status}`)
  return (await res.json()) as TypeaheadResponse
}

import type { TypeaheadPayload } from './types'
type TypeaheadResponse = TypeaheadPayload
