const BASE = 'http://127.0.0.1:3000'
async function rng(url: string, start: number, count: number) {
  const r = await fetch(url, { headers: { range: `bytes=${start}-${start + count - 1}` } })
  return { status: r.status, cr: r.headers.get('content-range'), bytes: new Uint8Array(await r.arrayBuffer()) }
}
// mid-song bytes for 3 different tracks
for (const id of ['GAUNTLET-A', 'GAUNTLET-B', 'ZZDIFFERENT']) {
  const r = await rng(`${BASE}/api/stream/synth?id=${id}&dur=210`, 44 + 30 * 44100 * 2, 64)
  const hex = [...r.bytes.slice(0, 24)].map(b => b.toString(16).padStart(2, '0')).join(' ')
  let nz = 0; for (const b of r.bytes) if (b !== 0) nz++
  console.log(`${id}: status=${r.status} nonzero=${nz}/64 hdr=${hex}`)
}
// deep seek chunk
const deep = await rng(`${BASE}/api/stream/synth?id=GAUNTLET-A&dur=210`, 44 + 100 * 44100 * 2, 4096)
let nz2 = 0; for (const b of deep.bytes) if (b !== 0) nz2++
console.log(`deep seek 100s: nonzero=${nz2}/4096 status=${deep.status}`)
// compare local lib render vs http for same id+off
const { renderWavBytes } = await import('../src/lib/synth/render')
const { buildPlan } = await import('../src/lib/synth/arrangement')
const plan = buildPlan('GAUNTLET-A', 210)
console.log('local plan: genre=%s bpm=%s events=%d', plan.genre, plan.bpm, plan.events.length)
const local = renderWavBytes(plan, 44 + 30 * 44100 * 2, 64)
let nzl = 0; for (const b of local) if (b !== 0) nzl++
console.log(`local render nonzero=${nzl}/64`)
const http = await rng(`${BASE}/api/stream/synth?id=GAUNTLET-A&dur=210`, 44 + 30 * 44100 * 2, 64)
let same = local.length === http.bytes.length
for (let i = 0; same && i < local.length; i++) if (local[i] !== http.bytes[i]) same = false
console.log(`local == http: ${same}`)
