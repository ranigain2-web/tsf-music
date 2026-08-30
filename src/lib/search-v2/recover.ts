/**
 * SEARCH V2 · S4 — RECOVER (relaxation ladder for thin/zero results).
 * Ported from the reference engine (TSF-MUSIC v3.4 src/search/recover.ts).
 *
 * Never garbage-labeled-as-match: when the merged set is thin, each
 * rung re-enters S1→S3 with a modified plan (max 2 rungs, ≤1.5 s);
 * the final fallback is an honest zero-state with "Did you mean"
 * chips. The old failure mode — English lyric → unrelated Telugu
 * songs — becomes a labeled recovery state instead.
 */

import type { SearchPlan } from './plan';
import { planSearch } from './plan';
import { TYPE_WORDS } from './normalize';
import type { SearchRow } from './rows';

export const THIN_THRESHOLD = 3;

export interface RecoveryOutcome {
  rows: SearchRow[];
  /** which rung produced the results (for the "Showing results for …" label) */
  relaxedFrom?: string;
  /** the relaxed query actually searched */
  relaxedQuery?: string;
  didYouMean: string[];
}

/** idf-ish token rarity for drop-the-rarest selection. */
function rarestToken(tokens: string[]): string | null {
  let rarest: string | null = null;
  let score = -1;
  for (const t of tokens) {
    const s =
      TYPE_WORDS.has(t) ? 0.1 : t.length <= 2 ? 0.4 : t.length <= 4 ? 1.2 : 2.0;
    if (s > score) {
      score = s;
      rarest = t;
    }
  }
  return rarest;
}

/** Rung 1: drop the lowest-signal token (typos/garbage die here). */
function dropRarest(plan: SearchPlan): SearchPlan | null {
  const candidates = plan.tokens.filter(
    (t) => t.length >= 3 && !TYPE_WORDS.has(t),
  );
  const drop = rarestToken(candidates);
  if (!drop || plan.tokens.length <= 2) return null;
  const kept = plan.tokens.filter((t) => t !== drop);
  if (kept.length === 0) return null;
  return planSearch(kept.join(' '));
}

/** Rung 2: strip type words ("asdf song" → "asdf"). */
function stripTypeWords(plan: SearchPlan): SearchPlan | null {
  const kept = plan.tokens.filter((t) => !TYPE_WORDS.has(t));
  if (kept.length === 0 || kept.length === plan.tokens.length) return null;
  return planSearch(kept.join(' '));
}

/** Rung 3: split — artist_title keeps its best window / artist only. */
function bestFragment(plan: SearchPlan): SearchPlan | null {
  const seed =
    plan.windows[0] ??
    (plan.kind === 'artist_title' ? plan.artistTokens.join(' ') : '') ??
    '';
  if (!seed || seed === plan.normalized) return null;
  return planSearch(seed);
}

export const RELAXATION_RUNGS = [dropRarest, stripTypeWords, bestFragment] as const;
