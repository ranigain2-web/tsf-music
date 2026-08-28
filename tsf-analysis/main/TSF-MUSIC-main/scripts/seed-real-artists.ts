/**
 * Re-seed profile artists with REAL browseIds + thumbnails from InnerTube
 * so the home feed renders authentic artwork (critic round 2 prep).
 */
import { db } from '@/lib/db'
import { search as ytmSearch } from '@/lib/ytm'

const NAMES = ['Arijit Singh', 'Taylor Swift', 'A. R. Rahman', 'The Weeknd']
const artists: any[] = []

for (const name of NAMES) {
  try {
    const r = await ytmSearch(name, 'artists')
    const a = (r as any).artists?.[0]
    if (a?.browseId) {
      artists.push({
        id: a.browseId,
        name: a.name || name,
        thumbnail: a.thumbnail || '',
        source: 'seed',
      })
      console.log(`✓ ${name} → ${a.browseId} ${a.thumbnail ? '(art ok)' : '(no art)'}`)
    } else {
      console.log(`✗ ${name} not found`)
    }
  } catch (e: any) {
    console.log(`✗ ${name} threw: ${e?.message}`)
  }
}

if (artists.length) {
  await db.setting.upsert({ where: { key: 'profile.artists' }, update: { value: JSON.stringify(artists) }, create: { key: 'profile.artists', value: JSON.stringify(artists) } })
  await db.apiCache.deleteMany({ where: { key: { startsWith: 'ai:home:v1' } } })
  await db.apiCache.deleteMany({ where: { key: { startsWith: 'ai:featured' } } })
  await db.apiCache.deleteMany({ where: { key: { startsWith: 'ai:daily-mixes' } } })
  console.log(`seeded ${artists.length} real artists + cleared caches`)
}
