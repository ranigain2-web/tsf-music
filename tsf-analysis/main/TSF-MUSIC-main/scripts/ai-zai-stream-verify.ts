/**
 * Verify TRUE streaming from the Z AI endpoint via raw fetch (SSE deltas),
 * measuring time-to-first-content-token and time-to-first-complete-song-object
 * for the real 25-song playlist-expansion prompt.
 */
import fs from 'fs/promises'

const cfgRaw = await fs.readFile('/etc/.z-ai-config', 'utf-8')
const cfg = JSON.parse(cfgRaw)
console.log('baseUrl:', cfg.baseUrl, '| model in cfg:', cfg.model ?? '(none)')

const SYSTEM = `You are TSF Music's playlist curator. Output a compact JSON object: {"title": string, "description": string, "songs": [{"q": "3-7 word song search query", "r": "max-6-word reason"}]}. JSON only, no markdown, no prose. Output songs in playlist order.`
const USER = `Prompt: "heartbreak songs that feel like rain". Return exactly 25 songs as compact JSON. Use "q" (search query like "Adele Someone Like You") and "r" (max 6 words).`

const t0 = Date.now()
const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
    'X-Z-AI-From': 'Z',
  }
  if (cfg.chatId) headers['X-Chat-Id'] = cfg.chatId
  if (cfg.userId) headers['X-User-Id'] = cfg.userId
  if (cfg.token) headers['X-Token'] = cfg.token
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
  body: JSON.stringify({
    model: cfg.model || 'glm-4.6',
    messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: USER },
    ],
    temperature: 0.7,
    max_tokens: 2000,
    stream: true,
    thinking: { type: 'disabled' },
  }),
})
console.log('HTTP', res.status, 'content-type:', res.headers.get('content-type'), 'headers-at', Date.now() - t0, 'ms')

if (!res.ok || !res.body) {
  console.log('FAIL:', (await res.text()).slice(0, 300))
  process.exit(1)
}

const reader = (res.body as ReadableStream<Uint8Array>).getReader()
const dec = new TextDecoder()
let buf = ''
let content = ''
let firstContent = -1
let firstSongComplete = -1
let chunks = 0

// minimal incremental song-object detection: count '},{' boundaries and full objects ending with }
function countCompleteSongs(text: string): number {
  // crude: count occurrences of '"q"' — each song has one; but we need COMPLETE objects.
  // For measurement: find all "q":"..." followed later by "r":"..."} — approximate via regex over complete objects
  const m = text.match(/\{"q":"[^"]+","r":"[^"]*"\}/g)
  return m ? m.length : 0
}

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  chunks++
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
        if (firstContent < 0) firstContent = Date.now() - t0
        content += d.content
        if (firstSongComplete < 0 && countCompleteSongs(content) >= 1) {
          firstSongComplete = Date.now() - t0
        }
      }
    } catch { /* skip */ }
  }
}
console.log(`chunks=${chunks} firstContentToken=${firstContent}ms firstCompleteSong=${firstSongComplete}ms total=${Date.now() - t0}ms`)
console.log('songs complete at end:', countCompleteSongs(content))
console.log('content sample:', content.slice(0, 300))
console.log('content tail:', content.slice(-200))
