/**
 * TSF Music — shared AI layer types.
 */

export interface ZenMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ZenCallOptions {
  /** Lower temperature = more deterministic. Default 0.4. */
  temperature?: number
  /** Cap output tokens. Default 1024. */
  maxTokens?: number
  /** Response format: 'text' (default) or 'json' (object). */
  json?: boolean
  /** AbortSignal. */
  signal?: AbortSignal
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number
}

export interface ZenResponse {
  model: string
  content: string
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}
