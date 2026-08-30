/**
 * SEARCH V2 · S0 support — SymSpell-style spelling correction.
 * Ported from the reference engine (TSF-MUSIC v3.4 src/search/lexicon.ts)
 * — deletes-only precomputation (Garbe): every lexicon term is pre-indexed
 * under all strings reachable by ≤2 deletes; a misspelled token is
 * corrected by generating ITS deletes and intersecting the index —
 * sub-millisecond, language-independent ("arjit"→"arijit", "fya"→"faya").
 *
 * Server adaptation: the kv snapshot lives in db.apiCache (key
 * 'searchLexicon') instead of the on-device ledger kv — see engine.ts.
 */

import { normalizeQuery } from './normalize';

const MAX_EDIT = 2;
const MAX_TERMS = 5000;
export const SNAPSHOT_KEY = 'searchLexicon';

export interface Correction {
  from: string;
  to: string;
}

interface LexState {
  /** deletes-index: delete-string → Set<term> */
  index: Map<string, Set<string>>;
  /** term → frequency (for best-candidate tiebreaks) */
  freq: Map<string, number>;
  built: boolean;
}

const state: LexState = { index: new Map(), freq: new Map(), built: false };

function deletesFor(term: string, maxDist: number): Set<string> {
  const out = new Set<string>([term]);
  let frontier = new Set<string>([term]);
  for (let d = 0; d < maxDist; d += 1) {
    const next = new Set<string>();
    for (const s of frontier) {
      if (s.length <= 2) continue;
      for (let i = 0; i < s.length; i += 1) {
        next.add(s.slice(0, i) + s.slice(i + 1));
      }
    }
    for (const n of next) out.add(n);
    frontier = next;
  }
  return out;
}

/** Add one term. Multi-word phrases index BOTH the whole phrase AND
 *  each word ≥3 chars — corrections work at token granularity ("arjit"
 *  → "arijit" even though the lexicon knows "arijit singh"). */
function addTerm(termRaw: string, freq = 1): void {
  const t = normalizeQuery(termRaw);
  if (!t || !/[a-z0-9\u0900-\u097f]/.test(t)) return;
  const units = new Set<string>([t]);
  for (const w of t.split(/[\s-]+/)) {
    if (w.length >= 3) units.add(w);
  }
  if (units.size === 0) return;
  if (state.freq.size >= MAX_TERMS) {
    let anyNew = false;
    for (const u of units) if (!state.freq.has(u)) anyNew = true;
    if (anyNew) return; // cap reached — stop growing
  }
  for (const unit of units) {
    state.freq.set(unit, (state.freq.get(unit) ?? 0) + freq);
    for (const key of deletesFor(unit, MAX_EDIT)) {
      let bucket = state.index.get(key);
      if (!bucket) {
        bucket = new Set();
        state.index.set(key, bucket);
      }
      bucket.add(unit);
    }
  }
}

/** Assemble + build the index from source lists (call on first search). */
export function buildLexicon(sources: string[][], recentSearches: string[] = []): void {
  state.index.clear();
  state.freq.clear();
  for (const list of sources) {
    for (const term of list) {
      if (term) addTerm(term, 2); // curated terms start slightly frequent
    }
  }
  for (const q of recentSearches.slice(0, 12)) {
    if (q) addTerm(q, 5); // the user literally typed these — high freq
  }
  state.built = true;
}

/** Serialize for the kv snapshot (compact array-of-pairs). */
export function snapshotLexicon(): string {
  const pairs: Array<[string, number]> = [];
  state.freq.forEach((f, t) => pairs.push([t, f]));
  return JSON.stringify({ v: 1, terms: pairs });
}

/** Rebuild from a snapshot string. Returns false if unusable. */
export function restoreLexicon(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as { v?: number; terms?: Array<[string, number]> };
    if (parsed?.v !== 1 || !Array.isArray(parsed.terms)) return false;
    state.index.clear();
    state.freq.clear();
    for (const [t, f] of parsed.terms.slice(0, MAX_TERMS)) {
      if (!t) continue;
      state.freq.set(t, Math.max(1, Number(f) || 1));
      for (const key of deletesFor(t, MAX_EDIT)) {
        let bucket = state.index.get(key);
        if (!bucket) {
          bucket = new Set();
          state.index.set(key, bucket);
        }
        bucket.add(t);
      }
    }
    state.built = true;
    return true;
  } catch {
    return false;
  }
}

export function lexiconReady(): boolean {
  return state.built;
}

export function lexiconSize(): number {
  return state.freq.size;
}

/** Feed observed titles/artists into the lexicon (LRU feeder pattern). */
export function feedLexicon(terms: Array<string | undefined>): void {
  for (const t of terms) {
    if (t) addTerm(t, 1);
  }
}

function editDistanceWithin(a: string, b: string, max: number): number {
  // small bounded Levenshtein (early exit) — terms are short
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j];
  }
  return prev[b.length];
}

/**
 * Correct one token. Returns null when the token is fine or no confident
 * candidate exists. Never fires on short tokens (<3) or exact hits.
 */
export function correctToken(token: string): string | null {
  if (!state.built || token.length < 3) return null;
  if (state.freq.has(token)) return null; // already a known term
  const candidates = new Map<string, number>(); // term → distance
  for (const probe of deletesFor(token, MAX_EDIT)) {
    const bucket = state.index.get(probe);
    if (!bucket) continue;
    for (const term of bucket) {
      if (candidates.has(term)) continue;
      const d = editDistanceWithin(token, term, MAX_EDIT);
      if (d <= MAX_EDIT) candidates.set(term, d);
    }
  }
  if (candidates.size === 0) return null;
  // best = smallest distance, then highest lexicon frequency, then
  // shortest term (deterministic)
  let best: string | null = null;
  let bestD = MAX_EDIT + 1;
  let bestF = -1;
  candidates.forEach((d, term) => {
    const f = state.freq.get(term) ?? 0;
    if (d < bestD || (d === bestD && (f > bestF || (f === bestF && term.length < (best?.length ?? 999))))) {
      best = term;
      bestD = d;
      bestF = f;
    }
  });
  return best;
}
