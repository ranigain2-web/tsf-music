/**
 * WHAT'S NEW — the reference repo's v3.2 pattern (dialog on every update +
 * an on-screen version badge), adapted to the web edition's versioning.
 *
 * Entries are appended per release; the dialog fires when the last-seen
 * version (localStorage) is older than the newest entry. Never blocks —
 * it renders after hydration and dismisses are permanent per version.
 */

export const APP_VERSION = '0.3.0'

export interface WhatsNewEntry {
  version: string
  title: string
  date: string
  items: string[]
}

export const WHATS_NEW: WhatsNewEntry[] = [
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
