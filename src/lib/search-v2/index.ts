/**
 * SEARCH V2 — the ENGINE orchestrator (S0→S5 + rescue) behind
 * searchMusicV2. Ported from the reference engine (TSF-MUSIC v3.4
 * src/api/music.ts searchMusicV2), re-hosted server-side for the web
 * edition on OUR providers + OUR Prisma ledger.
 *
 *   S0 plan (classify + SymSpell)  →  S1 parallel probes (abortable,
 *   LRU-200 cache + in-flight dedupe) →  S2 id-dedupe + version-cluster
 *   (+ lyric verify V1 now / V2 async)  →  S3 rank (deterministic +
 *   disambiguation override + truthful closed-set reasons)  →  paint
 *   →  SIG rescue ladder (title-truth v3.4) when the specific intent is
 *   unmet  →  S4 relaxation ladder if thin  →  S5 learn (after paint).
 *
 * SERVER-ONLY module (import discipline: only route handlers under
 * src/app/api/ytm/* import this).
 */

import type { SearchPlan } from './plan';
import { planSearch, correctedQuery, registerArtistLexicon, registerVibeVocab } from './plan';
import { retrieve, rememberResults, type RetrievalResult } from './retrieve';
import { verifySet, verifyLyrics, snippetEcho, type Candidate } from './verify';
import { rankRows, withReasonLines, type RankedRow, type RankContext } from './rank';
import { RELAXATION_RUNGS, THIN_THRESHOLD } from './recover';
import {
  recallResolve,
  engagementForQuery,
  creditPastClicks,
  prismaLearnDeps,
  type LearnDeps,
  type ResolvedFragment,
} from './learn';
import { ARTIST_PRIORS, MOOD_PRIORS, GENRE_PRIORS, ARTIST_SEED_NAMES } from './priors';
import { searchSaavnCatalog } from './saavn-catalog';
import { searchLyricByFragment } from './lrclib';
import {
  buildLexicon,
  lexiconReady,
  restoreLexicon,
  snapshotLexicon,
  SNAPSHOT_KEY,
} from './lexicon';
import { sigUnmet, runRescueLadder, titleAuthorityMissing, type RescueRung } from './rescue';
import { compileProfile, loadCorrections } from '@/lib/mindbeat/profile'
import type { SearchRow } from './rows'

export type { SearchRow, SearchPlan, RetrievalResult, Candidate, RankedRow }
export { snippetEcho, verifyLyrics }

export type SigState = 'hit' | 'rescued' | 'partial' | 'zero';

export interface SearchV2Result {
  rows: SearchRow[];
  plan: SearchPlan;
  topReason?: string;
  corrected?: string;
  relaxedFrom?: string;
  relaxedQuery?: string;
  latencyMs: number;
  correlationId: string;
  probes?: string[];
  /** SIG (§3.1): the declared four-state outcome — the UI must show it */
  sigState?: SigState;
  /** title-matching pool artists for the S-PARTIAL disambiguation chips */
  partialArtists?: string[];
  /** rescue provenance (for the honest label + ledger) */
  rescueRung?: RescueRung;
  /** per-stage latency instrumentation (server log + response) */
  stages: StageTimings;
}

export interface StageTimings {
  s0PlanMs: number
  s1RetrieveMs: number
  s2VerifyMs: number
  s3RankMs: number
  rescueMs: number
  recoverMs: number
  learnMs: number
  totalMs: number
}

/** Deps the engine needs (mindbeat + kill-switch override). */
export interface EngineDeps extends LearnDeps {
  artistAffinity?: (artist: string) => number;
  mutedArtists?: () => Set<string>;
}

// ---------------------------------------------------------------------------
// Lexicon init (lazy singleton on first search-v2 request)
// ---------------------------------------------------------------------------

let lexiconInitPromise: Promise<void> | null = null;

/** Assemble the SymSpell lexicon + classifier vocab (lazy, once). */
export async function initSearchEngine(deps?: EngineDeps): Promise<void> {
  if (lexiconInitPromise) return lexiconInitPromise;
  lexiconInitPromise = (async () => {
    // 1. classifier vocab — vibe words from the MINDBEAT priors
    const vibeWords = new Set<string>();
    for (const m of MOOD_PRIORS) {
      vibeWords.add(m.key);
      (m.words ?? []).forEach((w: string) => vibeWords.add(w));
    }
    Object.keys(GENRE_PRIORS).forEach((g) => vibeWords.add(g));
    registerVibeVocab(Array.from(vibeWords));

    // 2. artist lexicon — priors + seeds + the profile's top artists
    let profileArtists: string[] = [];
    try {
      const profile = await compileProfile().catch(() => null);
      if (profile) {
        profileArtists = Object.values(profile.artists)
          .sort((a, b) => b.w - a.w)
          .slice(0, 24)
          .map((a) => a.name)
          .filter(Boolean);
      }
    } catch {
      /* cold profile is fine — priors + seeds carry the lexicon */
    }
    const artists = [
      ...Object.keys(ARTIST_PRIORS),
      ...ARTIST_SEED_NAMES,
      ...profileArtists,
    ];
    registerArtistLexicon(artists);

    // 3. SymSpell — snapshot restore first (cold rebuild <20 ms), scratch
    //    build as fallback
    let restored = false;
    if (deps) {
      const snap = await deps.kvGet<string>(SNAPSHOT_KEY).catch(() => null);
      if (snap) restored = restoreLexicon(snap);
    }
    if (!restored && !lexiconReady()) {
      const recents = await recentSearchTerms().catch(() => [] as string[]);
      buildLexicon([artists, Array.from(vibeWords)], recents);
    }
  })();
  return lexiconInitPromise;
}

/** Recent distinct search strings from OUR ledger (SEARCH_QUERY, 30d). */
async function recentSearchTerms(): Promise<string[]> {
  try {
    const { getRecentEventsByType } = await import('@/lib/mindbeat/ledger')
    const rows = await getRecentEventsByType('SEARCH_QUERY', 30 * 24 * 3600 * 1000, 60).catch(() => [])
    const out: string[] = []
    const seen = new Set<string>()
    for (const r of rows) {
      const q = typeof r.payload?.query === 'string' ? r.payload.query : ''
      const k = q.toLowerCase().trim()
      if (q && k && !seen.has(k)) {
        seen.add(k)
        out.push(q)
      }
    }
    return out
  } catch {
    return []
  }
}

/** Persist the lexicon snapshot (fire-and-forget after searches). */
export function persistLexicon(deps: EngineDeps): void {
  void deps.kvSet(SNAPSHOT_KEY, snapshotLexicon()).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Rank-context reads (profile affinity + mutes, 60 s memo)
// ---------------------------------------------------------------------------

let ctxMemo: { at: number; affinity: Record<string, number>; muted: Set<string> } | null = null;
const CTX_MEMO_MS = 60 * 1000;

async function rankContextReads(): Promise<{ affinity: Record<string, number>; muted: Set<string> }> {
  if (ctxMemo && Date.now() - ctxMemo.at < CTX_MEMO_MS) {
    return { affinity: ctxMemo.affinity, muted: ctxMemo.muted };
  }
  const affinity: Record<string, number> = {};
  const muted = new Set<string>();
  try {
    const [profile, corrections] = await Promise.all([
      compileProfile().catch(() => null),
      loadCorrections().catch(() => null),
    ]);
    if (profile) {
      for (const [key, a] of Object.entries(profile.artists)) {
        if (a.w > 0) affinity[key.toLowerCase()] = a.w;
      }
    }
    if (corrections) {
      for (const m of corrections.mutedArtists) muted.add(m.toLowerCase());
    }
  } catch {
    /* taste reads are best-effort — search never breaks on them */
  }
  ctxMemo = { at: Date.now(), affinity, muted };
  return { affinity, muted };
}

// ---------------------------------------------------------------------------

function correlationId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function toRowList(ranked: RankedRow[]): SearchRow[] {
  return withReasonLines(ranked).map((t) => ({
    ...t,
    planKind: t.planKind ?? undefined,
  }));
}

export interface SearchV2Options {
  signal?: AbortSignal;
  deps?: EngineDeps;
  /** progressive paint: ranked primary pool before rescue/recovery finish */
  onEarly?: (r: SearchV2Result) => void;
  /** per-stage latency sink (server log) */
  onStages?: (stages: StageTimings) => void;
}

/**
 * The V2 search pipeline. Never throws — failures degrade to empty.
 * `rows` in the result; the NDJSON route maps them 1:1 onto the wire.
 */
export async function searchMusicV2(
  query: string,
  opts: SearchV2Options = {},
): Promise<SearchV2Result> {
  const t0 = Date.now();
  const deps: EngineDeps = opts.deps ?? prismaLearnDeps();
  const tS0 = Date.now();
  await initSearchEngine(deps);
  const plan = planSearch(query);
  const s0PlanMs = Date.now() - tS0;
  const corrId = correlationId();
  const corrected = correctedQuery(plan) ?? undefined;

  const base = {
    plan,
    corrected,
    correlationId: corrId,
  };

  const zeroStages = (ms: Partial<StageTimings> = {}): StageTimings => ({
    s0PlanMs, s1RetrieveMs: 0, s2VerifyMs: 0, s3RankMs: 0,
    rescueMs: 0, recoverMs: 0, learnMs: 0, totalMs: Date.now() - t0, ...ms,
  });

  if (plan.kind === 'browse') {
    const stages = zeroStages();
    opts.onStages?.(stages);
    return { rows: [], latencyMs: Date.now() - t0, probes: [], stages, ...base };
  }

  // ── S5 learning reads fire CONCURRENTLY with S1 (P0-4 fix): the
  //    probes are NEVER blocked by the ledger scan / kv reads, and a
  //    cache hit answers before learning even lands.
  const learningPromise: Promise<{
    engagement: Record<string, number>;
    muted: Set<string>;
    resolved: ResolvedFragment | null;
  }> =
    deps && !deps.disabled()
      ? Promise.all([
          engagementForQuery(deps, plan.normalized),
          rankContextReads().then((r) => r.muted),
          recallResolve(deps, plan.normalized).catch(() => null),
        ]).then(([engagement, muted, resolved]) => ({ engagement, muted, resolved }))
      : Promise.resolve({ engagement: {}, muted: new Set<string>(), resolved: null });

  // ── S1 retrieval (cache-first: hits answer in <15 ms with zero reads).
  //    Lyric plans ALSO fire the LRCLIB fragment resolver in parallel —
  //    it does not depend on the pools.
  const tS1 = Date.now();
  const originPromise =
    plan.kind === 'lyric_fragment'
      ? searchLyricByFragment(plan.normalized, opts.signal)
      : Promise.resolve(null);
  const retrieval = await retrieve(plan, { signal: opts.signal, limit: 30 });
  const s1RetrieveMs = Date.now() - tS1;
  if (retrieval.cacheHit && !opts.signal?.aborted) {
    const rows = retrieval.pools[0]?.rows ?? [];
    const stages = zeroStages({ s1RetrieveMs });
    opts.onStages?.(stages);
    return {
      rows,
      latencyMs: Date.now() - t0,
      probes: [],
      topReason: rows[0]?.reason,
      sigState: retrieval.sig?.sigState as SigState | undefined,
      partialArtists: retrieval.sig?.partialArtists,
      stages,
      ...base,
    };
  }

  // ── S2 verify (sync stages) — plus the resolved origin's own catalog
  //    probe when LRCLIB identified the song (the provider's own results
  //    for a fragment may be ALL covers; the origin injects the canonical
  //    recording into the candidate pool)
  const tS2 = Date.now();
  const pools = [...retrieval.pools];
  const origin = plan.kind === 'lyric_fragment' ? await originPromise : null;
  if (origin && !opts.signal?.aborted) {
    try {
      const originRows = await searchSaavnCatalog(
        `${origin.title} ${origin.artist.split(',')[0]?.trim()}`,
        15,
        opts.signal,
      );
      if (originRows.length > 0) pools.push({ pool: 'origin', rows: originRows });
    } catch {
      /* origin resolve is opportunistic */
    }
  }
  const verified = verifySet(plan, pools);
  const s2VerifyMs = Date.now() - tS2;

  // learning results join HERE (post-retrieval, pre-rank) — probes never
  // waited on them; if learning is slower than the network it simply
  // doesn't influence this generation (next search gets it).
  const { engagement, muted, resolved } = await learningPromise;
  const { affinity } = await rankContextReads();
  const affinityForRows: Record<string, number> = {};
  if (deps?.artistAffinity) {
    for (const row of verified.rows) {
      for (const a of row.artistsFull ?? [row.artistName]) {
        const key = a.toLowerCase();
        if (!(key in affinityForRows)) {
          const v = deps.artistAffinity(key);
          if (v > 0) affinityForRows[key] = v;
        }
      }
    }
  }

  // ── S3 rank (V1 lyric signals already on rows; V2 lands async)
  const tS3 = Date.now();
  const ctx: RankContext = {
    engagement,
    artistAffinity: deps?.artistAffinity ? { ...affinity, ...affinityForRows } : affinity,
    mutedArtists: muted,
  };
  const earlyRanked = rankRows(plan, verified.rows, ctx);
  const s3RankMs = Date.now() - tS3;

  // PROGRESSIVE PAINT (P0-2 fix): the ranked set paints the moment it is
  // ready; recovery/superset work continues below.
  if (opts.onEarly && earlyRanked.length > 0 && !opts.signal?.aborted) {
    opts.onEarly({
      rows: toRowList(earlyRanked),
      latencyMs: Date.now() - t0,
      probes: retrieval.probes,
      stages: { s0PlanMs, s1RetrieveMs, s2VerifyMs, s3RankMs, rescueMs: 0, recoverMs: 0, learnMs: 0, totalMs: Date.now() - t0 },
      ...base,
    });
  }

  // ── SIG GATE (M3): a specific-intent query that produced no row
  //    matching BOTH axes must escalate, never paint artist-only junk
  //    as "Best match". Rung order: YouTube (full length) → iTunes
  //    (30 s preview) → variant spellings → album route. Bounded 3 s;
  //    after-paint (onEarly already fired the organic set).
  let ranked: RankedRow[] = earlyRanked;
  let sigState: SigState | undefined;
  let partialArtists: string[] | undefined;
  let rescueRung: RescueRung | undefined;
  // P0-2 lock: the ladder's verified rows, kept so the paint contract can
  // re-inject them if clustering unions the rescued row away.
  let rescueRows: SearchRow[] | null = null;
  const tRescue = Date.now();
  const artistPlan = plan.kind === 'artist_title';
  if (artistPlan && !opts.signal?.aborted) {
    const unmet = sigUnmet(plan, earlyRanked);
    if (unmet) {
      const rescue = await runRescueLadder(plan, { signal: opts.signal });
      if (rescue.rows.length > 0) {
        rescueRows = rescue.rows;
        rescueRung = rescue.rung;
        const merged = verifySet(plan, [{ pool: 'rescue', rows: rescue.rows }, { pool: 'organic', rows: toRowList(earlyRanked) }]);
        ranked = rankRows(plan, merged.rows, ctx);
        sigState = 'rescued';
      } else {
        sigState = earlyRanked.some((r) => r.queryMatch >= 0.5) ? 'partial' : 'zero';
        if (sigState === 'partial') {
          const seen = new Set<string>();
          partialArtists = [];
          for (const r of earlyRanked.filter((x) => x.queryMatch >= 0.5)) {
            for (const a of r.artistsFull ?? [r.artistName]) {
              const key = a.toLowerCase();
              if (!seen.has(key)) {
                seen.add(key);
                partialArtists.push(a);
              }
            }
          }
          partialArtists = partialArtists.slice(0, 8);
        }
      }
    } else {
      sigState = 'hit';
    }
  } else if (
    plan.kind === 'entity_title' &&
    earlyRanked.length > 0 &&
    !opts.signal?.aborted
  ) {
    // TITLE-ONLY AUTHORITY GAP ("tu chaiye" class): the query is just a
    // song title, the catalog answered with title-matching rows, but every
    // one of them is a deep-niche cover/remake — the canonical recording
    // the user means is missing from the catalog. Escalate once via the
    // rescue ladder; an authoritative row (≥ AUTHORITY_FLOOR plays/views)
    // paints on top as S-RESCUED. If the ladder finds nothing credible we
    // keep the organic list silently — title matches ARE honest answers
    // for a title query, so no false partial/zero is claimed.
    if (titleAuthorityMissing(earlyRanked)) {
      const rescue = await runRescueLadder(plan, { signal: opts.signal });
      if (rescue.rows.length > 0) {
        rescueRows = rescue.rows;
        rescueRung = rescue.rung;
        const merged = verifySet(plan, [{ pool: 'rescue', rows: rescue.rows }, { pool: 'organic', rows: toRowList(earlyRanked) }]);
        ranked = rankRows(plan, merged.rows, ctx);
        sigState = 'rescued';
      }
    } else {
      sigState = 'hit';
    }
  }
  const rescueMs = Date.now() - tRescue;

  // SIG paint contract: the rescued row IS the declared answer — it
  // paints at rank 1 with the "Best match" reason regardless of what the
  // organic covers scored (the +0.75 promotion narrows the gap; this
  // closes it deterministically for both the artist_title and
  // title-only paths).
  if (sigState === 'rescued') {
    let ri = ranked.findIndex((r) => r.rescued);
    if (ri === -1 && rescueRows) {
      // P0-2: clustering dropped the rescued row (organic same-cluster rep
      // won). Title truth (contract #1) outranks dedupe: re-inject the
      // ladder's dual-verified rows at the top instead of fabricating a
      // 'rescued' state over organic covers.
      const ids = new Set(ranked.map((r) => r.id));
      const reinjected = rescueRows
        .filter((t) => !ids.has(t.id))
        .map((t) => ({
          ...t,
          pool: 'rescue' as const,
          poolRank: 0,
          score: 10,
          artistMatch: 1,
          queryMatch: 1,
          reasonCode: 'MATCHES_SEARCH' as const,
        }));
      ranked = [...reinjected, ...ranked];
      ri = reinjected.length > 0 ? 0 : -1;
    }
    if (ri > 0) {
      const [hit] = ranked.splice(ri, 1);
      ranked = [{ ...hit, reasonCode: 'MATCHES_SEARCH' as const }, ...ranked];
    }
  }

  // fragment→track cache (§5.6 — lyric plans ONLY, P1-3 fix): inject the
  // remembered pick at rank 1 with its truthful reason. Never overrides
  // the disambiguation override: artist-mismatched memories are skipped.
  const remembered: ResolvedFragment | null = resolved;
  if (remembered && plan.kind === 'lyric_fragment') {
    const row = ranked.find((r) => r.id === remembered.trackId);
    const artistOk =
      plan.artistTokens.length === 0 ||
      (row?.artistMatch ?? 0) >= 1 ||
      ranked.length === 0;
    if (artistOk) {
      const idx = ranked.findIndex((r) => r.id === remembered.trackId);
      if (idx > 0) {
        const [hit] = ranked.splice(idx, 1);
        ranked = [
          { ...hit, poolRank: 0, score: hit.score + 1.5, reasonCode: 'YOUR_PAST_CLICK' },
          ...ranked,
        ];
      } else if (idx === -1 && ranked.length === 0 && remembered.title) {
        ranked = [
          {
            id: remembered.trackId,
            videoId: remembered.trackId,
            title: remembered.title,
            artistName: remembered.artist || 'Unknown artist',
            duration: 0,
            thumbnail: '',
            source: 'ytm',
            poolRank: 0,
            pool: 'memory',
            score: 5,
            artistMatch: 0,
            queryMatch: 0,
            reasonCode: 'YOUR_PAST_CLICK' as const,
          },
        ];
      }
    }
  }

  // ORIGIN BOOST (S1): when LRCLIB identified the song the fragment
  // belongs to, its row(s) are lyric-MATCHED BY CONSTRUCTION — mark them
  // and float the best one to the top (truthful: we verified its lyrics
  // contain the typed fragment).
  if (origin && ranked.length > 0) {
    const oTitle = origin.title.toLowerCase().trim();
    const oArtistFirst = origin.artist.toLowerCase().split(',')[0]?.trim() ?? '';
    let boosted = false;
    ranked = ranked.map((r) => {
      const titleHit = r.title.toLowerCase().includes(oTitle) || oTitle.includes(r.title.toLowerCase().split(' (')[0] ?? '');
      const artistHit = r.artistName.toLowerCase().includes(oArtistFirst);
      if (titleHit && artistHit && !boosted) {
        boosted = true;
        return { ...r, lyricMatch: true, matchedLine: origin.line, score: r.score + 2.5, reasonCode: 'LYRIC_MATCH' as const };
      }
      return r;
    });
    if (boosted) {
      ranked = [...ranked].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    }
  }

  let rows = toRowList(ranked);
  let relaxedFrom: string | undefined;
  let relaxedQuery: string | undefined;

  // HONEST ZERO (S6 fix + SIG M2.1): if the provider returned rows but NONE
  // actually match the query, treat as zero and fall into recovery — never
  // render unrelated rows as matches. SIG M2.1 tightens the old gate:
  // artistMatch ≥ 1 alone no longer passes (that loophole is exactly what
  // painted O'Meri Laila as "Best match" for "tu chaiye of atif aslam").
  const anyRelevant = ranked.some((r) => r.queryMatch >= 0.34);
  if (!anyRelevant && ranked.length > 0) {
    rows = [];
  }

  // ── S4 recovery ladder (thin/zero only — ≤2 RUNGS, 1.5 s total budget;
  //    P1-6 fix: a deadline kills the climb even mid-rung)
  //    P0-1 lock: NEVER when the SIG rescue succeeded — the rescued row is
  //    the declared answer and relaxation would replace it with relaxed
  //    junk that doesn't contain it (fabricating sigState='rescued' over
  //    an unrelated list). Thin-after-rescue is the honest state.
  const tRecover = Date.now();
  if (rows.length < THIN_THRESHOLD && !opts.signal?.aborted && sigState !== 'rescued') {
    const deadline = Date.now() + 1500;
    let rungsUsed = 0;
    let rungPlan: SearchPlan = plan;
    for (const rung of RELAXATION_RUNGS) {
      if (rows.length >= THIN_THRESHOLD || rungsUsed >= 2) break;
      if (Date.now() >= deadline) break;
      const next: SearchPlan | null = rung(rungPlan);
      if (!next || next.cacheKey === rungPlan.cacheKey) continue;
      rungPlan = next;
      rungsUsed += 1;
      try {
        const r2 = await retrieve(next, { signal: opts.signal, limit: 20 });
        if (opts.signal?.aborted) break;
        const v2 = verifySet(next, r2.pools);
        const rk2 = rankRows(next, v2.rows, ctx);
        if (rk2.length > rows.length) {
          rows = toRowList(rk2);
          relaxedFrom = plan.raw.trim();
          relaxedQuery = next.normalized;
        }
      } catch {
        /* ladder rung failed — keep climbing */
      }
    }
  }
  const recoverMs = Date.now() - tRecover;

  const degraded = rows.length > 0 && rows.every((t) => t.source === 'itunes');
  // aborted generations never poison the 10-min cache (P1-7 fix)
  if (!opts.signal?.aborted) {
    rememberResults(plan, rows, { sigState, partialArtists });
  }

  const totalMs = Date.now() - t0;
  const stages: StageTimings = {
    s0PlanMs, s1RetrieveMs, s2VerifyMs, s3RankMs, rescueMs, recoverMs,
    learnMs: 0, totalMs,
  };

  const result: SearchV2Result = {
    rows,
    latencyMs: totalMs,
    relaxedFrom,
    relaxedQuery,
    probes: retrieval.probes,
    topReason: rows[0]?.reason,
    sigState,
    partialArtists,
    rescueRung,
    stages,
    ...base,
  };

  // ── S5 learn (void — NEVER on the critical path; P2 fix): lexicon
  //    snapshot persist + retroactive query→click credit into the
  //    fragment→track kv.
  if (deps && !deps.disabled()) {
    const tLearn = Date.now();
    void (async () => {
      try {
        persistLexicon(deps);
        await creditPastClicks(deps);
      } catch {
        /* learning is best-effort */
      }
    })();
    stages.learnMs = Date.now() - tLearn; // enqueue cost only (async work continues)
  }

  opts.onStages?.(stages);
  return result;
}

/** Init + deps assembly used by the routes. */
export async function engineDeps(learnOverride?: boolean): Promise<EngineDeps> {
  const deps = prismaLearnDeps(learnOverride);
  await initSearchEngine(deps);
  return deps;
}

/** Used by the route's cache-hit fast path + tests. */
export { clearSearchCaches } from './retrieve'
export type { ResolvedFragment }

// re-export for the SearchScreen's lyric verification pass (UI contract)
export { verifyLyrics as verifyLyricsV2 }
