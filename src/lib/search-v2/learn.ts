/**
 * SEARCH V2 · S5 — LEARN (async, AFTER paint — 0 ms on the critical path).
 * Ported from the reference engine (TSF-MUSIC v3.4 src/search/learn.ts),
 * re-hosted ON TOP OF OUR PRISMA LEDGER:
 *
 *   • correlated (query → click) evidence — the reference read
 *     SEARCH_CLICK payloads that carried normalizedQuery; OUR ledger's
 *     SEARCH_CLICK (13-b contract) carries only { rankInResults }, so
 *     correlation is RECONSTRUCTED server-side: a SEARCH_CLICK belongs to
 *     the latest SEARCH_QUERY in the SAME session within the attribution
 *     window (same join the reference's on-device event store made
 *     trivial).
 *   • fragment→track kv cache ('searchResolves' in db.apiCache; the
 *     reference used its ledger kv) — repeat lyric searches ≈ instant.
 *   • engagement reads for the ranker (past clicks for THIS query,
 *     21-day half-life, 0.6/click decayed, cap 1.2 — feedback ruts are
 *     impossible by design).
 *   • sourceTrust.search feeding (clicked track ≥30 s = credit) kept as
 *     the pure credibleSearchClicks() helper.
 *
 * Kill switch: `intelligenceDisabled` pauses all S5 writes — wired to
 * surfaceFlags().recsOff (src/lib/mindbeat/client.ts) so the same flag
 * the rec surfaces honor governs search learning; callers may override
 * per request (route passes the client's ?learn=0 through).
 */

import { db } from '@/lib/db'
import { surfaceFlags } from '@/lib/mindbeat/client'
import { getRecentEventsByType } from '@/lib/mindbeat/ledger'
import { normalizeQuery } from './normalize'

const FRAGMENT_KEY = 'searchResolves'
const ENGAGEMENT_WINDOW_DAYS = 21;
const HALF_LIFE_DAYS = 21;
const MAX_RESOLVES = 500;
/** A click is attributed to the query that directly preceded it in the
 *  SAME session — never to an older query, even if no newer one exists. */
const ATTRIBUTION_WINDOW_MS = 10 * 60 * 1000;
/** Retro-credit scan horizon (bounded — the ledger holds ≥90d). */
const RETRO_WINDOW_DAYS = 7;

export interface ResolvedFragment {
  trackId: string;
  title: string;
  artist: string;
  at: number;
}

/** Minimal kv + event-reader interfaces — satisfied by the Prisma-backed
 *  deps below and by fixtures in the proof script. */
export interface LearnDeps {
  kvGet<T>(key: string): Promise<T | null>;
  kvSet(key: string, value: unknown): Promise<void>;
  eventsSince(ts: number): Promise<Array<{
    type: string;
    ts: number;
    trackId?: string;
    sessionId?: string;
    payload: Record<string, unknown>;
  }>>;
  disabled(): boolean;
}

export interface SearchCorrelation {
  query: string;
  normalized: string;
  resultCount: number;
  planKind: string;
  probes: string[];
  latencyMs: number;
  corrections: Array<{ from: string; to: string }>;
  correlationId: string;
}

// ---------------------------------------------------------------------------
// Prisma-backed deps (the engine's real LearnDeps)
// ---------------------------------------------------------------------------

async function kvGet<T>(key: string): Promise<T | null> {
  try {
    const row = await db.apiCache.findUnique({ where: { key } })
    if (!row) return null
    return JSON.parse(row.payload) as T
  } catch {
    return null
  }
}

async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    // search-engine kv snapshots are learning state, not request cache —
    // 90d expiry matches the ledger's retention horizon
    const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000)
    await db.apiCache.upsert({
      where: { key },
      update: { payload: JSON.stringify(value), expiresAt },
      create: { key, payload: JSON.stringify(value), expiresAt },
    })
  } catch {
    /* learning is best-effort by contract */
  }
}

interface RawEvent {
  type: string
  ts: number
  trackId?: string
  sessionId?: string
  payload: Record<string, unknown>
}

async function eventsSince(ts: number): Promise<RawEvent[]> {
  try {
    const [queries, clicks] = await Promise.all([
      getRecentEventsByType('SEARCH_QUERY', Date.now() - ts, 500).catch(() => []),
      getRecentEventsByType('SEARCH_CLICK', Date.now() - ts, 500).catch(() => []),
    ])
    const out: RawEvent[] = []
    for (const r of queries) out.push({ type: 'SEARCH_QUERY', ts: r.ts.getTime(), trackId: r.trackId, sessionId: r.sessionId, payload: r.payload })
    for (const r of clicks) out.push({ type: 'SEARCH_CLICK', ts: r.ts.getTime(), trackId: r.trackId, sessionId: r.sessionId, payload: r.payload })
    return out.sort((a, b) => a.ts - b.ts)
  } catch {
    return []
  }
}

/** Server kill switch — surfaceFlags().recsOff (client.ts). On the server
 *  this reads the SSR-safe default (false); the route can harden it with
 *  the client's own flag via `?learn=0` → deps.disabled override. */
export function serverLearnDisabled(): boolean {
  try {
    return surfaceFlags().recsOff === true
  } catch {
    return false
  }
}

export function prismaLearnDeps(disabledOverride?: boolean): LearnDeps {
  return {
    kvGet,
    kvSet,
    eventsSince,
    disabled: () => disabledOverride === true || serverLearnDisabled(),
  }
}

// ---------------------------------------------------------------------------
// Session-correlated click attribution (our ledger's join)
// ---------------------------------------------------------------------------

export interface AttributedClick {
  normalizedQuery: string
  trackId: string
  ts: number
}

/** Join SEARCH_CLICK rows to their session's preceding SEARCH_QUERY. */
export function attributeClicks(events: RawEvent[]): AttributedClick[] {
  const out: AttributedClick[] = []
  const bySession = new Map<string, { queries: Array<{ norm: string; ts: number }>; clicks: Array<{ trackId: string; ts: number }> }>()
  for (const e of events) {
    if (!e.sessionId) continue
    let s = bySession.get(e.sessionId)
    if (!s) {
      s = { queries: [], clicks: [] }
      bySession.set(e.sessionId, s)
    }
    if (e.type === 'SEARCH_QUERY' && typeof e.payload?.query === 'string') {
      s.queries.push({ norm: normalizeQuery(e.payload.query), ts: e.ts })
    } else if (e.type === 'SEARCH_CLICK' && e.trackId) {
      s.clicks.push({ trackId: e.trackId, ts: e.ts })
    }
  }
  for (const s of bySession.values()) {
    for (const c of s.clicks) {
      // latest query at/before the click within the attribution window
      let best: { norm: string; ts: number } | null = null
      for (const q of s.queries) {
        if (q.ts <= c.ts && c.ts - q.ts <= ATTRIBUTION_WINDOW_MS) {
          if (!best || q.ts > best.ts) best = q
        }
      }
      if (best && best.norm) out.push({ normalizedQuery: best.norm, trackId: c.trackId, ts: c.ts })
    }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

// ---------------------------------------------------------------------------
// fragment → track memory (kv 'searchResolves')
// ---------------------------------------------------------------------------

/** Persist a fragment→track resolution (called on attributed clicks). */
export async function rememberResolve(
  deps: LearnDeps,
  normalizedQuery: string,
  track: { id: string; title: string; artist: string },
): Promise<void> {
  if (deps.disabled()) return;
  try {
    const map = (await deps.kvGet<Record<string, ResolvedFragment>>(FRAGMENT_KEY)) ?? {};
    map[normalizedQuery] = {
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      at: Date.now(),
    };
    const keys = Object.keys(map);
    if (keys.length > MAX_RESOLVES) {
      // evict oldest
      keys
        .sort((a, b) => (map[a]?.at ?? 0) - (map[b]?.at ?? 0))
        .slice(0, keys.length - MAX_RESOLVES)
        .forEach((k) => delete map[k]);
    }
    await deps.kvSet(FRAGMENT_KEY, map);
  } catch {
    /* learning is best-effort by contract */
  }
}

/** Look up a remembered resolution for a normalized query. */
export async function recallResolve(
  deps: LearnDeps,
  normalizedQuery: string,
): Promise<ResolvedFragment | null> {
  try {
    const map = (await deps.kvGet<Record<string, ResolvedFragment>>(FRAGMENT_KEY)) ?? {};
    return map[normalizedQuery] ?? null;
  } catch {
    return null;
  }
}

/**
 * RETROACTIVE CREDIT (web adaptation): our clicks arrive through the
 * client instrumentation, so the engine credits past query→click pairs
 * into the fragment→track kv when it runs. Idempotent (a pair already
 * stored with a >= ts is skipped), bounded (RETRO_WINDOW_DAYS, ≤50
 * pairs per call), fire-and-forget by contract.
 */
export async function creditPastClicks(deps: LearnDeps): Promise<void> {
  if (deps.disabled()) return;
  try {
    const events = await deps.eventsSince(Date.now() - RETRO_WINDOW_DAYS * 24 * 3600 * 1000);
    const pairs = attributeClicks(events).slice(-50);
    if (pairs.length === 0) return;
    const map = (await deps.kvGet<Record<string, ResolvedFragment>>(FRAGMENT_KEY)) ?? {};
    // enrich with catalog metadata (our catalog persists every searched
    // track) so the remembered row renders without a second lookup
    const ids = [...new Set(pairs.map((p) => p.trackId))];
    type CatRow = { id: string; title: string; artistName: string }
    const cat: CatRow[] = await db.track
      .findMany({ where: { id: { in: ids } }, select: { id: true, title: true, artistName: true } })
      .catch(() => [] as CatRow[])
    const meta = new Map(cat.map((t): [string, CatRow] => [t.id, t]))
    let dirty = false;
    for (const p of pairs) {
      const existing = map[p.normalizedQuery];
      if (existing && existing.trackId === p.trackId && existing.at >= p.ts) continue;
      const t = meta.get(p.trackId)
      map[p.normalizedQuery] = { trackId: p.trackId, title: t?.title ?? '', artist: t?.artistName ?? '', at: p.ts };
      dirty = true;
    }
    if (dirty) await deps.kvSet(FRAGMENT_KEY, map);
  } catch {
    /* learning is best-effort by contract */
  }
}

// ---------------------------------------------------------------------------
// Engagement for the ranker
// ---------------------------------------------------------------------------

/**
 * Engagement for the ranker: trackId → 0..1.2, computed from correlated
 * SEARCH_CLICK events for the SAME normalized query, decayed by a
 * 21-day half-life. Capped so a couple of clicks can boost but never
 * hijack (provider 3.0 + disambig override still dominate).
 */
export async function engagementForQuery(
  deps: LearnDeps,
  normalizedQuery: string,
  now = Date.now(),
): Promise<Record<string, number>> {
  try {
    if (deps.disabled()) return {};
    const since = now - ENGAGEMENT_WINDOW_DAYS * 24 * 3600 * 1000;
    const events = await deps.eventsSince(since);
    const pairs = attributeClicks(events);
    const out: Record<string, number> = {};
    const lambda = Math.LN2 / (HALF_LIFE_DAYS * 24 * 3600 * 1000);
    for (const p of pairs) {
      if (p.normalizedQuery !== normalizedQuery) continue;
      const age = now - p.ts;
      const decay = Math.exp(-lambda * age);
      // 0.6/click (decayed), cap 1.2 — S8 bar: 2 fresh clicks MUST be
      // able to out-rank provider-order deltas (weight 1.2 in rank.ts)
      out[p.trackId] = Math.min(1.2, (out[p.trackId] ?? 0) + 0.6 * decay);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * sourceTrust.search feeding: search-clicked tracks that reach ≥30 s
 * listened credit the channel. Returns [{trackId}] for the caller to
 * join against listen evidence (kept pure for replay tests).
 */
export function credibleSearchClicks(
  events: Array<{ type: string; ts: number; trackId?: string; payload: Record<string, unknown> }>,
  listensSince: Array<{ trackId: string; ts: number; ratio: number }>,
): Set<string> {
  const clicked = new Set<string>();
  for (const e of events) {
    if (e.type === 'SEARCH_CLICK' && e.trackId) clicked.add(e.trackId);
  }
  const credited = new Set<string>();
  for (const l of listensSince) {
    if (clicked.has(l.trackId) && l.ratio * 100 >= 30) credited.add(l.trackId);
  }
  return credited;
}

/** Normalize through the shared pipeline (exported for the UI). */
export function norm(raw: string): string {
  return normalizeQuery(raw);
}
