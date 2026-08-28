/**
 * TSF Music — Content safety filter
 *
 * Filters out sexually explicit, drug-glorifying, or otherwise inappropriate
 * content from YouTube Music metadata before it ever reaches the UI.
 *
 * Filtering is keyword-based + IS_EXPLICIT-aware. It is intentionally broad —
 * we err on the side of dropping questionable content rather than risk showing
 * it. Safe content stays. False positives are a UX annoyance; false negatives
 * are a user-trust failure.
 */

const DENY_PATTERNS: RegExp[] = [
  // Sexual content
  /\bsex(ual|y|ed)?\b/i,
  /\bporn/i,
  /\bxxx\b/i,
  /\bhentai\b/i,
  /\beleporno/i,
  /\berotic/i,
  /\bnude\b/i,
  /\bnudity\b/i,
  /\bnaked\b/i,
  /\bbooty\b/i,
  /\bbrazzers\b/i,
  /\bpornhub\b/i,
  /\bonlyfans\b/i,
  /\bnaked\b/i,
  /\bbangbros\b/i,
  /\bsexy?\s+(beat|mix|playlist|sound)/i,
  /\bgirls?\s+gone\s+wild\b/i,
  /\b(69|position)\b.*\b(sex|kamasutra|kama)\b/i,
  /\b(ahegao|kamasutra)\b/i,
  /\bhotwife\b/i,
  /\bslut\b/i,
  /\bescort\b/i,
  /\b(cum|jerk|anal|oral).?s?ex/i,
  /\bsquirt/i,
  /\bbdsm\b/i,
  /\bfuck\s?me\b/i,
  /\b (moan|groan)\s+(mix|playlist|asmr|audio)\b/i,
  /\basmr\s+(sex|erotic|moan)/i,

  // Drugs (illegal / hard)
  /\bheroin\b/i,
  /\bcrack\s+cocaine\b/i,
  /\bcocaine\s+(addict|cook)\b/i,
  /\bmeth\s+(cook|smoke|pipe)/i,
  /\bkush\s+(smoke|strains?)\b/i,

  // Violence / hate / illegal
  /\bsnuff\b/i,
  /\bcp\b\s*(sex|kiddo|child)/i,
  /\bpedo(phil)?/i,
  /\bunderage\s*(sex|girl|boy)/i,
  /\bsex\s+with\s+(minor|child|kid)/i,

  // Plain inappropriate shelf titles that ytm serves
  /\bsex\s*playlist\b/i,
  /\bmakeout\s*playlist\b/i,
  /\bbooty\s*anthem\b/i,
  /\bbang\s*playlist\b/i,
]

const ALLOW_OVERRIDE: RegExp[] = [
  // "Sex Pistols" the band / "Sex, Love & Magic" song — keep cultural items.
  /\bsex\s+pistols\b/i,
  /\bsexy\s+back\b/i,
  /\bkiss\s+from\s+a\s+rose\b/i,
]

export interface Trackish {
  title?: string
  artistName?: string
  artist?: string | string[]
  albumName?: string
  name?: string
  explicit?: boolean
}

/** Returns true if the track is allowed (safe). */
export function isContentSafe(track: Trackish | null | undefined): boolean {
  if (!track) return false

  const artistRaw = Array.isArray(track.artist) ? track.artist.join(' ') : track.artist
  const fields = [track.title, track.artistName, artistRaw, track.albumName, track.name]
    .filter((s): s is string => !!s && typeof s === 'string')
    .join(' | ')

  if (!fields.trim()) return true // metadata-less tracks (e.g. covers) — keep

  // 1) allow override
  for (const re of ALLOW_OVERRIDE) {
    if (re.test(fields)) return true
  }

  // 2) explicit flag — drop the truly-explicit ones
  if (track.explicit === true) {
    // only drop if also matches denylist (avoid nuking clean explicit-flagged stuff)
    for (const re of DENY_PATTERNS) {
      if (re.test(fields)) return false
    }
  }

  // 3) pure denylist — drop regardless of explicit flag
  for (const re of DENY_PATTERNS) {
    if (re.test(fields)) return false
  }

  return true
}

/** Filter an array of tracks in-place; returns the safe subset. */
export function filterSafeTracks<T extends Trackish>(tracks: T[]): T[] {
  if (!tracks || !tracks.length) return tracks
  const out = tracks.filter((t) => isContentSafe(t))
  return out
}

/** Filter an array of shelves — drops whole shelves if title itself is bad. */
export function isShelfTitleSafe(title: string): boolean {
  if (!title) return true
  for (const re of DENY_PATTERNS) if (re.test(title)) return false
  return true
}
