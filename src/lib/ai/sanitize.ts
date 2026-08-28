/**
 * TSF Music — AI output purity layer.
 *
 * Guarantees that NOTHING the LLM says about itself (provider names, model
 * identifiers, meta-commentary) can ever reach the UI. Real Spotify never
 * shows model internals; neither do we.
 *
 * Bar 2: "Zero LLM leakage" — enforced at the boundary between the AI layer
 * and any user-visible string.
 */

/**
 * Patterns that must never appear in user-visible AI text. Targeted at
 * provider/model identifiers and self-referential AI phrases — deliberately
 * NOT a blanket word ban (a playlist titled "Zen Garden" must survive).
 */
const LEAK_PATTERNS: RegExp[] = [
  // provider / product names with optional model suffixes
  /\bopencode\b(?:\s*zen)?/gi,
  /\bopen\s*code\b(?:\s*zen)?/gi,
  /\b(?:glm|hy3|nemotron|mimo|muse[\s-]?spark|sonnet|opus|haiku|qwen|deepseek|llama|grok)[-.\w]*\b/gi,
  /\b(?:claude|gemini|chatgpt|gpt[-\w]*)\b/gi,
  // self-referential attribution phrases
  /\b(?:powered|curated|generated|created|built)\s+(?:by|via|using|with)\s+(?:zen|glm|ai\s+model|an?\s+ai|openai|anthropic|opencode)\b/gi,
  /\bai\s+(?:language\s+)?model\b/gi,
  /\bas\s+an\s+ai\b/gi,
  /\btsf\s+ai\b\s*(?:zen|glm)?/gi,
]

/** Provider/model strings that may appear in structured fields (hard strip). */
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{2,40}$/i

export function sanitizeUserText(input: string | null | undefined, maxLen = 120): string {
  if (!input) return ''
  let s = String(input)
  // strip markdown fences / stray backticks
  s = s.replace(/```[a-z]*\n?/gi, ' ').replace(/`+/g, "'")
  // strip control chars except newline/space
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  // apply leak patterns
  for (const re of LEAK_PATTERNS) s = s.replace(re, ' ')
  // collapse whitespace
  s = s.replace(/\s+/g, ' ').trim()
  // strip leading filler
  s = s.replace(/^(?:sure|here(?:'s| is)|certainly|okay|ok)[,.!:]\s*/i, '')
  return s.slice(0, maxLen).trim()
}

/** Strip model-identifier-looking strings from a field that must be human text. */
export function stripModelIds(input: string | null | undefined): string {
  if (!input) return ''
  return input
    .split(/\s+/)
    .filter((w) => !MODEL_ID_RE.test(w) || w.length < 4)
    .join(' ')
}

/** True if the string STILL contains leak markers after sanitizing (for tests). */
export function hasLeakMarkers(input: string): boolean {
  const cleaned = sanitizeUserText(input, 10000)
  return LEAK_PATTERNS.some((re) => {
    const re2 = new RegExp(re.source, re.flags)
    return re2.test(cleaned)
  })
}
