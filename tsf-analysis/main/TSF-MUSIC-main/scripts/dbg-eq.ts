import { db } from '@/lib/db'
const rows = await db.apiCache.findMany({ where: { key: { contains: 'discover-weekly' } } })
const rr = await db.apiCache.findMany({ where: { key: { contains: 'release-radar' } } })
const dwCover = JSON.parse(rows[0].payload).cover
const rrCover = JSON.parse(rr[0].payload).cover
console.log('dw cover == rr cover (byte-equal)?', dwCover === rrCover)
console.log('dw:', dwCover.slice(0, 90))
console.log('rr:', rrCover.slice(0, 90))
