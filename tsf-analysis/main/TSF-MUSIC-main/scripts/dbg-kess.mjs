import { PrismaClient } from '@prisma/client'
import { readFileSync, writeFileSync } from 'node:fs'
const db = new PrismaClient()
const key = 'ytm:WEB_REMIX:search:{"query":"Kesariya","params":"EgWKAQIQAWoKEAkQChAFEAMQBA%3D%3D"}'
const row = await db.apiCache.findUnique({ where: { key } })
if (!row) { console.log('not cached'); process.exit(0) }
writeFileSync('/tmp/kess_videos.json', row.payload)
console.log('expires:', row.expiresAt, 'payload bytes:', row.payload.length)
await db.$disconnect()
