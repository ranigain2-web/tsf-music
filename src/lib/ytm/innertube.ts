/**
 * TSF Music — InnerTube request layer with TTL cache, retry & backoff
 */
import { CLIENTS, type InnertubeClient } from './clients'
import { db } from '@/lib/db'

const memoryCache = new Map<string, { payload: unknown; expires: number }>()
const MEMORY_TTL = 5 * 60 * 1000
const DB_TTL_HOURS = 24

let inflight = new Map<string, Promise<unknown>>()

export class InnertubeError extends Error {
  constructor(
    message: string,
    public status?: number,
    public client?: string
  ) {
    super(message)
    this.name = 'InnertubeError'
  }
}

async function dbGet(key: string): Promise<unknown | null> {
  try {
    const row = await db.apiCache.findUnique({ where: { key } })
    if (!row) return null
    if (new Date(row.expiresAt).getTime() < Date.now()) {
      await db.apiCache.delete({ where: { key } }).catch(() => {})
      return null
    }
    return JSON.parse(row.payload)
  } catch {
    return null
  }
}

async function dbSet(key: string, payload: unknown): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + DB_TTL_HOURS * 3600 * 1000)
    await db.apiCache.upsert({
      where: { key },
      update: { payload: JSON.stringify(payload), expiresAt },
      create: { key, payload: JSON.stringify(payload), expiresAt },
    })
  } catch {
    /* cache write failures are non-fatal */
  }
}

export interface FetchOptions {
  client?: InnertubeClient
  cacheTtlMinutes?: number
  noCache?: boolean
  retries?: number
}

export async function ytmFetch<T = any>(
  endpoint: string,
  body: Record<string, unknown>,
  opts: FetchOptions = {}
): Promise<T> {
  const client = opts.client ?? CLIENTS.WEB_REMIX
  const cacheKey = `ytm:${client.name}:${endpoint}:${JSON.stringify(body)}`
  const memTtl = opts.cacheTtlMinutes ?? 30

  // 1. memory cache
  const mem = memoryCache.get(cacheKey)
  if (mem && mem.expires > Date.now() && !opts.noCache) return mem.payload as T

  // 2. dedupe inflight
  if (inflight.has(cacheKey) && !opts.noCache) return inflight.get(cacheKey) as Promise<T>

  // 3. db cache
  if (!opts.noCache) {
    const cached = await dbGet(cacheKey)
    if (cached) {
      memoryCache.set(cacheKey, { payload: cached, expires: Date.now() + MEMORY_TTL })
      return cached as T
    }
  }

  const exec = (async () => {
    const retries = opts.retries ?? 2
    let lastErr: Error | null = null

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${client.host}/youtubei/v1/${endpoint}?key=${client.key}&prettyPrint=false`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': client.userAgent,
            'X-Goog-Api-Format-Version': '2',
            Origin: client.host,
            'Accept-Language': 'en-US,en;q=0.9',
          },
          body: JSON.stringify({ context: { client: client.context }, ...body }),
          signal: AbortSignal.timeout(12000),
        })

        if (!res.ok) {
          throw new InnertubeError(`${endpoint} → HTTP ${res.status}`, res.status, client.name)
        }
        const json = await res.json()
        memoryCache.set(cacheKey, { payload: json, expires: Date.now() + memTtl * 60 * 1000 })
        if (!opts.noCache) void dbSet(cacheKey, json)
        return json as T
      } catch (e) {
        lastErr = e as Error
        // backoff: 400ms, 1.2s
        if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * Math.pow(3, attempt)))
      }
    }
    throw lastErr ?? new InnertubeError('unknown failure')
  })()

  if (!opts.noCache) {
    inflight.set(cacheKey, exec)
    exec.finally(() => inflight.delete(cacheKey)).catch(() => {})
  }
  return exec as Promise<T>
}
