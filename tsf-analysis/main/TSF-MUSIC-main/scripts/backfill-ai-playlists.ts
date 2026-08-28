/**
 * Backfill AI playlists created before the FK-fix.
 *
 * Before the fix, db.track.upsert with artistId/albumId silently failed,
 * so PlaylistTrack rows never got created (the FK to Track was violated).
 *
 * This script walks every Playlist with source='ai', reads the AiSeedTracks
 * via the AiPlaylist record, and re-creates any missing Track + PlaylistTrack
 * rows. Run once.
 */

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const aiPlaylists = await db.aiPlaylist.findMany({
    include: { seeds: true },
  })
  console.log(`Found ${aiPlaylists.length} AI playlists to backfill`)
  for (const ap of aiPlaylists) {
    if (!ap.playlistId) {
      console.log(`  - ${ap.prompt}: no playlistId (skipped)`)
      continue
    }
    // Count existing PlaylistTrack
    const existing = await db.playlistTrack.count({ where: { playlistId: ap.playlistId } })
    if (existing > 0) {
      console.log(`  - "${ap.prompt.slice(0, 40)}": already has ${existing} tracks (skip)`)
      continue
    }
    console.log(`  - Backfilling "${ap.prompt.slice(0, 40)}" (id=${ap.playlistId}) — ${ap.seeds.length} seeds`)
    let added = 0
    for (let i = 0; i < ap.seeds.length; i++) {
      const seed = ap.seeds[i]
      try {
        // Ensure Track row exists (without FK fields)
        await db.track.upsert({
          where: { id: seed.trackId },
          update: { title: '[AI playlist track]', artistName: '[unknown]' },
          create: {
            id: seed.trackId,
            title: '[AI playlist track]',
            artistName: '[unknown]',
            duration: 0,
          },
        })
        // Create PlaylistTrack if not exists
        const has = await db.playlistTrack.findUnique({
          where: { playlistId_trackId: { playlistId: ap.playlistId, trackId: seed.trackId } },
        })
        if (!has) {
          await db.playlistTrack.create({
            data: { playlistId: ap.playlistId, trackId: seed.trackId, position: i },
          })
          added++
        }
      } catch (e: any) {
        console.error(`    seed ${seed.trackId}: ${e.message}`)
      }
    }
    console.log(`    added ${added} tracks`)
  }
  console.log('Backfill done')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
