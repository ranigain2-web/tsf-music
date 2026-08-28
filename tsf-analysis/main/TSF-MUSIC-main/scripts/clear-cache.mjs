#!/usr/bin/env node
/**
 * TSF Music — purge the stream + provider-health caches.
 *
 * WHEN TO USE: playback shows 0:00 duration / refuses to start right after
 * a network change (Wi-Fi ↔ mobile hotspot, VPN toggled, laptop moved).
 * Resolved googlevideo URLs are IP-bound; rows cached under the old egress
 * IP serve dead 403 links. Run this, then reload the app:
 *
 *   npm run db:clear-cache
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
// Prisma has resolved `file:./db/custom.db` against the project root in some
// setups and against the schema folder (prisma/db/custom.db) in others —
// DISCOVER which one exists instead of guessing (field fix 2026-08-28).
if (!process.env.DATABASE_URL) {
  const candidates = [
    path.join(root, 'prisma', 'db', 'custom.db'),
    path.join(root, 'db', 'custom.db'),
  ];
  const found = candidates.find((p) => fs.existsSync(p)) || candidates[0];
  process.env.DATABASE_URL = `file:${found}`;
}

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();

try {
  const streams = await db.streamCache.deleteMany({});
  const health = await db.providerHealth.deleteMany({});
  console.log(
    `Purged ${streams.count} StreamCache row(s) and ${health.count} ProviderHealth row(s). ` +
      `Providers will be re-probed on the next play.`
  );
} catch (err) {
  console.error("Failed to purge caches:", err.message);
  console.error("If the DB was never created, run `npm run dev` once first.");
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
