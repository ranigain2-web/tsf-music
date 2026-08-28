import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const rows = await db.historyItem.findMany({ orderBy: { playedAt: 'desc' }, take: 6, include: { track: true } })
for (const r of rows) console.log(`${r.playedAt.toISOString()} | ${r.track.id.padEnd(14)} | ${(r.track.title||'').slice(0,40).padEnd(40)} | ${r.track.artistName||''} | dur=${r.track.duration}`)
await db.$disconnect()
