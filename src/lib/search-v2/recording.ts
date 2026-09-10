/**
 * RECORDING IDENTITY — the dedup key for "same performance, different row".
 *
 * Ported from TSF-MUSIC v3.4.5 src/api/recording.ts (R8-P4 field fix:
 * "Top Songs repeats" — Zalima x5-6 report). Providers re-list the SAME
 * recording under many ids: JioSaavn returns one song from the movie
 * album, compilations and regional presses; YouTube Music carries the
 * same recording under multiple catalog entities.
 *
 * The key = normalized TITLE + normalized PRIMARY ARTIST.
 * Pure module — no I/O, deterministic, unit-testable.
 */

/** Attribution noise that does NOT change the recording's identity:
 *  movie/show credits ('(From "Raees")') and featured-artist credits
 *  ('(feat. Badshah)'). Versions that ARE different performances —
 *  Lofi Mix, Remix, Live, Slowed, Cover, Dance Mix… — are NOT stripped. */
const ATTRIBUTION_NOISE =
  /\s*[([]\s*(?:from\s+["'"][^)"']{0,60}["'"]|feat\.?\s|ft\.?\s|with\s|original motion picture[^)\]]{0,40}|ost\s)[^)\]]*[)\]]/gi;

function normTitle(s: string): string {
  return s
    .replace(ATTRIBUTION_NOISE, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 80);
}

function normSeg(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 80);
}

export interface CreditCarrier {
  title?: string;
  artist?: string;
  artistName?: string;
  artistsFull?: string[];
}

/** First credited artist from the full-credit forms providers send. */
export function primaryArtistOf(t: {
  artist?: string;
  artistName?: string;
  artistsFull?: string[];
}): string {
  const src = (t.artistsFull?.length ? t.artistsFull[0] : (t.artist ?? t.artistName)) ?? '';
  return src.split(/,|&|\bfeat\.?\b|\bft\.?\b/i)[0]?.trim() ?? '';
}

/** Stable recording key — "zalima|pritam" style. Title-less rows key on
 *  the artist so two different artists never collapse into one. */
export function recordingKey(
  t: { title?: string; artist?: string; artistName?: string; artistsFull?: string[] },
  salt = '',
): string {
  const title = normTitle(t.title ?? '');
  const artist = normSeg(primaryArtistOf(t));
  if (!title) return `anon|${artist}${salt ? `|${salt}` : ''}`;
  return `${title}|${artist}`;
}

/** Normalized FULL credit set of a row (every credited artist, not
 *  just the primary). Empty when the row carries no credits at all. */
export function creditSetOf(t: {
  artist?: string;
  artistName?: string;
  artistsFull?: string[];
}): Set<string> {
  const raw = t.artistsFull?.length ? [...t.artistsFull] : t.artist ?? t.artistName ? [String(t.artist ?? t.artistName)] : [];
  const out = new Set<string>();
  for (const a of raw) {
    for (const seg of String(a).split(/,|&|\bfeat\.?\b|\bft\.?\b/i)) {
      const n = normSeg(seg.trim());
      if (n) out.add(n);
    }
  }
  return out;
}

/** Title bucket of a row — the normTitle half of recordingKey. */
export function titleKeyOf(t: { title?: string }): string {
  return normTitle(t.title ?? '');
}

/** Plain nesting test: one credit set ⊆ the other (equal counts).
 *  Empty credit sets never match. */
export function nestedCredits(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (!big.has(x)) return false;
  return true;
}

/** Two credit sets describe the SAME recording when one nests inside
 *  the other. Empty credit sets never match.
 *
 *  SINGLETON GUARD: when the smaller set is a single artist {X}, X must
 *  ALSO be the primary credit of the larger row — a lone credit that is
 *  only a SECONDARY credit of the other row is a DIFFERENT recording. */
export function sameCredits(
  a: Set<string>,
  b: Set<string>,
  primaryA?: string,
  primaryB?: string,
): boolean {
  if (!nestedCredits(a, b)) return false;
  if (a.size !== b.size) {
    const [small] = a.size <= b.size ? [a, b] : [b, a];
    if (small.size === 1) {
      const lone = [...small][0];
      const primaryBig = a.size <= b.size ? primaryB : primaryA;
      if (primaryBig && normSeg(primaryBig) !== lone) return false;
    }
  }
  return true;
}

/** Play-count twin: two rows whose play counters are near-identical
 *  (Δ ≤ 1000) share the SAME recording's global counter. Only fires when
 *  BOTH rows carry a LARGE counter (≥ 100,000) — small counters are noisy. */
export function countTwins(a?: number, b?: number): boolean {
  return (
    typeof a === 'number' &&
    typeof b === 'number' &&
    a >= 100000 &&
    b >= 100000 &&
    Math.abs(a - b) <= 1000
  );
}

/** Order-preserving reconciliation: within each title bucket, a row is
 *  dropped when an EARLIER KEPT row carries a nested/equal credit set
 *  (guarded) — or when the rows are play-count twins. Pure; idempotent. */
export function reconcileRecordings<T extends {
  title?: string;
  artist?: string;
  artistName?: string;
  artistsFull?: string[];
  playCount?: number;
}>(tracks: T[]): T[] {
  const buckets = new Map<string, { credits: Set<string>; primary: string; plays?: number }[]>();
  const out: T[] = [];
  for (const t of tracks) {
    const title = titleKeyOf(t);
    if (!title) {
      out.push(t);
      continue;
    }
    const credits = creditSetOf(t);
    const primary = primaryArtistOf(t);
    let drop = false;
    for (const kept of buckets.get(title) ?? []) {
      if (!nestedCredits(kept.credits, credits)) continue;
      if (sameCredits(kept.credits, credits, kept.primary, primary)) {
        drop = true;
        break;
      }
      if (countTwins(kept.plays, t.playCount)) {
        drop = true;
        break;
      }
    }
    if (drop) continue;
    let bucket = buckets.get(title);
    if (!bucket) {
      bucket = [];
      buckets.set(title, bucket);
    }
    bucket.push({ credits, primary, plays: t.playCount });
    out.push(t);
  }
  return out;
}
