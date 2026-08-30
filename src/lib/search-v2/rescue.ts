/**
 * SEARCH V2 · SIG RESCUE (SEARCH-INTENT-RESCUE-PLAN §3.5, M3/M4; title-truth
 * v3.4). Ported from the reference engine (TSF-MUSIC v3.4
 * src/search/rescue.ts) with OUR providers injected:
 *
 * When a specific-intent query (song + artist) produced no row matching
 * BOTH axes, OR a title-only plan's every matching row sits below the
 * AUTHORITY_FLOOR, the engine escalates instead of painting confidently
 * wrong results. Rungs, first hit wins:
 *
 *   R0 youtube  — OUR InnerTube YT Music search (full-length, dual
 *                 title+artist verified, songs first / videos ≤15 min)
 *   R1 itunes   — 30 s preview fallback (truthfully labelled)
 *   R3 variants — re-probe the YT Music catalog with orthographic
 *                 spellings ("tu chaiye" → "tu chahiye") for the
 *                 reachable-miss class; the JioSaavn authority probe
 *                 cross-checks popularity where a playCount is missing
 *   R2 album    — YT Music album search → the album's tracks (the
 *                 exists-but-not-in-song-search class)
 *
 * No rung ever throws; failures degrade to "no row", which the
 * orchestrator turns into an honest S-PARTIAL / S-ZERO state.
 */

import type { SearchPlan } from './plan';
import { artistContains } from './rank';
import { titleQueryTokens, acceptableTitleTokens, titleHitCount } from './rank';
import { normalizeQuery } from './normalize';
import { search as ytmSearch } from '@/lib/ytm'
import { filterSafeTracks } from '@/lib/safety'
import { ytSearchMusic, ytAvailable } from './ytmusic';
import { searchItunesRescue } from './itunes-rescue';
import { searchSaavnCatalog } from './saavn-catalog';
import { ytmToRow, type SearchRow } from './rows';

export type RescueRung = 'youtube' | 'itunes' | 'variant' | 'album';

/** AUTHORITY FLOOR — the popularity a "the" recording leaves behind.
 *  When a famous song is missing from a catalog, what remains in its
 *  place is covers/remakes in the hundreds-of-plays tier (live-probed
 *  "tu chaiye": every JioSaavn row ≤ 198k, the real song has 100M+).
 *  Rows at/above this floor are treated as the canonical release; rows
 *  below it as same-name noise. */
export const AUTHORITY_FLOOR = 250_000;

/** TITLE-ONLY AUTHORITY GAP — the class the "tu chaiye" (no artist
 *  typed) complaint lives in: the plan has NO artistTokens so the
 *  artist_title SIG gate never fires, yet every title-matching row the
 *  provider returned is deep-niche. The famous recording the user means
 *  is almost certainly absent from the catalog → escalate once via the
 *  rescue ladder instead of confidently painting covers.
 *  Requires ≥1 genuinely title-matching row (queries with NO title
 *  match belong to the honest-zero/recovery path, not this one).
 *
 *  WEB ADAPTATION (unknown-metric rule): YT Music song rows often carry
 *  NO play metric at all — the reference's `(playCount ?? 0) < floor`
 *  would read unknown as zero and fire the ladder on nearly every title
 *  query. Unknown is therefore EXCLUDED from the verdict: the ladder
 *  fires only when ≥1 matching row carries a KNOWN metric and every
 *  KNOWN metric among the top-6 matches is below the floor. (In
 *  rescueRowAuthoritative the reference's unknown-allowed rule is kept
 *  verbatim for youtube/itunes rows.) */
export function titleAuthorityMissing(
  rows: Array<{ playCount?: number; queryMatch?: number }>,
): boolean {
  const matching = rows.filter((r) => (r.queryMatch ?? 0) >= 0.5);
  if (matching.length === 0) return false;
  const top = matching.slice(0, 6);
  const known = top.filter((r) => typeof r.playCount === 'number' && r.playCount > 0);
  if (known.length === 0) return false; // insufficient evidence — stay honest, don't escalate
  return top.every((r) => typeof r.playCount === 'number' && r.playCount < AUTHORITY_FLOOR);
}

/** Does THIS row carry enough weight to be the rescue answer? For
 *  artist_title plans the artist axis already proves identity (unchanged
 *  from the shipped, device-verified path). Title-only plans have no
 *  artist axis — the rescue row must ITSELF be the popular canonical
 *  recording, or we'd rescue one obscure cover with another. iTunes is
 *  exempt: the official store carries no play metric, and its ranking
 *  + dual title verification is the identity signal there. YT Music
 *  song-kind rows ALSO never carry a view metric (only video rows do),
 *  so an UNKNOWN metric is allowed for youtube rows — bestFirst()
 *  ordering + remix demotion rank them — while a KNOWN-SMALL metric
 *  (< floor) is a hard reject. Variant/album route rows report play
 *  counts reliably (JioSaavn authority probe / YTM plays string), so
 *  they need the floor for real. */
function rescueRowAuthoritative(plan: SearchPlan, t: SearchRow): boolean {
  if (plan.artistTokens.length > 0) return true;
  if (t.source === 'itunes') return true;
  if (t.source === 'youtube') return t.playCount === undefined || t.playCount >= AUTHORITY_FLOOR;
  if (t.source === 'ytm') {
    // unknown plays string → unknown metric → allowed (reference rule);
    // known-small → reject
    return t.playCount === undefined || t.playCount >= AUTHORITY_FLOOR;
  }
  return (t.playCount ?? 0) >= AUTHORITY_FLOOR;
}

export interface RescueDeps {
  disabled?: () => boolean;
  signal?: AbortSignal;
  /** deadline for the WHOLE ladder (ms epoch) — rungs check before firing */
  deadline?: number;
}

export interface RescueOutcome {
  rows: SearchRow[];
  rung?: RescueRung;
  /** which rungs were attempted (for the ledger + honest-zero copy) */
  attempted: RescueRung[];
}

/** SIG M3 — is the specific intent still unmet after the first rank? */
export function sigUnmet(plan: SearchPlan, rows: Array<{ artistMatch: number; queryMatch: number }>): boolean {
  if (plan.kind !== 'artist_title' || plan.artistTokens.length === 0) return false;
  if (rows.length === 0) return true;
  return !rows.some((r) => r.artistMatch >= 1 && r.queryMatch >= 0.5);
}

/** Dual-axis verification for rescue rows (the rescue row must be the
 *  song the user asked for — same bar as a native S-HIT row). Title
 *  side is ortho-aware: the plan's variants ("chaiye"→"chahiye") count
 *  as the same token, so the correctly-spelled canonical recording
 *  verifies at full strength instead of 0.5. */
export function verifyRescueRow(plan: SearchPlan, track: SearchRow): boolean {
  if (!plan.artistTokens.length) {
    const orig = titleQueryTokens(plan);
    if (orig.length === 0) return true;
    const hay = new Set(
      normalizeQuery(track.title)
        .split(/[^a-z0-9\u0900-\u097f]+/)
        .filter(Boolean),
    );
    const hits = titleHitCount(orig, acceptableTitleTokens(plan), hay);
    return hits / orig.length >= 0.5;
  }
  const orig = titleQueryTokens(plan);
  const hay = new Set(
    normalizeQuery(track.title)
      .split(/[^a-z0-9\u0900-\u097f]+/)
      .filter(Boolean),
  );
  const hits = titleHitCount(orig, acceptableTitleTokens(plan), hay);
  const titleOk = orig.length > 0 && hits / orig.length >= 0.5;
  const credits = track.artistsFull?.length ? track.artistsFull : track.artistName.split(/,\s*/);
  const artistOk = plan.artistTokens.some((a) =>
    credits.some((c) => artistContains(normalizeQuery(c), a)),
  );
  return titleOk && artistOk;
}

function within(deadline: number | undefined): boolean {
  return deadline === undefined || Date.now() < deadline;
}

function mark(track: SearchRow, rung: RescueRung): SearchRow {
  return { ...track, rescued: true, rescueRung: rung };
}

const RUNG_PICK_DEMOTIONS =
  /\b(slowed|reverb|lofi|lo-fi|remix|nightcore|8d|bass ?boosted|sped ?up|unplugged|cover|karaoke|instrumental|tribute|reaction|lofi mix)\b/i;

/** Deterministic best-first order for candidate rescue rows:
 *  1. demote edit-class junk whose TITLE admits it (Slowed+Reverb, Lo-Fi
 *     Mix, Unplugged Cover, REMIX…) — these routinely carry HUGE view
 *     counts and must never be the canonical answer
 *  2. song-kind rows (the OFFICIAL YT Music catalog entry) before video
 *     rows (UGC lyric-video uploads) — a 6.2M-view lyric video must not
 *     displace the catalog recording of the same song
 *  3. popularity desc (YT video rows carry views; song rows don't)
 *  4. provider order (stable) — YT Music lists the official catalog
 *     songs first, which is the right tiebreak for metric-less rows
 *  (Sort is stable per spec — equal keys keep YT's own ranking.) */
function bestFirst(rows: SearchRow[]): SearchRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(RUNG_PICK_DEMOTIONS.test(a.title)) - Number(RUNG_PICK_DEMOTIONS.test(b.title)) ||
      Number(a.ytKind === 'video' ? 1 : 0) - Number(b.ytKind === 'video' ? 1 : 0) ||
      (b.playCount ?? 0) - (a.playCount ?? 0),
  );
}

/** Catalog probe helper — our YTM search() mapped to engine rows. */
async function ytmCatalogProbe(q: string, limit: number, signal?: AbortSignal): Promise<SearchRow[]> {
  try {
    if (signal?.aborted) return [];
    const res = await ytmSearch(q, 'songs');
    return filterSafeTracks(res.tracks ?? []).map((t, i) => ytmToRow(t, i));
  } catch {
    return [];
  }
}

/** R0 — YouTube full-length: search → verify (dual title+artist). Our
 *  player resolves streams by videoId natively, so no pre-resolve hop
 *  is needed (the reference's ytResolveStream step is the web player's
 *  own /api/stream ladder). */
async function rungYoutube(plan: SearchPlan, deps: RescueDeps): Promise<SearchRow[]> {
  if (!ytAvailable() || !within(deps.deadline)) return [];
  const q = `${plan.titleTokens.join(' ')} ${plan.artistTokens.join(' ')}`.trim();
  if (!q) return [];
  const res = await ytSearchMusic(q, 10, deps.signal).catch(() => ({ tracks: [] as SearchRow[], unavailable: false }));
  const verified = bestFirst(
    (res.tracks ?? []).filter(
      (t) => verifyRescueRow(plan, t) && rescueRowAuthoritative(plan, t),
    ),
  );
  if (verified.length === 0) return [];
  return verified.slice(0, 1).map((t) => mark(t, 'youtube'));
}

/** R1 — iTunes preview: search → verify. */
async function rungItunes(plan: SearchPlan, deps: RescueDeps): Promise<SearchRow[]> {
  if (!within(deps.deadline)) return [];
  const q = `${plan.titleTokens.join(' ')} ${plan.artistTokens.join(' ')}`.trim();
  if (!q) return [];
  const rows = await searchItunesRescue(q, 10, deps.signal).catch(() => [] as SearchRow[]);
  return rows.filter((t) => verifyRescueRow(plan, t)).map((t) => mark(t, 'itunes'));
}

/** R3 — variant spellings against the catalogs (the reachable-miss
 *  class). YT Music rows are the playable answer; the JioSaavn authority
 *  probe fills a missing playCount so the floor check is honest. */
async function rungVariant(plan: SearchPlan, deps: RescueDeps): Promise<SearchRow[]> {
  if (!within(deps.deadline)) return [];
  const variants = plan.variants.length > 0 ? plan.variants : [];
  for (const v of variants.slice(0, 2)) {
    const q = plan.artistTokens.length ? `${v} ${plan.artistTokens.join(' ')}` : v;
    const rows = await ytmCatalogProbe(q, 15, deps.signal);
    if (rows.length > 0 && rows.some((r) => r.playCount === undefined)) {
      const saavnRows = await searchSaavnCatalog(q, 10, deps.signal).catch(() => [] as SearchRow[]);
      const countByKey = new Map<string, number>();
      for (const s of saavnRows) {
        const k = normalizeQuery(`${s.title} ${s.artistsFull?.[0] ?? s.artistName}`);
        if (typeof s.playCount === 'number') countByKey.set(k, s.playCount);
      }
      for (const r of rows) {
        if (r.playCount === undefined) {
          const k = normalizeQuery(`${r.title} ${r.artistsFull?.[0] ?? r.artistName}`);
          r.playCount = countByKey.get(k);
        }
      }
    }
    const verified = rows.filter(
      (t) => verifyRescueRow(plan, t) && rescueRowAuthoritative(plan, t),
    );
    if (verified.length > 0) return verified.map((t) => mark(t, 'variant'));
  }
  return [];
}

/** R2 — album route (full length; exists-but-not-in-song-search class):
 *  album search on our YT Music layer → the album's OWN tracklist. */
async function rungAlbum(plan: SearchPlan, deps: RescueDeps): Promise<SearchRow[]> {
  if (!within(deps.deadline)) return [];
  const q = plan.artistTokens.length
    ? `${plan.titleTokens.join(' ')} ${plan.artistTokens.join(' ')}`.trim()
    : plan.titleTokens.join(' ');
  if (!q) return [];
  try {
    if (deps.signal?.aborted) return [];
    const res = await ytmSearch(q, 'albums');
    const albums = (res.albums ?? []).slice(0, 3);
    for (const alb of albums) {
      if (!within(deps.deadline)) break;
      // re-probe the catalog with the album title to pull its tracklist
      // rows (our ytm album() needs a browse endpoint; the tracks search
      // on "<album> <artist>" surfaces the same recordings, filtered by
      // the SAME dual-axis verification)
      const tracks = await ytmCatalogProbe(`${alb.name} ${alb.artistName ?? ''}`.trim(), 20, deps.signal);
      const verified = tracks.filter(
        (t) => verifyRescueRow(plan, t) && rescueRowAuthoritative(plan, t),
      );
      if (verified.length > 0) return verified.map((t) => mark(t, 'album'));
    }
  } catch {
    return [];
  }
  return [];
}

const RUNGS: Array<{ rung: RescueRung; fire: (plan: SearchPlan, deps: RescueDeps) => Promise<SearchRow[]> }> = [
  { rung: 'youtube', fire: rungYoutube },
  { rung: 'itunes', fire: rungItunes },
  { rung: 'variant', fire: rungVariant },
  { rung: 'album', fire: rungAlbum },
];

/**
 * Run the ladder. First rung producing ≥1 verified row wins. Never
 * throws; never runs past `deadline` (default: 3 s from call).
 */
export async function runRescueLadder(plan: SearchPlan, deps: RescueDeps = {}): Promise<RescueOutcome> {
  const deadline = deps.deadline ?? Date.now() + 3000;
  const attempted: RescueRung[] = [];
  for (const { rung, fire } of RUNGS) {
    if (deps.signal?.aborted || !within(deadline)) break;
    attempted.push(rung);
    try {
      const rows = await fire(plan, { ...deps, deadline });
      if (rows.length > 0) return { rows, rung, attempted };
    } catch {
      /* rung failure = no row; the ladder keeps climbing */
    }
  }
  return { rows: [], attempted };
}
