import { db } from '@/lib/db'
const artists = [
  { id: 'UCJrOtniJ0-NWz37R30urifQ', name: 'Arijit Singh', thumbnail: 'https://lh3.googleusercontent.com/placeholder', source: 'seed' },
  { id: 'UCqECaJ8G1nBK6b8AsdSFEUQ', name: 'Taylor Swift', thumbnail: '', source: 'seed' },
  { id: 'UC19b1nodeZStillValidArt', name: 'A. R. Rahman', thumbnail: '', source: 'seed' },
  { id: 'UC1XxtrdG2-bRrf3rPZ', name: 'The Weeknd', thumbnail: '', source: 'seed' },
]
await db.setting.upsert({ where: { key: 'profile.artists' }, update: { value: JSON.stringify(artists) }, create: { key: 'profile.artists', value: JSON.stringify(artists) } })
await db.setting.upsert({ where: { key: 'profile.genres' }, update: { value: JSON.stringify(['pop', 'bollywood', 'dance']) }, create: { key: 'profile.genres', value: JSON.stringify(['pop', 'bollywood', 'dance']) } })
await db.setting.upsert({ where: { key: 'onboarding.complete' }, update: { value: 'true' }, create: { key: 'onboarding.complete', value: 'true' } })
await db.setting.upsert({ where: { key: 'profile.name' }, update: { value: 'Alex' }, create: { key: 'profile.name', value: 'Alex' } })
// clear stale ai:home cache rows
await db.apiCache.deleteMany({ where: { key: { startsWith: 'ai:home:v1' } } })
console.log('seeded profile: 4 artists, 3 genres; cleared ai:home cache')
