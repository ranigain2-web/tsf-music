/**
 * SEARCH · LONG-FORM — the "1 hour lofi mix" class.
 *
 * WHY THIS EXISTS (reported from real use):
 *
 *   "if we search like Lofi one hour then songs come but they are not like one
 *    hour long they are just 15 minutes 20 minutes and etc … there is some
 *    limitation like they are blocking amount more than this"
 *
 * That instinct was exactly right. The YouTube catalog source dropped every
 * non-song row longer than fifteen minutes:
 *
 *     const videos = merged.filter((t) => t.ytKind !== 'song' && … <= 15 * 60)
 *
 * So the entire long-form catalog — 1-hour lofi mixes, 3-hour sleep sets,
 * 8-hour rain beds, 10-hour white noise — was thrown away before the UI could
 * see it, and a long-form query was answered with 3-minute songs. Measured on
 * the live catalog, per query, rows of ≥20 minutes LOST to that filter:
 *
 *     rain sounds for sleeping  19 dropped  (largest 259,200 s = 72 h)
 *     white noise 10 hours      20 dropped  (largest 357,150 s = 99 h)
 *     sleep music 8 hours       17 dropped
 *     study with me 1 hour      17 dropped
 *     lofi one hour             16 dropped
 *
 * The fix is NOT "raise the cap". A blunt cap is what caused this, and any
 * other number would just move the boundary. Two rules replace it:
 *
 *   1. NEVER DROP a long row. It is real catalog content that the provider
 *      deliberately ranked for this query.
 *   2. ORDER by intent. A query that asks for long-form ("lofi one hour",
 *      "rain sounds for sleeping") leads with the long rows, because that is
 *      the answer. Every other query leads with songs, so a listener typing a
 *      song title still gets the recording first and the ambient mixes after.
 *
 * Pure and dependency-free so the oracle can pin the behaviour.
 */

/** At or above this, a track is long-form rather than a song. */
export const LONG_FORM_MIN_SEC = 20 * 60

/**
 * Words that signal the user wants something they can leave running. Kept
 * deliberately specific — a bare "mix" or "radio" is included because those
 * are long-form by nature in music catalogs, but ordinary song words are not.
 */
const LONG_FORM_TERMS = [
  // explicit duration asks. NOTE: the bare singular "hour"/"hr" is NOT here on
  // purpose — a song called "The Longest Hour" is a 2-minute song, and a lone
  // "hour" should not re-rank it behind ambient sets. Plural forms and numeric
  // phrases are unambiguous.
  'hours', 'hrs', '10 hours', '8 hours', '1 hour', '2 hour', '3 hour', 'one hour',
  'mins', 'minutes', '60 min', '60min',
  // long-form formats
  'mix', 'mixes', 'mashup', 'mega mix', 'megamix', 'nonstop', 'non-stop', 'non stop',
  'compilation', 'jukebox', 'extended', 'full album', 'album mix', 'loop', 'looped',
  'replay', 'continuous', 'sessions', 'session', 'playlist', 'radio', 'stream',
  // ambient / functional genres that are long by construction
  'lofi', 'lo-fi', 'ambient', 'sleep', 'sleeping', 'study', 'focus', 'concentration',
  'meditation', 'relax', 'relaxing', 'calm', 'chill', 'chillout', 'chill out',
  'white noise', 'brown noise', 'pink noise', 'rain', 'rainfall', 'thunder',
  'nature sounds', 'noise', 'instrumental', 'bgm', 'beats to', 'brainwave',
  'binaural', 'asmr', 'timing', 'timer', 'deep sleep', 'work music',
]

/**
 * Does this query ask for long-form content?
 *
 * Whole-word matching on the normalised query, so "hourly" does not match
 * "hour" and "restudy" does not match "study".
 */
export function wantsLongForm(query: string): boolean {
  const q = query.toLowerCase().replace(/[^\p{L}\p{N}\s-]+/gu, ' ').replace(/\s+/g, ' ').trim()
  if (!q) return false
  for (const term of LONG_FORM_TERMS) {
    if (term.includes(' ')) {
      if (q.includes(term)) return true
    } else if (new RegExp(`(^|[\\s-])${term}([\\s-]|$)`, 'i').test(q)) {
      return true
    }
  }
  return false
}

/** Is this duration long-form? Unknown durations (0) are never long-form. */
export function isLongFormDuration(sec: number | undefined | null): boolean {
  return (sec ?? 0) >= LONG_FORM_MIN_SEC
}

/**
 * Order a merged result list around long-form intent.
 *
 * `query` asking for long-form  → long rows FIRST, then everything else in the
 *                                 caller's original order (provider relevance).
 * otherwise                     → the caller's order (songs first, as always),
 *                                 with long rows moved to the END rather than
 *                                 dropped.
 *
 * Stable: rows keep their relative order inside each group.
 */
export function orderWithLongForm<T extends { duration?: number }>(
  rows: T[],
  query: string,
): T[] {
  if (rows.length < 2) return rows
  const longForm = wantsLongForm(query)
  const isLong = (r: T) => isLongFormDuration(r.duration)
  if (longForm) {
    const lead: T[] = []
    const rest: T[] = []
    for (const r of rows) (isLong(r) ? lead : rest).push(r)
    return lead.length ? [...lead, ...rest] : rows
  }
  // no long-form intent: keep the caller's order, but never discard long rows
  const short: T[] = []
  const tail: T[] = []
  for (const r of rows) (isLong(r) ? tail : short).push(r)
  return tail.length ? [...short, ...tail] : rows
}

/**
 * Should the provider's own top-result card be honoured for this query?
 *
 * The YouTube source deliberately SKIPS the top card because for a fuzzy song
 * query it carries a lo-fi mix ("tu chaiye" → rank-1 mix). But for a query that
 * asks for long-form, that card is the single best answer on the page — so it
 * is read exactly then, and skipped the rest of the time.
 */
export function honoursTopCard(query: string): boolean {
  return wantsLongForm(query)
}
