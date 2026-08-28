// Dump the raw InnerTube search response the APP actually parsed (from ApiCache).
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()
async function main() {
  const rows = await db.apiCache.findMany({
    where: { key: { contains: 'search' } },
    take: 5,
  })
  for (const r of rows) {
    console.log('KEY:', r.key, '· expires:', r.expiresAt)
    const payload = JSON.parse(r.payload)
    // find first 3 musicResponsiveListItemRenderer nodes + report duration locations
    function* walk(node) {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) { for (const i of node) yield* walk(i); return }
      yield node
      for (const v of Object.values(node)) yield* walk(v)
    }
    const rowsFound = []
    for (const obj of walk(payload)) {
      const rr = obj.musicResponsiveListItemRenderer
      if (rr && rowsFound.length < 4) rowsFound.push(rr)
    }
    console.log('rows found:', rowsFound.length)
    for (const [i, rr] of rowsFound.entries()) {
      const flexTexts = (rr.flexColumns || []).map((c) =>
        (c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []).map((x) => x.text).join('|')
      )
      console.log(`ROW ${i}: flex=`, JSON.stringify(flexTexts), ' fixed=', JSON.stringify(rr.fixedColumns ? 'present' : 'null'))
    }
    require('fs').writeFileSync('/tmp/app-search-raw.json', JSON.stringify(payload))
    console.log('full payload → /tmp/app-search-raw.json')
    break
  }
}
main().finally(() => db.$disconnect())
