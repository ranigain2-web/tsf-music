/**
 * E2E latency test for the streaming AI playlist generator.
 * Measures: time-to-first-track-event, time-to-meta, total time, track count.
 */
const BASE = 'http://localhost:3000'

async function run(prompt: string, count: number) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/api/ai/playlist-generator`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, count }),
  })
  if (!res.ok || !res.body) {
    console.log(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let firstTrack = -1
  let metaAt = -1
  let doneAt = -1
  let tracks = 0
  const trackTimes: number[] = []
  let title = ''
  let playlistId = ''
  let cached = false
  const leakRe = /opencode|zen|glm|hy3|nemotron|mimo|claude|gemini|gpt/i

  outer: for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, nl)
      buf = buf.slice(nl + 2)
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      let ev: any
      try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
      if (ev.type === 'meta') {
        metaAt = Date.now() - t0
        title = ev.title || ''
        if (leakRe.test(title) || leakRe.test(ev.description || '')) {
          console.log('!!! LEAK in meta:', title, '|', ev.description)
        }
      } else if (ev.type === 'track') {
        tracks++
        if (firstTrack < 0) firstTrack = Date.now() - t0
        trackTimes.push(Date.now() - t0)
        if (leakRe.test(ev.reason || '') || leakRe.test(ev.track?.title || '')) {
          console.log('!!! LEAK in track reason/title:', ev.reason, '|', ev.track?.title)
        }
      } else if (ev.type === 'done') {
        doneAt = Date.now() - t0
        playlistId = ev.playlistId
        cached = !!ev.cached
        break outer
      } else if (ev.type === 'error') {
        console.log('ERROR event:', ev.message)
        return
      }
    }
  }
  const p = (n: number) => (n < 0 ? 'n/a' : `${(n / 1000).toFixed(2)}s`)
  console.log(`"${prompt.slice(0, 40)}" (n=${count}) cached=${cached}`)
  console.log(`  meta=${p(metaAt)} firstTrack=${p(firstTrack)} total=${p(doneAt)} tracks=${tracks} playlist=${playlistId}`)
  const marks = [5, 10, 15, 20, 25].map((n) => {
    const idx = Math.min(n, tracks) - 1
    return idx >= 0 && trackTimes[idx] !== undefined ? `#${n}@${(trackTimes[idx] / 1000).toFixed(1)}s` : null
  }).filter(Boolean)
  console.log(`  milestones: ${marks.join(' ')}`)
  return { firstTrack, doneAt, tracks }
}

// cold run
await run('heartbreak songs that feel like rain', 25)
// repeat run (cache)
await run('heartbreak songs that feel like rain', 25)
