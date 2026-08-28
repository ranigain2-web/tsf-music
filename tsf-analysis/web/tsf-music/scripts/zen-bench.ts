/**
 * TSF Music — Zen model benchmark
 *
 * Runs a tiny "what's 2+2" prompt against each model in MODEL_CHAIN,
 * measures end-to-end latency, and prints a JSON report.
 *
 * Result is cached at /home/z/my-project/scripts/zen-bench.json and read
 * by lib/ai/zen.ts at runtime so the fastest model is always picked
 * first.
 */
import { writeFileSync, readFileSync, existsSync } from 'fs'

const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

const MODELS: string[] = [
  'x-preview-f-free',
  'muse-spark-1.2-contributor-free',
  'hy3-free',
  'mimo-v2.5-free',
  'nemotron-3-ultra-free',
  'claude-sonnet-5',
  'gemini-3.x-flash',
]

interface BenchResult {
  model: string
  ok: boolean
  latencyMs: number
  tokens?: number
  error?: string
}

interface BenchReport {
  runAt: string
  fastest: string | null
  results: BenchResult[]
}

const OUT = '/home/z/my-project/scripts/zen-bench.json'

async function bench(model: string): Promise<BenchResult> {
  const t0 = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(`${ZEN_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'opencode/1.18.18',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'Reply with the literal two characters "OK" and nothing else. No reasoning.' },
          { role: 'user', content: 'Reply OK.' },
        ],
        temperature: 0,
        max_tokens: 256, // generous — some models use reasoning tokens first
      }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      return { model, ok: false, latencyMs: Date.now() - t0, error: `HTTP ${res.status}` }
    }
    const data: any = await res.json()
    const content: string = data?.choices?.[0]?.message?.content ?? ''
    // Some Zen models put output in reasoning_content; both are valid signal
    // that the model actually ran. Treat any non-empty message field as success.
    const reasoning: string = data?.choices?.[0]?.message?.reasoning_content ?? ''
    if (!content && !reasoning) {
      return { model, ok: false, latencyMs: Date.now() - t0, error: 'empty response' }
    }
    return {
      model,
      ok: true,
      latencyMs: Date.now() - t0,
      tokens: data?.usage?.total_tokens,
    }
  } catch (e: any) {
    clearTimeout(timer)
    return { model, ok: false, latencyMs: Date.now() - t0, error: e?.message || String(e) }
  }
}

async function main() {
  console.log('TSF Music — Zen model benchmark')
  console.log(`Probing ${MODELS.length} models in parallel (12s timeout each)…`)
  console.log('---')

  const results = await Promise.all(MODELS.map((m) => bench(m)))

  // Sort by latency (fastest first), excluding failures
  const passing = results.filter((r) => r.ok)
  passing.sort((a, b) => a.latencyMs - b.latencyMs)
  const fastest = passing[0]?.model || null

  // Print results table
  const allSorted = [...results].sort((a, b) => {
    if (a.ok && b.ok) return a.latencyMs - b.latencyMs
    if (a.ok) return -1
    if (b.ok) return 1
    return 0
  })

  for (const r of allSorted) {
    const status = r.ok ? '✓' : '✗'
    const lat = r.ok ? `${r.latencyMs}ms` : 'FAIL'
    const err = r.error ? ` (${r.error})` : ''
    console.log(`  ${status}  ${r.model.padEnd(38)} ${String(lat).padStart(8)}${err}`)
  }

  console.log('---')
  if (fastest) {
    console.log(`Fastest: ${fastest}  (${passing[0].latencyMs}ms)`)
  } else {
    console.log('No models responded — falling back to default chain.')
  }

  const report: BenchReport = {
    runAt: new Date().toISOString(),
    fastest,
    results: allSorted,
  }
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.log(`Report saved: ${OUT}`)
}

void main().catch((e) => {
  console.error('Benchmark failed:', e)
  process.exit(1)
})
