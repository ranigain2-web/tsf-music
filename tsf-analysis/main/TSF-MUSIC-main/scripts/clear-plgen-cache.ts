import { db } from '@/lib/db'
const rows = await db.apiCache.findMany({ where: { key: { startsWith: 'ai:plgen:v3:' } } })
console.log('plgen cache rows:', rows.length)
await db.apiCache.deleteMany({ where: { key: { startsWith: 'ai:plgen:v3:' } } })
console.log('cleared')
