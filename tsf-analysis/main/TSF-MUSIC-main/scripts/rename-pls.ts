import { db } from '@/lib/db'
const renames: Record<string, string> = {
  'Dreamy Synthwave For a Neon Night Drive': 'Neon Night Drive',
  'dark techno for midnight driving': 'Midnight Techno',
  'Bollywood Dance Party': 'Bollywood Dance Party',
  'heartbreak songs that feel like rain': 'Rainy Heartbreak',
  'Epic Workout Hits': 'Workout Hits',
}
const pls = await db.playlist.findMany({ where: { source: 'ai' } })
for (const pl of pls) {
  const nn = renames[pl.name]
  if (nn && nn !== pl.name) {
    await db.playlist.update({ where: { id: pl.id }, data: { name: nn } })
    console.log(`renamed: ${pl.name.slice(0, 40)} → ${nn}`)
  }
}
