/**
 * Trace why resolveInnertube fails in the dev environment
 */
import { resolveStream } from '../src/lib/ytm/stream'
import { db } from '../src/lib/db'

const TEST_VIDEO_ID = 'dQw4w9WgXcQ' // Rick Astley - Never Gonna Give You Up

console.log('Testing resolveStream for videoId:', TEST_VIDEO_ID)
console.log('---')

// Clear cache to force fresh resolution
try {
  await db.streamCache.delete({ where: { videoId: TEST_VIDEO_ID } })
} catch {}

const t0 = Date.now()
const result = await resolveStream(TEST_VIDEO_ID, { skipCache: true })
console.log(`Resolved in ${Date.now() - t0}ms`)
console.log('  provider:', result.provider)
console.log('  url:', (result.url || '').slice(0, 100))
console.log('  bitrate:', result.bitrate)
console.log('  mime:', result.mime)
console.log('')

// Check provider health
const health = await db.providerHealth.findMany()
console.log('Provider health:')
for (const h of health) {
  console.log(`  ${h.provider}: ${h.ok ? 'OK' : 'FAIL'} (${h.latencyMs}ms)${h.lastError ? ' ' + h.lastError : ''}`)
}

await db.$disconnect()
