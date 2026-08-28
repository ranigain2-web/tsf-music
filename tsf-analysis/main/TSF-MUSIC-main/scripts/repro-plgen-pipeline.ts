/**
 * Standalone reproduction of the playlist-generator streaming pipeline
 * (engine + extractor + ordered emission) with memory instrumentation.
 * Mock resolver — swap in real ytmSearch via env REAL=1.
 */
import { aiChat } from '../src/lib/ai/engine'
import { createExtractor } from '../src/lib/ai/partial'

const REAL = process.env.REAL === '1'
let searchCount = 0

async function mockSearch(q: string): Promise<any> {
  const id = ++searchCount
  await new Promise((r) => setTimeout(r, 150 + Math.random() * 350))
  return {
    tracks: [
      { videoId: `vid${id}`, title: `Track for ${q}`, artistName: 'Artist', duration: 200, thumbnail: '' },
    ],
  }
}

async function realSearch(q: string): Promise<any> {
  const { search } = await import('../src/lib/ytm')
  searchCount++
  return search(q, 'songs')
}

const doSearch = REAL ? realSearch : mockSearch

function mem() {
  const u = process.memoryUsage()
  return `heap=${(u.heapUsed / 1048576).toFixed(0)}MB rss=${(u.rss / 1048576).toFixed(0)}MB searches=${searchCount}`
}

const memTimer = setInterval(() => console.log(`[mem] ${mem()}`), 2000)

const prompt = 'heartbreak songs that feel like rain'
const count = 25
const S = 4 // starters
const shardA = 12
const shardB = 13

const seen = new Set<string>()
const emitted: any[] = []
const pending = new Map<number, any>()
let nextEmit = 0
let title = ''

const flush = async () => {
  while (pending.has(nextEmit)) {
    const item = pending.get(nextEmit)
    pending.delete(nextEmit)
    if (item) {
      emitted.push(item)
      if (emitted.length % 5 === 0) console.log(`[emit] #${emitted.length} @${Date.now() % 100000}`)
    }
    nextEmit++
  }
}

const submitTrack = async (k: number, t: any) => {
  if (!t || seen.has(t.videoId)) {
    console.log(`[drop] key=${k} t=${t ? t.videoId : 'null'} reason=${!t ? 'no-track' : 'dupe:' + t.videoId}`)
    pending.set(k, null)
    await flush()
    return
  }
  seen.add(t.videoId)
  pending.set(k, t)
  await flush()
}

let active = 0
const queue: { q: string; k: number }[] = []
const assignedKeys = new Set<number>()
const pump = async () => {
  while (queue.length && active < 6) {
    const job = queue.shift()!
    active++
    void (async () => {
      try {
        const r = await doSearch(job.q)
        await submitTrack(job.k, r?.tracks?.[0] ?? null)
      } finally {
        active--
        void pump()
      }
    })()
  }
}

const enqueue = (qs: string[], base: number, cap: number) => {
  for (let i = 0; i < qs.length && i < cap; i++) {
    queue.push({ q: qs[i], k: base + i })
    assignedKeys.add(base + i)
  }
  void pump()
}

const runShard = async (system: string, user: string, baseKey: number, cap: number, isHead: boolean) => {
  const extractor = createExtractor()
  const local: string[] = []
  const t0 = Date.now()
  await aiChat(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    {
      temperature: 0.75, maxTokens: 1800, json: true, timeoutMs: 45_000,
      onDelta: (d) => {
        const got = extractor.push(d)
        if (isHead && got.title && !title) title = got.title
        if (got.songs.length) {
          const fresh = got.songs.map((s) => s.q).filter((q) => !local.includes(q))
          local.push(...fresh)
          enqueue(fresh, baseKey + local.length - fresh.length, cap - local.length + fresh.length)
        }
      },
    }
  )
  console.log(`[shard] head=${isHead} done in ${((Date.now() - t0) / 1000).toFixed(1)}s songs=${local.length}`)
}

console.log('start', mem())
enqueue(['heartbreak rain', 'pop heartbreak', 'romantic heartbreak', 'sad ballads'], 0, S)

const baseSystem = `You are TSF Music's playlist curator. Output COMPACT JSON only — no markdown fences, no prose. Song object keys exactly: "q" (3-7 word YouTube Music search query, pattern "Artist Song Title"), "r" (reason, max 6 words). Rules: well-known songs; vary artists; match the vibe.`
const t0 = Date.now()
await Promise.allSettled([
  runShard(baseSystem + ' Also include top-level "title" (catchy, max 6 words) and "description" (one sentence). Shape: {"title":"...","description":"...","songs":[...]}', `Prompt: "${prompt}". Return the FIRST ${shardA} songs.`, S, shardA, true),
  runShard(baseSystem + ' Shape: {"songs":[...]}.', `Prompt: "${prompt}". Return ONLY songs ${shardA + 1}-${count}.`, S + shardA, shardB, false),
])
console.log(`shards done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

// gap fill — only never-assigned keys
for (let k = 0; k < S + shardA + shardB; k++) if (!assignedKeys.has(k) && !pending.has(k)) pending.set(k, null)
await flush()

// drain
const deadline = Date.now() + 20_000
while ((queue.length || active > 0) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100))
}

console.log(`DONE total=${emitted.length} title="${title}" in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log('nextEmit=', nextEmit, 'pending keys=', [...pending.keys()].sort((a,b)=>a-b).join(','))
console.log('emitted keys order ok, emitted count=', emitted.length)
console.log('final', mem())
clearInterval(memTimer)
process.exit(0)
