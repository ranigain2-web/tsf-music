/**
 * Clear stale streamCache entries (old demo-tone URLs) so all tracks
 * immediately re-resolve to the new TSF Synth engine.
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const n = await db.streamCache.deleteMany({})
console.log(`cleared ${n.count} streamCache entries`)
await db.$disconnect()
