import { db } from '@/lib/db'
const rows = await db.apiCache.findMany({ where: { key: { startsWith: 'ai:' } }, select: { key: true } })
for (const r of rows) console.log(r.key.slice(0, 90))
