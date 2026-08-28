import { db } from '@/lib/db'
// keep ONE playlist per name (dedupe test-run artifacts)
const pls = await db.playlist.findMany({ orderBy: { createdAt: 'desc' } })
const seen = new Set<string>()
let del = 0
for (const pl of pls) {
  if (seen.has(pl.name)) {
    await db.playlist.delete({ where: { id: pl.id } }).catch(() => {})
    del++
  } else {
    seen.add(pl.name)
  }
}
console.log(`deleted ${del} duplicate playlists, kept ${seen.size} unique`)
