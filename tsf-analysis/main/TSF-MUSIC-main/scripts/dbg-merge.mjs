// Debug: what did the app cache for the videos-filtered Shape of You response?
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const key = (await db.apiCache.findMany({
  where: { key: { contains: 'search' } },
  select: { key: true },
  take: 20,
})).map(r => r.key)
console.log('cached search keys:')
for (const k of key) console.log(' ', k.slice(0, 120))
await db.$disconnect()
