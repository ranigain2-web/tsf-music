import { PrismaClient } from '@prisma/client'
import { writeFileSync } from 'node:fs'
const db = new PrismaClient()
const key = 'ytm:WEB_REMIX:search:{"query":"Kesariya"}'
const row = await db.apiCache.findUnique({ where: { key } })
if (!row) { console.log('not cached'); process.exit(0) }
writeFileSync('/tmp/kess_unfilt.json', row.payload)
console.log('unfiltered cached, expires:', row.expiresAt)
await db.$disconnect()
