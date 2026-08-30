/**
 * SEARCH V2 · S1 — RETRIEVE (parallel fan-out, wall-time = max probe).
 * Ported from the reference engine (TSF-MUSIC v3.4 src/search/retrieve.ts),
 * probes re-targeted to OUR providers:
 *
 *   primary  → our YT Music catalog search (src/lib/ytm search(): songs
 *              + videos dual-merged, safety-filtered, catalog-persisted)
 *   secondary→ JioSaavn search.getResults on the NORMALIZED query — the
 *              authority/verification provider (playCount, lyricsSnippet,
 *              full credits) + thin-pool fallback rows
 *   itunes   → RESCUE LADDER ONLY (reference's thin-pool iTunes top-up
 *              intentionally NOT here — mission contract)
 *
 * LRU-200 result cache (10 min TTL) + in-flight dedupe answer before the
 * network. All probes share one AbortSignal per generation (the request's
 * own — server generations die when the client disconnects).
 */

import { search as ytmSearch, type YtmTrack } from '@/lib/ytm'
import { filterSafeTracks } from '@/lib/safety'
import type { SearchPlan } from './plan'
import { correctedQuery } from './plan'
import { feedLexicon } from './lexicon'
import { ytmToRow, saavnToRow, type SearchRow } from './rows'
import { searchSaavnCatalog } from './saavn-catalog'

const CACHE_MAX = 200;
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  at: number;
  rows: SearchRow[];
  /** SIG declaration stored with the final ranked list (§3.1) */
  sig?: { sigState?: string; partialArtists?: string[] };
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SearchRow[]>>();

function cacheGet(key: string): CacheEntry | null {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    cache.delete(key);
    cache.set(key, hit); // refresh recency
    return hit;
  }
  if (hit) cache.delete(key);
  return null;
}

function cacheSet(key: string, rows: SearchRow[], sig?: CacheEntry['sig']): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { at: Date.now(), rows, sig });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Probe strings for a plan (SIG M1.2 rework of the §5.2 table).
 *  Rules: probes are UNIQUE (raw ≡ normalized wasted a slot in v3.3.0),
 *  connectors never enter a probe, variant spellings ride the fan-out
 *  for title/artist_title kinds, and the useless surname-only probe is
 *  gone. Hard cap 4 — wall time = max probe. */
export function probesFor(plan: SearchPlan): string[] {
  const title = plan.titleTokens.join(' ');
  switch (plan.kind) {
    case 'entity_title': {
      const out = [title || plan.normalized];
      for (const v of plan.variants) if (!out.includes(v)) out.push(v);
      const norm = plan.normalized;
      if (!out.includes(norm)) out.push(norm);
      return out.slice(0, 4);
    }
    case 'entity_artist':
      return [`${plan.normalized} songs`, plan.normalized];
    case 'artist_title': {
      // the highest-signal probe is the CLEAN title (connectors gone —
      // they hijack natural-language phrases into junk on the provider);
      // an artist-context probe follows, then spelling variants
      const out: string[] = [];
      if (title && !out.includes(title)) out.push(title);
      const withArtist = plan.artistTokens.length ? `${title} ${plan.artistTokens.join(' ')}`.trim() : '';
      if (withArtist && !out.includes(withArtist)) out.push(withArtist);
      for (const v of plan.variants) if (!out.includes(v)) out.push(v);
      return out.slice(0, 4);
    }
    case 'lyric_fragment':
      return [plan.normalized, ...plan.windows].slice(0, 3);
    default:
      return [plan.normalized];
  }
}

export interface RetrievalResult {
  pools: Array<{ pool: string; rows: SearchRow[] }>;
  cacheHit: boolean;
  probes: string[];
  sig?: { sigState?: string; partialArtists?: string[] };
}

/** In-flight dedupe wrapper (exact palette-engine pattern). */
function deduped<T>(map: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  const existing = map.get(key);
  if (existing) return existing;
  const p = make().finally(() => map.delete(key));
  map.set(key, p);
  return p;
}

/** One YTM catalog probe — never throws (fail-soft to []). */
async function ytmProbe(q: string, signal?: AbortSignal): Promise<SearchRow[]> {
  try {
    if (signal?.aborted) return [];
    const res = await ytmSearch(q, 'songs');
    const rows = filterSafeTracks(res.tracks ?? []).map((t: YtmTrack, i: number) => ytmToRow(t, i));
    return rows;
  } catch {
    return [];
  }
}

/**
 * Run the fan-out for a plan. Never throws — probe failures degrade
 * to empty pools; the caller decides thin/zero from the merged set.
 */
export async function retrieve(
  plan: SearchPlan,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<RetrievalResult> {
  const { limit = 30, signal } = opts;
  const cached = cacheGet(plan.cacheKey);
  if (cached) {
    return { pools: [{ pool: 'cache', rows: cached.rows }], cacheHit: true, probes: [], sig: cached.sig };
  }
  const existing = inFlight.get(plan.cacheKey);
  if (existing) {
    const rows = await existing;
    return { pools: [{ pool: 'cache', rows }], cacheHit: true, probes: [] };
  }

  const probeStrings = probesFor(plan);
  const corrected = correctedQuery(plan);
  const allProbes =
    corrected && corrected !== plan.normalized ? [...probeStrings, corrected] : probeStrings;

  const job = (async () => {
    // ≤4 YTM catalog probes in parallel (wall = max probe) + ONE JioSaavn
    // authority probe on the normalized query (non-fatal; its rows carry
    // the playCount/credits the YTM rows lack)
    const ytmPools = await Promise.all(
      allProbes.slice(0, 4).map(async (q) => {
        try {
          return await ytmProbe(q, signal);
        } catch {
          return [] as SearchRow[];
        }
      }),
    );
    const saavnRows = await searchSaavnCatalog(plan.normalized, limit, signal).catch(() => [] as SearchRow[]);
    return { ytmPools, saavnRows };
  })();

  // In-flight dedupe (P1-1): concurrent generations of the SAME key share
  // one fan-out; the slot is cleared on settle (failure included).
  const tracked = job.catch(() => ({ ytmPools: [] as SearchRow[][], saavnRows: [] as SearchRow[] }));
  void tracked.finally(() => inFlight.delete(plan.cacheKey));
  inFlight.set(
    plan.cacheKey,
    tracked.then((r) => [...r.ytmPools.flat(), ...r.saavnRows]),
  );

  const { ytmPools, saavnRows } = await job;

  // results feed the lexicon (titles/artists become correction vocab)
  for (const pool of ytmPools) {
    feedLexicon(pool.slice(0, 10).flatMap((t) => [t.title, ...(t.artistsFull ?? [t.artistName])]));
  }
  feedLexicon(saavnRows.slice(0, 10).flatMap((t) => [t.title, ...(t.artistsFull ?? [t.artistName])]));

  const pools: Array<{ pool: string; rows: SearchRow[] }> = allProbes
    .slice(0, 4)
    .map((q, i) => ({ pool: `p${i + 1}`, rows: ytmPools[i] ?? [] }));
  if (saavnRows.length > 0) pools.push({ pool: 'saavn', rows: saavnRows });

  return { pools, cacheHit: false, probes: allProbes };
}

/** Cache write — called by the orchestrator AFTER rank (stores the
 *  final ranked list so cache hits return exactly what was painted,
 *  SIG declaration included). */
export function rememberResults(
  plan: SearchPlan,
  rows: SearchRow[],
  sig?: { sigState?: string; partialArtists?: string[] },
): void {
  if (rows.length > 0) {
    cacheSet(plan.cacheKey, rows.slice(0, 30), sig);
  }
}

/** Direct access for tests. */
export function cacheSize(): number {
  return cache.size;
}

/** Test/eval hook — drain the result cache + in-flight map between cases. */
export function clearSearchCaches(): void {
  cache.clear();
  inFlight.clear();
}

/** saavnToRow re-export guard — used by the engine's origin probe. */
export { saavnToRow };
