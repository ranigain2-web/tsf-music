/**
 * Probe: (1) z-ai-web-dev-sdk streaming support + latency, (2) Zen streaming support + latency.
 * Results decide the engine's provider order and hedging design.
 */
import ZAI from 'z-ai-web-dev-sdk'

async function benchZai() {
  const t0 = Date.now()
  try {
    const zai = await ZAI.create()
    const tCreate = Date.now() - t0
    // try streaming
    let firstDelta = -1
    let text = ''
    let streamed = false
    try {
      const stream = await zai.chat.completions.create({
        messages: [
          { role: 'assistant', content: 'Reply with JSON only.' },
          { role: 'user', content: 'Give 3 song search queries for a rainy-day playlist. JSON array of strings.' },
        ],
        thinking: { type: 'disabled' },
        stream: true,
      })
      for await (const chunk of stream) {
        if (firstDelta < 0) firstDelta = Date.now() - t0
        text += (chunk as any).choices?.[0]?.delta?.content ?? ''
        streamed = true
      }
    } catch (e: any) {
      console.log('zai stream failed:', e?.message)
    }
    if (!streamed) {
      const r = await zai.chat.completions.create({
        messages: [
          { role: 'assistant', content: 'Reply with JSON only.' },
          { role: 'user', content: 'Give 3 song search queries for a rainy-day playlist. JSON array of strings.' },
        ],
        thinking: { type: 'disabled' },
      })
      text = (r as any).choices?.[0]?.message?.content ?? ''
    }
    console.log(`ZAI: create=${tCreate}ms firstDelta=${firstDelta}ms total=${Date.now() - t0}ms stream=${streamed}`)
    console.log('ZAI text:', text.slice(0, 200))
  } catch (e: any) {
    console.log('ZAI unavailable:', e?.message)
  }
}

async function benchZen() {
  const t0 = Date.now()
  try {
    const res = await fetch('https://opencode.ai/zen/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'opencode/1.18.18' },
      body: JSON.stringify({
        model: 'hy3-free',
        messages: [
          { role: 'system', content: 'Reply with JSON only.' },
          { role: 'user', content: 'Give 3 song search queries for a rainy-day playlist. JSON array of strings.' },
        ],
        max_tokens: 200,
        stream: true,
      }),
    })
    if (!res.ok) {
      console.log(`ZEN stream HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return
    }
    const reader = (res.body as any).getReader()
    const dec = new TextDecoder()
    let buf = ''
    let firstDelta = -1
    let text = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const j = JSON.parse(payload)
          const d = j.choices?.[0]?.delta?.content ?? ''
          if (d) {
            if (firstDelta < 0) firstDelta = Date.now() - t0
            text += d
          }
        } catch { /* skip */ }
      }
    }
    console.log(`ZEN(hy3-free): firstDelta=${firstDelta}ms total=${Date.now() - t0}ms`)
    console.log('ZEN text:', text.slice(0, 200))
  } catch (e: any) {
    console.log('ZEN failed:', e?.message)
  }
}

await benchZai()
await benchZen()
