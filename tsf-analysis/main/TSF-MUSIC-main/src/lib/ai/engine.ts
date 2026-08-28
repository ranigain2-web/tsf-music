/**
 * TSF Music — AI engine (provider-agnostic, speed-bar-driven).
 *
 * Provider priority:
 *   1. `fast`   — local gateway (Z AI, OpenAI-compatible SSE). ~0.9s to first
 *                 token, true token-level streaming. Used automatically when
 *                 a gateway config file exists (mirrors the SDK's discovery:
 *                 ./.z-ai-config → ~/.z-ai-config → /etc/.z-ai-config).
 *   2. `gateway`— keyless public fallback with hedged model racing (zen.ts).
 *                 Works on any machine; slower (~10-40s).
 *
 * Capability is probed ONCE per process and cached, so a missing config adds
 * zero latency after the first attempt.
 *
 * Provider/model identities NEVER leave this layer in user-visible strings —
 * see sanitize.ts (Bar 2) and the health route (booleans only).
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { zenStreamChat } from './zen'
import type { ZenMessage, ZenCallOptions } from './types'
import { parseTolerantJson } from './partial'

// ---------------------------------------------------------------------------
// Fast provider: local gateway
// ---------------------------------------------------------------------------

interface GatewayConfig {
  baseUrl: string
  apiKey: string
  chatId?: string
  userId?: string
  token?: string
  model?: string
}

let gatewayProbe: { state: 'unprobed' | 'ok' | 'missing' | 'dead'; cfg?: GatewayConfig } = {
  state: 'unprobed',
}

function loadGatewayConfig(): GatewayConfig | null {
  const candidates = [
    resolve(process.cwd(), '.z-ai-config'),
    resolve(process.env.HOME ?? '~', '.z-ai-config'),
    '/etc/.z-ai-config',
  ]
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue
      const cfg = JSON.parse(readFileSync(p, 'utf-8'))
      if (cfg?.baseUrl && cfg?.apiKey) return cfg as GatewayConfig
    } catch {
      // malformed file → try next location
    }
  }
  return null
}

function gatewayHeaders(cfg: GatewayConfig): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
    'X-Z-AI-From': 'Z',
  }
  if (cfg.chatId) h['X-Chat-Id'] = cfg.chatId
  if (cfg.userId) h['X-User-Id'] = cfg.userId
  if (cfg.token) h['X-Token'] = cfg.token
  return h
}

async function gatewayStreamChat(
  messages: ZenMessage[],
  opts: ZenCallOptions & { onDelta?: (t: string) => void }
): Promise<string> {
  const cfg = gatewayProbe.cfg!
  const { temperature = 0.4, maxTokens = 1024, json = false, signal, timeoutMs = 30_000, onDelta } = opts

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true })

  const body: Record<string, unknown> = {
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
    thinking: { type: 'disabled' },
  }
  if (cfg.model) body.model = cfg.model
  if (json) body.response_format = { type: 'json_object' }

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: gatewayHeaders(cfg),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok || !res.body) {
      gatewayProbe = { state: 'dead' } // don't keep hammering a broken gateway
      throw new Error(`gateway ${res.status}`)
    }
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    let buf = ''
    let text = ''
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
          if (d.content) {
            text += d.content
            if (onDelta) onDelta(d.content)
          }
        } catch { /* skip malformed line */ }
      }
    }
    if (!text.trim()) throw new Error('gateway empty response')
    return text
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Engine API
// ---------------------------------------------------------------------------

export type AiProviderKind = 'fast' | 'gateway' | 'none'

export interface AiChatResult {
  text: string
  provider: AiProviderKind
}

/**
 * Unified streamed chat. Tries the fast local gateway first (one-time probe),
 * then the keyless public gateway with hedged model racing.
 */
export async function aiChat(
  messages: ZenMessage[],
  opts: ZenCallOptions & { onDelta?: (t: string) => void } = {}
): Promise<AiChatResult> {
  // probe once per process
  if (gatewayProbe.state === 'unprobed') {
    const cfg = loadGatewayConfig()
    gatewayProbe = cfg ? { state: 'ok', cfg } : { state: 'missing' }
  }

  if (gatewayProbe.state === 'ok' && gatewayProbe.cfg) {
    try {
      const text = await gatewayStreamChat(messages, opts)
      return { text, provider: 'fast' }
    } catch {
      // fall through to public gateway
    }
  }

  const r = await zenStreamChat(messages, opts)
  return { text: r.text, provider: 'gateway' }
}

/** Unified JSON chat: streamed under the hood, tolerant parse at the end. */
export async function aiChatJson<T = any>(
  messages: ZenMessage[],
  opts: ZenCallOptions & { onDelta?: (t: string) => void } = {}
): Promise<T | null> {
  const r = await aiChat(messages, { ...opts, json: true })
  return parseTolerantJson<T>(r.text)
}

/** Provider availability for /api/health — booleans only, no identities. */
export function aiStatus(): { provider: AiProviderKind; fastAvailable: boolean } {
  if (gatewayProbe.state === 'unprobed') {
    const cfg = loadGatewayConfig()
    gatewayProbe = cfg ? { state: 'ok', cfg } : { state: 'missing' }
  }
  return {
    provider: gatewayProbe.state === 'ok' ? 'fast' : 'gateway',
    fastAvailable: gatewayProbe.state === 'ok',
  }
}
