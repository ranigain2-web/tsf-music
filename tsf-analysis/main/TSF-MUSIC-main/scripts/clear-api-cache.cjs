// Clear the InnerTube ApiCache (metadata responses) — keeps StreamCache intact.
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()
async function main() {
  const r = await db.apiCache.deleteMany({})
  console.log('ApiCache rows deleted:', r.count)
}
main().finally(() => db.$disconnect())
