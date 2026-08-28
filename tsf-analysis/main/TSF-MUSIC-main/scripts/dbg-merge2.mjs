import { PrismaClient } from '@prisma/client'
import { execSync } from 'node:child_process'

const db = new PrismaClient()

// What does the app's cached videos-response for "Shape of You" parse to?
const key = 'ytm:WEB_REMIX:search:{"query":"Shape of You","params":"EgWKAQIQAWoKEAkQChAFEAMQBA%3D%3D"}'
const row = await db.apiCache.findUnique({ where: { key } })
if (!row) {
  console.log('NO videos-response cached for Shape of You')
} else {
  const fs = await import('node:fs')
  fs.writeFileSync('/tmp/app_cached_videos_soy.json', row.payload)
  console.log('cached videos response written, expires:', row.expiresAt)
}

// and the unfiltered one
const key2 = 'ytm:WEB_REMIX:search:{"query":"Shape of You"}'
const row2 = await db.apiCache.findUnique({ where: { key: key2 } })
if (!row2) {
  console.log('NO unfiltered response cached for Shape of You')
} else {
  const fs = await import('node:fs')
  fs.writeFileSync('/tmp/app_cached_unfilt_soy.json', row2.payload)
  console.log('cached unfiltered response written')
}
await db.$disconnect()
