import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const rows = await db.streamCache.findMany({ where: { provider: 'itunes-preview' }, orderBy: { expiresAt: 'desc' }, take: 4 })
for (const r of rows) console.log(`${r.videoId.padEnd(14)} ${r.url}`)
await db.$disconnect()
