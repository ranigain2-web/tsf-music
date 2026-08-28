import ZAI from 'z-ai-web-dev-sdk'

// 1. Dump zai chunk shapes
try {
  const zai = await ZAI.create()
  const stream = await zai.chat.completions.create({
    messages: [{ role: 'user', content: 'Say hello in 3 words' }],
    thinking: { type: 'disabled' },
    stream: true,
  })
  let n = 0
  for await (const chunk of stream) {
    if (n < 4) console.log('ZAI chunk', JSON.stringify(chunk).slice(0, 400))
    n++
  }
  console.log('ZAI chunks:', n)
} catch (e: any) {
  console.log('zai fail', e?.message)
}

// 2. Dump zen raw SSE lines
try {
  const res = await fetch('https://opencode.ai/zen/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'opencode/1.18.18' },
    body: JSON.stringify({
      model: 'hy3-free',
      messages: [{ role: 'user', content: 'Say hello in 3 words' }],
      max_tokens: 50,
      stream: true,
    }),
  })
  console.log('ZEN status', res.status)
  const reader = (res.body as any).getReader()
  const dec = new TextDecoder()
  let buf = ''
  let shown = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('data:') && shown < 5) {
        console.log('ZEN line:', line.slice(0, 400))
        shown++
      }
    }
  }
} catch (e: any) {
  console.log('zen fail', e?.message)
}
