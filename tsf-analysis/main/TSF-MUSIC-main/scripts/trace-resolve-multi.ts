/**
 * Test resolveInnertube for several real YouTube video IDs
 */
import { resolveStream } from '../src/lib/ytm/stream'
import { db } from '../src/lib/db'

const TEST_IDS = ['9bZkp7q19f0', 'kJQP7dywigF', 'JGwWNGJdvx8', 'dQw4w9WgXcQ']

for (const id of TEST_IDS) {
  try {
    await db.streamCache.delete({ where: { videoId: id } })
  } catch {}
  const t0 = Date.now()
  try {
    const r = await resolveStream(id, { skipCache: true })
    console.log(`${id}: ${Date.now() - t0}ms -> provider=${r.provider}, url=${(r.url||'').slice(0,80)}`)
  } catch (e: any) {
    console.log(`${id}: ERROR ${e?.message}`)
  }
}

await db.$disconnect()
