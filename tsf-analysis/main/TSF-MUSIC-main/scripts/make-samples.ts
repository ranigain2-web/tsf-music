/**
 * Render sample synth tracks (from the user's real catalog videoIds) to WAV
 * files so the user can listen and verify each track is unique + full-length.
 */
import { buildPlan } from '../src/lib/synth/arrangement'
import { renderWavBytes } from '../src/lib/synth/render'
import { writeFileSync, mkdirSync } from 'fs'

mkdirSync('/home/z/my-project/download/samples', { recursive: true })

// real videoIds from the app's current catalog (played in tests)
const samples = [
  { id: 'xTvyyoF_LZY', dur: 234, name: 'sample-1-shape-of-you-234s' },
  { id: '-hNTem7Y4aY', dur: 0, name: 'sample-2-dariya-auto-len' },
  { id: 'IlyHIUeid5I', dur: 187, name: 'sample-3-catalog-187s' },
]

for (const s of samples) {
  const plan = buildPlan(s.id, s.dur)
  const total = 44 + plan.totalSamples * 2
  // render in 1MB chunks
  const chunks: Buffer[] = []
  const CH = 1024 * 1024
  for (let pos = 0; pos < total; pos += CH) {
    chunks.push(Buffer.from(renderWavBytes(plan, pos, Math.min(CH, total - pos))))
  }
  const buf = Buffer.concat(chunks)
  const path = `/home/z/my-project/download/samples/${s.name}.wav`
  writeFileSync(path, buf)
  console.log(`✓ ${path} — ${(buf.length / 1e6).toFixed(1)}MB, ${plan.durationSec}s, genre=${plan.genre}, bpm=${plan.bpm}`)
}
