/**
 * Realistic bench: Zen models + ZAI on the ACTUAL compact playlist-expansion prompt.
 * Measures: TTFB, first CONTENT delta, first REASONING delta, total, valid-JSON, song count.
 */
import ZAI from 'z-ai-web-dev-sdk'

const SYSTEM = `You are TSF Music's playlist curator. Output a compact JSON object: {"title": string, "description": string, "songs": [{"q": "3-7 word song search query", "r": "max-6-word reason"}]}. JSON only, no markdown, no prose.`
const USER = `Prompt: "heartbreak songs that feel like rain". Return exactly 25 songs as compact JSON. Use "q" (search query like "Adele Someone Like You") and "r" (max 6 words).`

const MODELS = ['x-preview-f-free', 'nemotron-3-ultra-free', 'hy3-free', 'mimo-v2.5-free', 'muse-spark-1.2-contributor-free']

interface Stat {
  model: string
  http: number
  firstReason: number
  firstContent: number
  total: number
  songs: number
  validJson: boolean
  err?: string
}

async function benchZen(model: string): Promise<Stat> {
  const s: Stat = { model, http: -1, firstReason: -1, firstContent: -1, total: -1, songs: 0, validJson: false }
  const t0 = Date.now()
  try {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), 45_000)
    const res = await fetch('https://opencode.ai/zen/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'opencode/1.18.18' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: USER },
        ],
        max_tokens: 2500,
        temperature: 0.7,
        stream: true,
      }),
      signal: ctrl.signal,
    })
    clearTimeout(to)
    s.http = Date.now() - t0
    if (!res.ok || !res.body) {
      s.err = `HTTP ${res.status}`
      s.total = Date.now() - t0
      return s
    }
    const reader = (res.body as any).getReader()
    const dec = new TextDecoder()
    let buf = ''
    let content = ''
    let reasoning = ''
    outer: while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') break outer
        try {
          const j = JSON.parse(payload)
          const d = j.choices?.[0]?.delta ?? {}
          if (d.reasoning_content) {
            if (s.firstReason < 0) s.firstReason = Date.now() - t0
            reasoning += d.reasoning_content
          }
          if (d.content) {
            if (s.firstContent < 0) s.firstContent = Date.now() - t0
            content += d.content
          }
        } catch { /* skip */ }
      }
    }
    s.total = Date.now() - t0
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    try {
      const j = JSON.parse(cleaned)
      s.songs = Array.isArray(j.songs) ? j.songs.length : 0
      s.validJson = s.songs > 0
    } catch {
      // try reasoning fallback
      try {
        const j = JSON.parse(reasoning.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim())
        s.songs = Array.isArray(j.songs) ? j.songs.length : 0
        s.validJson = s.songs > 0
      } catch { /* invalid */ }
    }
  } catch (e: any) {
    s.err = e?.message ?? 'fail'
    s.total = Date.now() - t0
  }
  return s
}

async function benchZai(): Promise<Stat> {
  const s: Stat = { model: 'zai-glm', http: -1, firstReason: -1, firstContent: -1, total: -1, songs: 0, validJson: false }
  const t0 = Date.now()
  try {
    const zai = await ZAI.create()
    const r: any = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: SYSTEM },
        { role: 'user', content: USER },
      ],
      thinking: { type: 'disabled' },
    })
    s.total = Date.now() - t0
    s.firstContent = s.total
    const content = r?.choices?.[0]?.message?.content ?? ''
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    try {
      const j = JSON.parse(cleaned)
      s.songs = Array.isArray(j.songs) ? j.songs.length : 0
      s.validJson = s.songs > 0
    } catch { /* invalid */ }
  } catch (e: any) {
    s.err = e?.message ?? 'fail'
    s.total = Date.now() - t0
  }
  return s
}

const stats: Stat[] = []
// run zen models sequentially (avoid cross-noise), zai last
for (const m of MODELS) {
  const r = await benchZen(m)
  stats.push(r)
  console.log(`${m}: http=${r.http} firstReason=${r.firstReason} firstContent=${r.firstContent} total=${r.total} songs=${r.songs} valid=${r.validJson} ${r.err ?? ''}`)
}
const z = await benchZai()
stats.push(z)
console.log(`zai-glm: total=${z.total} songs=${z.songs} valid=${z.validJson} ${z.err ?? ''}`)

await Bun.write('/home/z/my-project/scripts/ai-engine-bench.json', JSON.stringify({ runAt: new Date().toISOString(), stats }, null, 2))
console.log('saved scripts/ai-engine-bench.json')
