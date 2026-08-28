import { buildPlan } from '../src/lib/synth/arrangement'
const genres: Record<string, number> = {}
const bpms: number[] = []
for (let i = 0; i < 120; i++) {
  const id = Math.random().toString(36).slice(2, 13)
  const p = buildPlan(id, 180)
  genres[p.genre] = (genres[p.genre] || 0) + 1
  bpms.push(p.bpm)
}
console.log('genre distribution over 120 random tracks:')
for (const [g, n] of Object.entries(genres).sort((a, b) => b[1] - a[1])) console.log(`  ${g}: ${n}`)
console.log(`bpm range: ${Math.min(...bpms)}-${Math.max(...bpms)}`)
