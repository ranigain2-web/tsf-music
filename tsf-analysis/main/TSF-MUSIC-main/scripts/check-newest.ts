import { db } from '@/lib/db'
const pls = await db.playlist.findMany({ where: { source: 'ai' }, orderBy: { createdAt: 'desc' }, take: 4, include: { tracks: true } })
for (const p of pls) {
  console.log(`${p.createdAt.toISOString().slice(11, 19)} | ${p.name.slice(0, 38).padEnd(38)} | tracks=${p.tracks.length} | cover=${p.coverUrl ? 'yes' : 'no'}`)
}
