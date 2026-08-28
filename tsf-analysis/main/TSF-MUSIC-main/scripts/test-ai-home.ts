/**
 * Test the new /api/ai/home endpoint end-to-end:
 *   1. Reset onboarding
 *   2. Set profile with user's actual artists (Shreya Ghoshal, Arijit Singh, Billie Eilish)
 *      — resolves real browseIds via InnerTube search
 *   3. Mark complete
 *   4. Call /api/ai/home and verify shelves contain only personalized content
 *   5. Verify no inappropriate content appears
 */

const BASE = 'http://localhost:3000'
const ARTIST_NAMES = ['Shreya Ghoshal', 'Arijit Singh', 'Billie Eilish']
const GENRES = ['Pop', 'Bollywood', 'Alternative']

async function main() {
  // 1. Reset
  console.log('\n[1] Reset onboarding')
  await fetch(`${BASE}/api/onboarding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reset' }),
  })

  // 2. Resolve artist browseIds via InnerTube search
  console.log('\n[2] Resolving artists:')
  const artists: { id: string; name: string; thumbnail?: string }[] = []
  for (const name of ARTIST_NAMES) {
    const res = await fetch(`${BASE}/api/ytm/search?q=${encodeURIComponent(name)}&filter=artists`).then((r) => r.json())
    const found = (res.artists || []).find((a: any) => a.name?.toLowerCase() === name.toLowerCase())
    if (found) {
      console.log(`  + ${name}: browseId=${found.browseId}, thumb=${found.thumbnail?.slice(0, 50)}...`)
      artists.push({ id: found.browseId, name: found.name, thumbnail: found.thumbnail })
    } else {
      console.log(`  ? ${name}: exact not found, fallback to first hit`)
      const any = (res.artists || [])[0]
      if (any) artists.push({ id: any.browseId, name: any.name, thumbnail: any.thumbnail })
    }
  }

  // 3. Save profile + mark complete
  console.log('\n[3] Save profile')
  await fetch(`${BASE}/api/onboarding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'save',
      name: 'Alex',
      bio: 'Music lover. Indie, bollywood, alt-pop.',
      artists,
      genres: GENRES,
    }),
  })
  await fetch(`${BASE}/api/onboarding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'complete' }),
  })
  console.log('  + Profile saved + complete')

  // 4. Hit /api/ai/home
  console.log('\n[4] Calling /api/ai/home')
  const t0 = Date.now()
  const home = await fetch(`${BASE}/api/ai/home`).then((r) => r.json())
  console.log(`  + ${Date.now() - t0}ms`)
  console.log(`  greeting: ${home.greeting}`)
  console.log(`  name: ${home.name}`)
  console.log(`  mixes: ${home.mixes?.length || 0}`)
  console.log(`  shelves: ${home.shelves?.length || 0}`)
  for (const s of home.shelves || []) {
    const counts = {
      tracks: s.tracks?.length || 0,
      albums: s.albums?.length || 0,
      artists: s.artists?.length || 0,
    }
    console.log(`   - "${s.title}"  ${JSON.stringify(counts)}`)
  }
  for (const m of home.mixes || []) {
    console.log(`   - mix "${m.title}" / "${m.subtitle}" / ${m.tracks?.length || 0} tracks / cover=${m.cover?.slice(0, 60)}`)
  }

  // 5. Safety audit
  console.log('\n[5] Safety audit')
  const DENY = /\b(sex|porn|xxx|hentai|erotic|nude|naked|booty|brazzers|pornhub|onlyfans|bangbros|slut|escort|bdsm)\b/i
  const flagged: string[] = []
  for (const s of home.shelves || []) {
    if (DENY.test(s.title)) flagged.push(`shelf: ${s.title}`)
    for (const t of s.tracks || []) {
      const str = `${t.title} ${t.artistName} ${t.albumName || ''}`
      if (DENY.test(str)) flagged.push(`track: ${str}`)
    }
  }
  for (const m of home.mixes || []) {
    for (const t of m.tracks || []) {
      const str = `${t.title} ${t.artistName}`
      if (DENY.test(str)) flagged.push(`mix-track: ${str}`)
    }
  }
  if (flagged.length === 0) console.log('  + CLEAN - no inappropriate content')
  else {
    console.log(`  ! ${flagged.length} FLAGGED:`)
    flagged.slice(0, 20).forEach((s) => console.log(`    ${s}`))
  }

  // 6. Personalization audit
  console.log('\n[6] Personalization audit')
  console.log(`  shelves match user's preferences? (manually review shelf titles above)`)
  console.log(`  all mixes should be Daily Mix 1..N seeded from user's artists`)

  console.log('\n+ Done')
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})

