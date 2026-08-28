import { db } from '@/lib/db'
const rows = await db.apiCache.findMany({ where: { key: { contains: 'release-radar' } }, select: { key: true } })
console.log(rows.map((r) => r.key.slice(110)).join('\n'))
