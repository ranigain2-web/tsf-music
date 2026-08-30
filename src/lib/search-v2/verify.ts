/**
 * SEARCH V2 · S2 — NORMALIZE + VERIFY (on-server, ≤80 ms for 60 cands).
 * Ported from the reference engine (TSF-MUSIC v3.4 src/search/verify.ts).
 *
 *   1. ID-dedupe across probe pools by row id
 *   2. Version clustering by normalized-title key — duplicate releases
 *      collapse to the best member; "Tum Hi Ho" never merges with
 *      "Tum Hi Ho Bandhu" (the Bandhu token survives)
 *   3. Lyric verification (lyric_fragment plans ONLY — zero cost
 *      otherwise):
 *        V1 (free, always): token overlap of the fragment against the
 *            row's lyricsSnippet + title
 *        V2 (bounded, optional): LRCLIB full-lyrics containment for the
 *            top-3 clusters; graceful skip is the contract
 */

import { clusterKey, normalizeQuery } from './normalize';
import { fetchPlainLyrics } from './lrclib';
import type { SearchPlan } from './plan';
import type { SearchRow } from './rows';

/** A candidate row carrying its probe provenance for ranking. */
export interface Candidate extends SearchRow {
  poolRank: number;
  pool: string;
}

/** S2 output — the verified candidate set + cluster metadata. */
export interface VerifiedSet {
  rows: Candidate[];
  clusters: number;
}

/** Merge probe pools: id-dedupe (keeps best pool rank). */
export function mergePools(pools: Array<{ pool: string; rows: SearchRow[] }>): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const { pool, rows } of pools) {
    rows.forEach((t, i) => {
      if (!t?.id) return;
      const existing = byId.get(t.id);
      if (!existing) {
        byId.set(t.id, { ...t, poolRank: i, pool });
      } else if (i < existing.poolRank) {
        // same id seen earlier in another pool — keep the better rank,
        // remember it appeared in both pools (soft popularity signal)
        byId.set(t.id, { ...existing, poolRank: i, pool: `${existing.pool}+${pool}` });
      } else {
        // enrichment join: a row seen again in a later pool may carry the
        // metric/credits the first copy lacked (YTM rows + saavn authority
        // rows of the same recording keep the same id only cross-provider;
        // same-provider repeats just refresh provenance)
        byId.set(t.id, { ...existing });
      }
    });
  }
  return Array.from(byId.values());
}

/**
 * Cluster duplicate releases (S5). Two-step, live-verified shape:
 *   1. group by clusterKey(title) — "Tum Hi Ho" vs "(From "Aashiqui 2")"
 *   2. inside a title group, merge rows whose artist surnames OVERLAP
 *      (union): the same release is credited [Mithoon] on one row and
 *      [Arijit Singh, Mithoon] on another — overlap merges them, while
 *      covers (Shahid Mallya, zero overlap) stay separate rows.
 */
export function clusterVersions(rows: Candidate[]): Candidate[] {
  const byTitle = new Map<string, Candidate[]>();
  for (const r of rows) {
    const k = clusterKey(r.title);
    const bucket = byTitle.get(k);
    if (bucket) bucket.push(r);
    else byTitle.set(k, [r]);
  }
  const out: Candidate[] = [];
  byTitle.forEach((group) => {
    if (group.length === 1) {
      out.push(group[0]);
      return;
    }
    // union-find over surname overlap
    const clusters: Array<{ rows: Candidate[]; names: Set<string> }> = [];
    for (const r of group) {
      const names = new Set(
        (r.artistsFull?.length ? r.artistsFull : r.artistName.split(/,\s*/))
          .map((a) => a.trim().split(' ').slice(-1)[0]?.toLowerCase() ?? '')
          .filter(Boolean),
      );
      const home = clusters.find((c) => {
        for (const n of names) if (c.names.has(n)) return true;
        return false;
      });
      if (home) {
        home.rows.push(r);
        names.forEach((n) => home.names.add(n));
      } else {
        clusters.push({ rows: [r], names });
      }
    }
    for (const c of clusters) {
      const sorted = [...c.rows].sort(
        (a, b) =>
          a.poolRank - b.poolRank ||
          (b.playCount ?? 0) - (a.playCount ?? 0) ||
          (a.year ?? 9999) - (b.year ?? 9999),
      );
      out.push({ ...sorted[0], versionCount: c.rows.length });
    }
  });
  // keep overall pool order stable-ish after clustering
  out.sort((a, b) => a.poolRank - b.poolRank);
  return out;
}

function fragmentTokens(fragment: string): Set<string> {
  return new Set(
    normalizeQuery(fragment)
      .split(' ')
      .filter((t) => t.length >= 3),
  );
}

/**
 * V1 lyric scoring (free): overlap between the fragment tokens and the
 * row's snippet + title text. Returns 0..1.
 */
export function snippetEcho(plan: SearchPlan, row: Candidate): number {
  if (plan.kind !== 'lyric_fragment') return 0;
  const frag = fragmentTokens(plan.normalized);
  if (frag.size === 0) return 0;
  const hay = new Set(
    `${row.lyricsSnippet ?? ''} ${row.title}`.toLowerCase().split(/\W+/),
  );
  let hits = 0;
  frag.forEach((t) => {
    if (hay.has(t)) hits += 1;
  });
  return hits / frag.size;
}

/**
 * V2 lyric verification: LRCLIB containment for the top-3 distinct
 * clusters. BOUNDED + non-throwing; resolves after paint is fine (the
 * UI re-renders verified rows when this lands).
 */
export async function verifyLyrics(
  plan: SearchPlan,
  rows: Candidate[],
  signal?: AbortSignal,
): Promise<Map<string, { matched: boolean; line: string }>> {
  const verdicts = new Map<string, { matched: boolean; line: string }>();
  if (plan.kind !== 'lyric_fragment' || rows.length === 0) return verdicts;
  const frag = plan.normalized;
  const top = rows.slice(0, 3);
  await Promise.all(
    top.map(async (row) => {
      if (signal?.aborted) return;
      const artist = row.artistsFull?.[0] ?? row.artistName.split(',')[0] ?? row.artistName;
      const lyrics = await fetchPlainLyrics(row.title, artist, signal);
      if (!lyrics) return;
      const normLyrics = normalizeQuery(lyrics);
      const lyricWordSet = new Set(normLyrics.split(/\W+/));
      const fragTokens = frag.split(' ').filter((t) => t.length >= 3);
      if (fragTokens.length === 0) return;
      // containment: ≥70% of distinctive fragment tokens present as WORDS
      // in the lyrics (substring matching would let "ram" hit "dramatic")
      const hits = fragTokens.filter((t) => lyricWordSet.has(t)).length;
      const ratio = hits / fragTokens.length;
      if (ratio >= 0.7) {
        // matched line = the lyric line with the most fragment tokens
        const lines = lyrics.split(/\r?\n/).filter(Boolean);
        let bestLine = lines[0] ?? '';
        let bestHits = -1;
        for (const line of lines) {
          const nl = normalizeQuery(line);
          const h = fragTokens.filter((t) => nl.includes(t)).length;
          if (h > bestHits) {
            bestHits = h;
            bestLine = line.trim();
          }
        }
        verdicts.set(row.id, { matched: true, line: bestLine });
      }
    }),
  );
  return verdicts;
}

/** Full S2 pass (sync stages; V2 lyric verification is returned as a
 *  follow-up promise the orchestrator may await after paint). */
export function verifySet(
  plan: SearchPlan,
  pools: Array<{ pool: string; rows: SearchRow[] }>,
): VerifiedSet {
  const merged = mergePools(pools);
  const clustered = clusterVersions(merged);
  return { rows: clustered, clusters: clustered.length };
}
