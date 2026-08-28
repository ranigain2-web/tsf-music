import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const rows = await db.streamCache.findMany({ orderBy: { expiresAt: 'desc' }, take: 20 })
for (const r of rows) console.log(`${r.videoId.padEnd(14)} ${r.provider.padEnd(16)} ${r.url.slice(0, 70)}`)
await db.$disconnect()
