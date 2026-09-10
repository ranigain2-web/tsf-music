/**
 * WHAT'S NEW — the reference repo's v3.2 pattern (dialog on every update +
 * an on-screen version badge), adapted to the web edition's versioning.
 *
 * Entries are appended per release; the dialog fires when the last-seen
 * version (localStorage) is older than the newest entry. Never blocks —
 * it renders after hydration and dismisses are permanent per version.
 */

export const APP_VERSION = '0.4.0'

export interface WhatsNewEntry {
  version: string
  title: string
  date: string
  items: string[]
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '0.4.0',
    title: 'Real songs, deep results, zero repeats',
    date: '2026-09-10',
    items: [
      'Zero-repeat lists — same recording re-listed with re-ordered credits collapses to one row, everywhere (search, feed, home)',
      'YouTube goes deep — results now walk continuation pages as you scroll, with honest retry states instead of dead ends',
      'Official songs first — YouTube search leads with the Songs filter so the real recording outranks lo-fi mixes and lyric videos',
      'Faster home scrolling — endless-feed rows render off snapshots so deep scrolls stay smooth',
    ],
  },
  {
    version: '0.3.1',
    title: 'YouTube hardening + endless home feed',
    date: '2026-08-30',
    items: [
      'YouTube playback hardening — full-length resolver chain with fair-wait and honest fallbacks',
      'Queue glitch fix — stable ordering across shuffle, healing, and radio injection',
      'Search pagination (F1) — catalog results append deep pages as you scroll',
      'Endless home feed (F2) — the home tail scrolls forever with retry and end states',
    ],
  },
  {
    version: '0.3.0',
    title: 'Search that finds the song you meant',
    date: '2026-08-29',
    items: [
      'Search V2 engine — typo correction ("arjit sing" → Arijit Singh), duplicate releases collapse to one row, wrong-artist covers can never outrank the artist you typed',
      'YouTube source — flip the Catalog | YouTube toggle for official songs and videos, playing ad-free through the engine',
      'Title-truth rescue — when the catalog only has covers, the real recording is rescued to rank 1 and labelled honestly',
      'Lyric search — type a remembered line; matches carry a green "Lyric match" chip',
      'Typeahead rail — recents instantly, best guess while you type, honest zero states with "Did you mean"',
      'Home: "Jump back in" — your recent listens, one tap away',
    ],
  },
  {
    version: '0.2.0',
    title: 'MINDBEAT v2.0 — it listens back',
    date: '2026-08-28',
    items: [
      'Smart Shuffle V2 with queue healing, Radio V2 with drift control',
      'Daylist "Now Sound" — your 11am and your 11pm get different playlists',
      'On the Rise — weekly discovery anchored by the seed of your week',
      'Taste DNA — see and correct the entire taste model',
      'Your Sound — Wrapped-grade stats with the 30-second rule',
    ],
  },
]
