import { db } from '@/lib/db'

/**
 * TSF Music — hardened API cache with stale-while-revalidate.
 *
 * Fixes the Bar-1 killer found in QA: a transient upstream failure produced
 * an EMPTY payload which was then cached for 4 hours (home showed skeletons
 * long after the network recovered).
 *
 * Semantics:
 *  - fresh cache hit  → served instantly
 *  - expired cache    → stale served instantly, rebuild runs in background
 *  - empty build      → NEVER cached; stale (if any) served instead
 */
export async function cachedJson<T>(opts: {
  key: string
  ttlMs: number
  build: () => Promise<T>
  isEmpty: (v: T) => boolean
  /** mutate a stale/fresh entry on serve (e.g. refresh the time greeting). */
  refresh?: (v: T) => Partial<T>
}): Promise<T> {
  const { key, ttlMs, build, isEmpty, refresh } = opts

  let stale: T | null = null
  let hasFreshRow = false
  try {
    const row = await db.apiCache.findUnique({ where: { key } })
    if (row) {
      try { stale = JSON.parse(row.payload) as T } catch { stale = null }
      hasFreshRow = row.expiresAt.getTime() > Date.now()
    }
  } catch { /* cache read failure → fall through to build */ }

  if (stale !== null && hasFreshRow) {
    return refresh ? ({ ...stale, ...refresh(stale) } as T) : stale
  }

  if (stale !== null) {
    // stale-while-revalidate: serve now, rebuild in background
    void (async () => {
      try {
        const fresh = await build()
        if (!isEmpty(fresh)) {
          await db.apiCache.upsert({
            where: { key },
            update: { payload: JSON.stringify(fresh), expiresAt: new Date(Date.now() + ttlMs) },
            create: { key, payload: JSON.stringify(fresh), expiresAt: new Date(Date.now() + ttlMs) },
          }).catch(() => {})
        }
      } catch { /* background rebuild failed — stale stays */ }
    })()
    return refresh ? ({ ...stale, ...refresh(stale) } as T) : stale
  }

  // no cache at all → synchronous build
  const fresh = await build()
  if (!isEmpty(fresh)) {
    try {
      await db.apiCache.upsert({
        where: { key },
        update: { payload: JSON.stringify(fresh), expiresAt: new Date(Date.now() + ttlMs) },
        create: { key, payload: JSON.stringify(fresh), expiresAt: new Date(Date.now() + ttlMs) },
      })
    } catch { /* non-fatal */ }
  }
  return fresh
}
