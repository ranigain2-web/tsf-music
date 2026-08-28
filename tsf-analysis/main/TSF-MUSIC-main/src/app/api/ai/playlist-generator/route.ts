import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { search as ytmSearch } from '@/lib/ytm'
import { readProfile } from '../../onboarding/route'
import { filterSafeTracks, isShelfTitleSafe } from '@/lib/safety'
import { aiChat } from '@/lib/ai/engine'
import { createExtractor, parseTolerantJson } from '@/lib/ai/partial'
import { sanitizeUserText } from '@/lib/ai/sanitize'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * POST /api/ai/playlist-generator   (Server-Sent Events stream)
 *   body: { prompt: string, count?: number (default 25) }
 *
 * Phase-2 speed architecture (Bar 1: first track ≤ 3s, full ≤ 8s p50,
 * repeat ≤ 300ms):
 *
 *   t=0    deterministic "starter" queries derived from the prompt are
 *          resolved immediately → user sees real tracks in ~1s on ANY backend
 *   t=0    TWO LLM shards run in parallel (songs 1..12 / 13..25), each TOKEN-
 *          STREAMED; every complete song object is resolved the moment it
 *          parses — resolution does not wait for generation to finish
 *   end    playlist persisted incrementally; final payload cached 24h so a
 *          repeat of the same prompt replays in ~300ms
 *
 * The response is SSE:
 *   {"type":"phase","phase":"..."}       progress phase changes
 *   {"type":"meta","title","description"}
 *   {"type":"track","track":{...},"reason","index"}
 *   {"type":"done","playlistId","title","total"}
 *   {"type":"error","message"}
 *
 * Bar 2 (purity): every user-visible string from the LLM passes through
 * sanitizeUserText; provider/model identities never reach the client.
 */

const DEFAULT_COUNT = 25
const MAX_COUNT = 50
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const RESOLVE_CONCURRENCY = 6

interface SongSeed { q: string; r: string }

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'with', 'song', 'songs', 'music', 'that', 'like', 'feels', 'feel', 'my', 'me'])

function intentScore(query: string, title: string, artist: string): number {
  const qNorm = normalizeText(query)
  const hay = normalizeText(`${title} ${artist}`)
  const tokens = qNorm.split(' ').filter((t) => t.length >= 3 && !STOPWORDS.has(t))
  if (!tokens.length) return 1
  let hit = 0
  for (const t of tokens) {
    if (hay.includes(t)) hit++
  }
  return hit / tokens.length
}

function trackToPlayer(t: any) {
  if (!t) return null
  return {
    videoId: t.videoId || t.id,
    title: t.title,
    artistName: t.artistName || t.artist,
    artistId: t.artistId,
    albumName: t.albumName,
    albumId: t.albumId,
    duration: t.duration || 0,
    thumbnail: t.thumbnail || '',
  }
}

function hashKey(s: string): string {
  // djb2 — fast, no crypto dependency
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** Deterministic starter queries so SOMETHING real is on screen in ~1s. */
function starterQueries(prompt: string, profile: Awaited<ReturnType<typeof readProfile>>): string[] {
  const words = prompt.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOPWORDS.has(w))
  const core = words.slice(0, 4).join(' ')
  const genre = profile.genres[0]
  const artist = profile.artists[0]?.name
  const qs = [core || prompt]
  if (words.length > 4) qs.push(words.slice(0, 2).join(' '))
  if (genre && core) qs.push(`${genre} ${words.slice(0, 2).join(' ')}`)
  if (artist && core) qs.push(`${artist} ${words.slice(0, 2).join(' ')}`)
  return qs.slice(0, 4)
}

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------

function sse(controller: ReadableStreamDefaultController, enc: TextEncoder, obj: unknown) {
  controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const prompt: string = (body.prompt || '').trim()
  const count = Math.min(MAX_COUNT, Math.max(5, body.count ?? DEFAULT_COUNT))

  if (!prompt) {
    return new Response(JSON.stringify({ error: 'Missing prompt' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (!isShelfTitleSafe(prompt)) {
    return new Response(JSON.stringify({ error: 'Prompt blocked by content safety filter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const profile = await readProfile()
  const profileSig = hashKey(
    profile.artists.slice(0, 5).map((a) => a.id || a.name).join(',') + '|' + profile.genres.slice(0, 5).join(',')
  )
  const cacheKey = `ai:plgen:v3:${hashKey(prompt.toLowerCase())}:${count}:${profileSig}`

  const enc = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const startedAt = Date.now()
      let closed = false
      const send = (o: unknown) => {
        if (!closed) {
          try { sse(controller, enc, o) } catch { closed = true }
        }
      }
      const abortAll = new AbortController()
      req.signal?.addEventListener('abort', () => abortAll.abort(), { once: true })

      try {
        // ------------------------------------------------------------------
        // 0. Prompt cache — repeat generation replays in ~300ms
        // ------------------------------------------------------------------
        try {
          const row = await db.apiCache.findUnique({ where: { key: cacheKey } })
          if (row && row.expiresAt.getTime() > Date.now()) {
            const cached = JSON.parse(row.payload) as {
              title: string; description: string; tracks: any[]; reasons: Record<string, string>
            }
            // replay as a fresh playlist instance
            const playlist = await db.playlist.create({
              data: {
                name: cached.title,
                description: cached.description,
                coverUrl: cached.tracks[0]?.thumbnail || null,
                source: 'ai',
              },
            })
            await Promise.all(cached.tracks.map((t, i) =>
              db.playlistTrack.create({
                data: { playlistId: playlist.id, trackId: t.videoId, position: i },
              }).catch(() => {})
            ))
            send({ type: 'meta', title: cached.title, description: cached.description })
            send({ type: 'phase', phase: 'replayed' })
            for (let i = 0; i < cached.tracks.length; i++) {
              send({ type: 'track', track: cached.tracks[i], reason: cached.reasons[cached.tracks[i].videoId] ?? '', index: i })
            }
            send({ type: 'done', playlistId: playlist.id, title: cached.title, total: cached.tracks.length, cached: true, ms: Date.now() - startedAt })
            closed = true
            controller.close()
            return
          }
        } catch { /* cache miss on error */ }

        // ------------------------------------------------------------------
        // 1. State
        // ------------------------------------------------------------------
        const seen = new Set<string>()
        const emitted: { track: any; reason: string }[] = []
        let playlist: { id: string } | null = null
        let title = ''
        let description = ''
        let metaSent = false

        const ensureMeta = (fallbackTitle?: string) => {
          if (metaSent) return
          if (!title && fallbackTitle) title = fallbackTitle
          if (!title) {
            const tc = sanitizeUserText(prompt, 60)
              .split(' ')
              .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
              .join(' ')
            title = tc || 'New Playlist'
          }
          send({ type: 'meta', title, description })
          metaSent = true
        }

        const ensurePlaylist = async () => {
          if (playlist) return playlist
          ensureMeta()
          playlist = await db.playlist.create({
            data: {
              name: title,
              description,
              coverUrl: null,
              source: 'ai',
            },
          })
          return playlist
        }

        /** persist + emit a resolved track (ordered emission via pending map) */
        const pending = new Map<number, { track: any; reason: string } | null>()
        let nextEmit = 0
        const flush = async () => {
          while (pending.has(nextEmit)) {
            const item = pending.get(nextEmit)!
            pending.delete(nextEmit)
            if (item) {
              emitted.push(item)
              if (emitted.length === 1) {
                // first track → create playlist + set cover from it
                const pl = await ensurePlaylist()
                await db.playlist.update({
                  where: { id: pl.id },
                  data: { coverUrl: item.track.thumbnail || null },
                }).catch(() => {})
              }
              // persist track + link (best-effort, non-blocking errors)
              await db.track.upsert({
                where: { id: item.track.videoId },
                update: { title: item.track.title, artistName: item.track.artistName, albumName: item.track.albumName, duration: item.track.duration, thumbnail: item.track.thumbnail },
                create: { id: item.track.videoId, title: item.track.title || 'Unknown', artistName: item.track.artistName || 'Unknown artist', duration: item.track.duration || 0, thumbnail: item.track.thumbnail, albumName: item.track.albumName },
              }).catch(() => {})
              if (playlist) {
                await db.playlistTrack.create({
                  data: { playlistId: playlist.id, trackId: item.track.videoId, position: emitted.length - 1 },
                }).catch(() => {})
              }
              send({ type: 'track', track: item.track, reason: item.reason, index: emitted.length - 1 })
            }
            nextEmit++
          }
        }

        const submitTrack = async (orderKey: number, track: any, reason: string) => {
          if (!track || !track.videoId || seen.has(track.videoId)) {
            pending.set(orderKey, null)
            await flush()
            return
          }
          seen.add(track.videoId)
          pending.set(orderKey, { track, reason: sanitizeUserText(reason, 70) })
          await flush()
        }

        // ------------------------------------------------------------------
        // 2. Resolver pool (bounded concurrency, intent-gated)
        // ------------------------------------------------------------------
        let active = 0
        const queue: { seed: SongSeed; orderKey: number; loose: boolean }[] = []
        const assignedKeys = new Set<number>()

        const resolveOne = async (seed: SongSeed, orderKey: number, loose = false) => {
          const tryQuery = async (q: string) => {
            try {
              const r = await ytmSearch(q, 'songs')
              const safe = filterSafeTracks((r.tracks || []).slice(0, 3))
              return safe[0] ?? null
            } catch { return null }
          }
          let raw = await tryQuery(seed.q)
          let usedFallback = false
          if (!raw && seed.q.length > 4) {
            raw = await tryQuery(seed.q.split(' ').slice(0, 4).join(' '))
            usedFallback = true
          }
          if (!raw) {
            await submitTrack(orderKey, null, '')
            return
          }
          const t = trackToPlayer(raw)
          if (!t) {
            await submitTrack(orderKey, null, '')
            return
          }
          if (!loose) {
            // intent gate: resolved track must resemble what was asked for
            const score = intentScore(seed.q, t.title || '', t.artistName || '')
            if (score < 0.34 && !usedFallback) {
              // try the truncated query before giving up
              const alt = await tryQuery(seed.q.split(' ').slice(0, 4).join(' '))
              if (alt) {
                const at = trackToPlayer(alt)
                if (at && intentScore(seed.q, at.title || '', at.artistName || '') >= 0.34) {
                  await submitTrack(orderKey, at, seed.r)
                  return
                }
              }
            }
            if (score < 0.25) {
              await submitTrack(orderKey, null, '')
              return
            }
          }
          await submitTrack(orderKey, t, seed.r)
        }

        const pump = async () => {
          while (queue.length && active < RESOLVE_CONCURRENCY) {
            const job = queue.shift()!
            active++
            void (async () => {
              try {
                await resolveOne(job.seed, job.orderKey, job.loose)
              } finally {
                active--
                void pump()
              }
            })()
          }
        }

        const enqueueSeeds = (seeds: SongSeed[], baseKey: number, cap: number, loose = false) => {
          let placed = 0
          for (let i = 0; i < seeds.length && placed < cap; i++) {
            queue.push({ seed: seeds[i], orderKey: baseKey + placed, loose })
            assignedKeys.add(baseKey + placed)
            placed++
          }
          void pump()
        }

        /** Settle only NEVER-ASSIGNED order keys (in-flight jobs must not be pre-nulled —
         *  their results would strand in `pending` after flush advanced past them). */
        const fillGaps = async (from: number, to: number) => {
          for (let k = from; k < to; k++) {
            if (!assignedKeys.has(k) && !pending.has(k)) pending.set(k, null)
          }
          await flush()
        }

        // ------------------------------------------------------------------
        // 3. Starter tracks (deterministic, instant) + LLM shards
        //    Order keys are DENSE: starters 0..S-1, head shard S..S+A-1,
        //    tail shard S+A..S+A+B-1, fillers after. Gaps are settled by
        //    fillGaps() once shards finish, so ordered emission never stalls.
        // ------------------------------------------------------------------
        send({ type: 'phase', phase: 'understanding' })
        const starters = starterQueries(prompt, profile).map((q) => ({ q, r: 'Quick pick to set the vibe' }))
        const S = starters.length
        enqueueSeeds(starters, 0, S)

        const shardA = Math.min(count, Math.max(6, Math.ceil(count * 0.48)))
        const shardB = count - shardA
        const artistHint = profile.artists.slice(0, 5).map((a) => a.name).join(', ')
        const genreHint = profile.genres.slice(0, 5).join(', ')
        const taste = `${artistHint ? `User likes: ${artistHint}. ` : ''}${genreHint ? `Genre taste: ${genreHint}. ` : ''}Don't force them, only when fitting.`

        const baseSystem = `You are TSF Music's playlist curator. Output COMPACT JSON only — no markdown fences, no prose. Song object keys exactly: "q" (3-7 word YouTube Music search query, pattern "Artist Song Title"), "r" (reason, max 6 words). Rules: no explicit/NSFW songs; well-known songs that search confidently; vary artists (max 2 songs per artist); songs must match the vibe and flow like a real playlist. ${taste}`

        const runShard = async (system: string, user: string, baseKey: number, cap: number, isHead: boolean) => {
          const extractor = createExtractor()
          const localSeeds: SongSeed[] = []
          try {
            await aiChat(
              [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              {
                temperature: 0.75,
                maxTokens: 1800,
                json: true,
                signal: abortAll.signal,
                timeoutMs: 45_000,
                onDelta: (d) => {
                  const got = extractor.push(d)
                  if (isHead) {
                    if (got.title && !title) {
                      title = sanitizeUserText(got.title, 80)
                      ensureMeta()
                    }
                    if (got.description && !description) {
                      description = sanitizeUserText(got.description, 200)
                    }
                  }
                  if (got.songs.length) {
                    const fresh = got.songs.filter((s) => !localSeeds.some((k) => k.q === s.q))
                    localSeeds.push(...fresh)
                    enqueueSeeds(fresh, baseKey + localSeeds.length - fresh.length, cap - localSeeds.length + fresh.length)
                  }
                },
              }
            )
            // final flush of any tail the delta callback didn't cover
            const fin = extractor.push('')
            if (fin.songs.length) {
              const fresh = fin.songs.filter((s) => !localSeeds.some((k) => k.q === s.q))
              localSeeds.push(...fresh)
              enqueueSeeds(fresh, baseKey + localSeeds.length - fresh.length, cap - localSeeds.length + fresh.length)
            }
            // if head shard produced no title via deltas, try full parse
            if (isHead && !title) {
              const full = parseTolerantJson<{ title?: string; description?: string }>(extractor.text())
              if (full?.title) {
                title = sanitizeUserText(full.title, 80)
                ensureMeta()
              }
              if (full?.description) description = sanitizeUserText(full.description, 200)
            }
          } catch {
            // shard failed — deterministic filler covers the gap below
          }
        }

        send({ type: 'phase', phase: 'curating' })
        const shardPromises: Promise<void>[] = []
        // dense order keys: starters 0..S-1, head shard S..S+A-1, tail S+A..
        shardPromises.push(runShard(
          baseSystem + ' Also include top-level "title" (catchy, max 6 words) and "description" (one sentence). Shape: {"title":"...","description":"...","songs":[...]}',
          `Prompt: "${prompt}". Return the FIRST ${shardA} songs (positions 1-${shardA} of a ${count}-song playlist).`,
          S,
          shardA,
          true
        ))
        if (shardB > 0) {
          shardPromises.push(runShard(
            baseSystem + ' Shape: {"songs":[...]}.',
            `Prompt: "${prompt}". Return ONLY songs ${shardA + 1}-${count} (the continuation of a ${count}-song playlist, no title).`,
            S + shardA,
            shardB,
            false
          ))
        }

        await Promise.allSettled(shardPromises)
        // settle any keys the shards never produced (LLM returned fewer songs)
        await fillGaps(0, S + shardA + shardB)

        // ------------------------------------------------------------------
        // 5. Backfill if LLM under-delivered (deterministic expansion)
        // ------------------------------------------------------------------
        // wait for resolver queue to drain
        const drainDeadline = Date.now() + 20_000
        while ((queue.length || active > 0) && Date.now() < drainDeadline) {
          await new Promise((r) => setTimeout(r, 100))
        }
        const have = emitted.length
        let fillBase = S + shardA + shardB
        if (have < count) {
          send({ type: 'phase', phase: 'filling' })
          const filler: SongSeed[] = []
          const mk = (q: string, r: string) => ({ q, r })
          filler.push(mk(`${prompt} hits`, 'Matches the theme'))
          filler.push(mk(`${prompt} mix`, 'Matches the theme'))
          for (const a of profile.artists.slice(0, 3)) filler.push(mk(`${a.name} ${prompt.slice(0, 30)}`, `You like ${a.name}`))
          for (let i = 1; filler.length + have < count && i <= 10; i++) {
            filler.push(mk(`${prompt} song ${i}`, 'Matches the theme'))
          }
          // fillers are loose by design (theme-derived queries) — bounded pool
          enqueueSeeds(filler, fillBase, filler.length, true)
          const fillDeadline = Date.now() + 20_000
          while ((queue.length || active > 0) && Date.now() < fillDeadline) {
            await new Promise((r) => setTimeout(r, 100))
          }
        }

        // ------------------------------------------------------------------
        // 6. Finalize
        // ------------------------------------------------------------------
        if (!emitted.length) {
          send({ type: 'error', message: 'Could not resolve any songs for this prompt. Try a different description.' })
          closed = true
          controller.close()
          return
        }

        ensureMeta()
        const pl = await ensurePlaylist()

        const aiPlaylist = await db.aiPlaylist.create({
          data: { prompt, playlistId: pl.id, model: 'tsf-engine' },
        }).catch(() => null)
        if (aiPlaylist) {
          await Promise.all(emitted.map((e) =>
            db.aiSeedTrack.create({
              data: { aiPlaylistId: aiPlaylist.id, trackId: e.track.videoId, reason: e.reason },
            }).catch(() => {})
          ))
        }

        // cache final payload (24h)
        try {
          const reasons: Record<string, string> = {}
          for (const e of emitted) reasons[e.track.videoId] = e.reason
          const payload = JSON.stringify({ title, description, tracks: emitted.map((e) => e.track), reasons })
          await db.apiCache.upsert({
            where: { key: cacheKey },
            update: { payload, expiresAt: new Date(Date.now() + CACHE_TTL_MS) },
            create: { key: cacheKey, payload, expiresAt: new Date(Date.now() + CACHE_TTL_MS) },
          })
        } catch { /* non-fatal */ }

        send({
          type: 'done',
          playlistId: pl.id,
          title,
          total: emitted.length,
          ms: Date.now() - startedAt,
        })
        closed = true
        controller.close()
      } catch (e) {
        try {
          send({ type: 'error', message: 'Generation failed. Try again.' })
          closed = true
          controller.close()
        } catch { /* stream already closed */ }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
