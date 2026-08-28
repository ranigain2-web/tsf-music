import { db } from '@/lib/db'
// Keep only the 5 most recent AI playlists (nice demo data), remove the test spam
const keep = await db.playlist.findMany({
  where: { source: 'ai' },
  orderBy: { createdAt: 'desc' },
  take: 5,
  select: { id: true },
})
const keepIds = keep.map((k) => k.id)
const del = await db.playlist.deleteMany({ where: { source: 'ai', id: { notIn: keepIds } } })
console.log(`kept ${keepIds.length}, deleted ${del.count} test playlists`)
