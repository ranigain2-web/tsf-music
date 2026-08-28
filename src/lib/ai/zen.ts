/**
 * TSF Music — fallback LLM provider (keyless public gateway).
 *
 * Upgraded for the Phase-2 speed bar:
 *  - TRUE token streaming (`stream: true`, SSE deltas)
 *  - HEDGED RACING: fire the viable models concurrently; the first one to
 *    produce real CONTENT wins, the losers are aborted. The gateway is free,
 *    so duplicate requests cost nothing — latency is the only currency.
 *  - Reads BOTH `delta.content` and `delta.reasoning_content` (reasoning
 *    models stream chain-of-thought first; we only forward content, and
 *    fall back to reasoning text at the end if content never arrived).
 *
 * This provider needs no credentials, so it works on any machine (the user's
 * Mac included) — but it is the SLOW path. The fast path (engine.ts) is used
 * whenever a local gateway config exists.
 */

import type { ZenMessage, ZenCallOptions, ZenResponse } from './types'

const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'
const ZEN_TIMEOUT_MS = 30_000

// Viability-ranked chain (2026-08-27 bench, realistic compact-JSON prompt):
//   nemotron-3-ultra-free  → only model that returned valid content JSON
//   hy3-free               → works but streams long reasoning first
//   mimo-v2.5-free         → intermittent
// Dead endpoints (401/403) are excluded; they burn hedge slots for nothing.
const HEDGE_CHAIN = ['nemotron-3-ultra-free', 'hy3-free', 'mimo-v2.5-free']

export interface ZenStreamHandle {
  text: string
  provider: 'zen'
  model: string
}

interface HedgeCandidate {
  model: string
  ctrl: AbortController
  content: string
  reasoning: string
  won: boolean
  failed: boolean
  firstContentAt: number | null
}

/**
 * Streamed chat against the fallback gateway with model hedging.
 * `onDelta` receives content increments as they arrive (post-race only).
 */
export async function zenStreamChat(
  messages: ZenMessage[],
  opts: ZenCallOptions & { onDelta?: (t: string) => void } = {}
): Promise<ZenStreamHandle> {
  const {
    temperature = 0.4,
    maxTokens = 1024,
    json = false,
    signal,
    timeoutMs = ZEN_TIMEOUT_MS,
    onDelta,
  } = opts

  const t0 = Date.now()
  const candidates: HedgeCandidate[] = HEDGE_CHAIN.map((model) => ({
    model,
    ctrl: new AbortController(),
    content: '',
    reasoning: '',
    won: false,
    failed: false,
    firstContentAt: null,
  }))

  // outer abort propagates to all candidates
  if (signal) {
    signal.addEventListener('abort', () => {
      for (const c of candidates) c.ctrl.abort()
    }, { once: true })
  }

  let lastErr: unknown = null

  const pump = async (c: HedgeCandidate) => {
    const timer = setTimeout(() => c.ctrl.abort(), timeoutMs)
    try {
      const body: Record<string, unknown> = {
        model: c.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
      }
      if (json) body.response_format = { type: 'json_object' }

      const res = await fetch(`${ZEN_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'opencode/1.18.18',
        },
        body: JSON.stringify(body),
        signal: c.ctrl.signal,
      })
      if (!res.ok || !res.body) {
        c.failed = true
        lastErr = new Error(`gateway ${res.status}`)
        return
      }
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const j = JSON.parse(payload)
            const d = j.choices?.[0]?.delta ?? {}
            if (d.reasoning_content) c.reasoning += d.reasoning_content
            if (d.content) {
              c.content += d.content
              if (c.firstContentAt === null) c.firstContentAt = Date.now() - t0
              if (c.won && onDelta) onDelta(d.content)
            }
          } catch { /* skip malformed line */ }
        }
      }
      if (!c.content && !c.reasoning) c.failed = true
    } catch (e) {
      c.failed = true
      lastErr = e
    } finally {
      clearTimeout(timer)
    }
  }

  const races = candidates.map((c) => pump(c))

  // Arbiter: as soon as one candidate produces content, crown it and abort the rest.
  const arbiter = (async () => {
    for (;;) {
      const winner = candidates.find((c) => !c.failed && !c.won && c.firstContentAt !== null)
      if (winner) {
        for (const c of candidates) {
          if (c !== winner && !c.failed) c.ctrl.abort()
          c.won = c === winner
        }
        return
      }
      if (candidates.every((c) => c.failed || c.won)) return
      // all still pending with no content → keep waiting
      await new Promise((r) => setTimeout(r, 40))
    }
  })()

  await Promise.allSettled([arbiter, ...races])

  const winner = candidates.find((c) => c.won && (c.content || c.reasoning))
    ?? candidates.filter((c) => c.content || c.reasoning).sort((a, b) => (a.firstContentAt ?? 9e9) - (b.firstContentAt ?? 9e9))[0]

  if (!winner) {
    throw new Error(`gateway: all hedged models failed — ${lastErr instanceof Error ? lastErr.message : 'unknown'}`)
  }

  // If the winner streamed content while arbiter crowned it late, the early
  // deltas were buffered but not forwarded. Callers that need every delta
  // should rely on the returned text; onDelta is best-effort for liveness.
  const text = winner.content || winner.reasoning
  return { text, provider: 'zen', model: winner.model }
}

/** Back-compat non-streaming JSON helper (kept for any legacy callers). */
export async function zenJson<T = any>(
  messages: ZenMessage[],
  opts: ZenCallOptions = {}
): Promise<T | null> {
  try {
    const r = await zenStreamChat(messages, { ...opts, json: true })
    const cleaned = r.text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()
    return JSON.parse(cleaned) as T
  } catch {
    return null
  }
}

/** Kept for /api/health introspection. */
export function getZenChain(): string[] {
  return [...HEDGE_CHAIN]
}

export type { ZenMessage, ZenCallOptions, ZenResponse }
