/**
 * TSF Music — Seed catalog
 * Fallback data powering the app when InnerTube is unreachable (e.g. IP flag).
 * Uses REAL videoIds + real ytimg thumbnails so playback + UI are testable
 * end-to-end the moment any stream provider becomes available.
 */

import type { YtmTrack, YtmAlbum, YtmArtist, YtmShelf } from './parse'

const T = (
  videoId: string,
  title: string,
  artistName: string,
  artistId: string,
  albumName: string,
  duration: number,
  year?: number
): YtmTrack => ({
  videoId,
  title,
  artistName,
  artistId,
  albumName,
  duration,
  year,
  thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
})

const seedArtists: YtmArtist[] = [
  { browseId: 'UC0C-w0YjGpqDXGB8IHb662A', name: 'Daft Punk', thumbnail: 'https://i.ytimg.com/vi/5NV6Rdv1a3I/hqdefault.jpg' },
  { browseId: 'UCqWCgjHMBvmlgooHCgB4iQQ', name: 'Coldplay', thumbnail: 'https://i.ytimg.com/vi/k2qgadSvNyU/hqdefault.jpg' },
  { browseId: 'UCiO_6XgHSqWLnjpRIHKf_5A', name: 'The Weeknd', thumbnail: 'https://i.ytimg.com/vi/4NRXx6U8ABQ/hqdefault.jpg' },
  { browseId: 'UCJrOtniJ0-OWzsSTBKprZmw', name: 'Ed Sheeran', thumbnail: 'https://i.ytimg.com/vi/JGwWNGJdvx8/hqdefault.jpg' },
  { browseId: 'UCi0KnTGd4jAnJtPHck_8UGA', name: 'Adele', thumbnail: 'https://i.ytimg.com/vi/hLQl3WQQoQ0/hqdefault.jpg' },
  { browseId: 'UC7Dx7MTtnPO6CLAg9-L9xiw', name: 'Queen', thumbnail: 'https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg' },
  { browseId: 'UCi3FE3xzpa5qN8K3wFqz2NQ', name: 'Imagine Dragons', thumbnail: 'https://i.ytimg.com/vi/7wtfhZwyrcc/hqdefault.jpg' },
  { browseId: 'UCnS--iJ2dSSAaUtb3Faz2OA', name: 'Maroon 5', thumbnail: 'https://i.ytimg.com/vi/SlPhMPnQ58k/hqdefault.jpg' },
  { browseId: 'UCqjg36t2Eq6S4nF4h4Gg3jA', name: 'Dua Lipa', thumbnail: 'https://i.ytimg.com/vi/TUVcZfQe-Kw/hqdefault.jpg' },
  { browseId: 'UCCb1tsonMBki_4mDDvgm4mQ', name: 'The Neighbourhood', thumbnail: 'https://i.ytimg.com/vi/bf7Am9Nf-hc/hqdefault.jpg' },
]

const seedTracks: YtmTrack[] = [
  T('LKYPYj2XX80', 'Around the World', 'Daft Punk', 'UC0C-w0YjGpqDXGB8IHb662A', 'Homework', 428, 1997),
  T('5NV6Rdv1a3I', 'Get Lucky (feat. Pharrell Williams)', 'Daft Punk', 'UC0C-w0YjGpqDXGB8IHb662A', 'Random Access Memories', 369, 2013),
  T('yuFI5KSPAt4', 'One More Time', 'Daft Punk', 'UC0C-w0YjGpqDXGB8IHb662A', 'Discovery', 320, 2000),
  T('yKNxeF4KMsY', 'Harder, Better, Faster, Stronger', 'Daft Punk', 'UC0C-w0YjGpqDXGB8IHb662A', 'Discovery', 224, 2001),
  T('dVGZbMZaEq8', 'Instant Crush (feat. Julian Casablancas)', 'Daft Punk', 'UC0C-w0YjGpqDXGB8IHb662A', 'Random Access Memories', 337, 2013),
  T('k2qgadSvNyU', 'The Scientist', 'Coldplay', 'UCqWCgjHMBvmlgooHCgB4iQQ', 'A Rush of Blood to the Head', 309, 2002),
  T('RB-RcX5DS5A', 'Fix You', 'Coldplay', 'UCqWCgjHMBvmlgooHCgB4iQQ', 'X&Y', 296, 2005),
  T('QtXby3tw-mI', 'Viva La Vida', 'Coldplay', 'UCqWCgjHMBvmlgooHCgB4iQQ', 'Viva la Vida or Death and All His Friends', 242, 2008),
  T('1G4isv_Fylg', 'Paradise', 'Coldplay', 'UCqWCgjHMBvmlgooHCgB4iQQ', 'Mylo Xyloto', 278, 2011),
  T('4NRXx6U8ABQ', 'Blinding Lights', 'The Weeknd', 'UCiO_6XgHSqWLnjpRIHKf_5A', 'After Hours', 200, 2019),
  T('q26IgsLRY0Y', 'Save Your Tears', 'The Weeknd', 'UCiO_6XgHSqWLnjpRIHKf_5A', 'After Hours', 215, 2020),
  T('2fDvBWjljK0', 'Starboy (feat. Daft Punk)', 'The Weeknd', 'UCiO_6XgHSqWLnjpRIHKf_5A', 'Starboy', 230, 2016),
  T('yWtS4Zp4H5M', 'The Hills', 'The Weeknd', 'UCiO_6XgHSqWLnjpRIHKf_5A', 'Beauty Behind the Madness', 242, 2015),
  T('JGwWNGJdvx8', 'Shape of You', 'Ed Sheeran', 'UCJrOtniJ0-OWzsSTBKprZmw', '÷ (Deluxe)', 234, 2017),
  T('2Vv-BfVoq4g', 'Perfect', 'Ed Sheeran', 'UCJrOtniJ0-OWzsSTBKprZmw', '÷ (Deluxe)', 263, 2017),
  T('lp-EO5I60KA', 'Thinking Out Loud', 'Ed Sheeran', 'UCJrOtniJ0-OWzsSTBKprZmw', 'x (Deluxe Edition)', 281, 2014),
  T('hLQl3WQQoQ0', 'Someone Like You', 'Adele', 'UCi0KnTGd4jAnJtPHck_8UGA', '21', 285, 2011),
  T('rYEDA3JcQqw', 'Adele - Rolling in the Deep', 'Adele', 'UCi0KnTGd4jAnJtPHck_8UGA', '21', 228, 2010),
  T('YQHsXMglC9A', 'Hello', 'Adele', 'UCi0KnTGd4jAnJtPHck_8UGA', '25', 367, 2015),
  T('fJ9rUzIMcZQ', 'Bohemian Rhapsody', 'Queen', 'UC7Dx7MTtnPO6CLAg9-L9xiw', 'A Night at the Opera', 355, 1975),
  T('HgzGwKwLmgM', "Don't Stop Me Now", 'Queen', 'UC7Dx7MTtnPO6CLAg9-L9xiw', 'Jazz', 209, 1978),
  T('7wtfhZwyrcc', 'Believer', 'Imagine Dragons', 'UCi3FE3xzpa5qN8K3wFqz2NQ', 'Evolve', 204, 2017),
  T('ktvTqknDobU', 'Radioactive', 'Imagine Dragons', 'UCi3FE3xzpa5qN8K3wFqz2NQ', 'Night Visions', 187, 2012),
  T('SlPhMPnQ58k', 'Sugar', 'Maroon 5', 'UCnS--iJ2dSSAaUtb3Faz2OA', 'V', 302, 2014),
  T('TUVcZfQe-Kw', 'New Rules', 'Dua Lipa', 'UCqjg36t2Eq6S4nF4h4Gg3jA', 'Dua Lipa', 209, 2017),
  T('bf7Am9Nf-hc', 'Sweater Weather', 'The Neighbourhood', 'UCCb1tsonMBki_4mDDvgm4mQ', 'I Love You.', 240, 2013),
]

const seedAlbums: YtmAlbum[] = [
  { browseId: 'MPREb_randomaccessmemories', name: 'Random Access Memories', artistName: 'Daft Punk', year: 2013, thumbnail: 'https://i.ytimg.com/vi/5NV6Rdv1a3I/hqdefault.jpg' },
  { browseId: 'MPREb_discovery', name: 'Discovery', artistName: 'Daft Punk', year: 2001, thumbnail: 'https://i.ytimg.com/vi/yuFI5KSPAt4/hqdefault.jpg' },
  { browseId: 'MPREb_afterhours', name: 'After Hours', artistName: 'The Weeknd', year: 2020, thumbnail: 'https://i.ytimg.com/vi/4NRXx6U8ABQ/hqdefault.jpg' },
  { browseId: 'MPREb_21', name: '21', artistName: 'Adele', year: 2011, thumbnail: 'https://i.ytimg.com/vi/hLQl3WQQoQ0/hqdefault.jpg' },
  { browseId: 'MPREb_nightvisions', name: 'Night Visions', artistName: 'Imagine Dragons', year: 2012, thumbnail: 'https://i.ytimg.com/vi/ktvTqknDobU/hqdefault.jpg' },
]

export function seedSearch(query: string): { tracks: YtmTrack[]; albums: YtmAlbum[]; artists: YtmArtist[] } {
  const q = query.toLowerCase().trim()
  if (!q) return { tracks: [], albums: [], artists: [] }
  return {
    tracks: seedTracks.filter(
      (t) => t.title.toLowerCase().includes(q) || t.artistName.toLowerCase().includes(q) || t.albumName?.toLowerCase().includes(q)
    ),
    albums: seedAlbums.filter((a) => a.name.toLowerCase().includes(q) || a.artistName?.toLowerCase().includes(q)),
    artists: seedArtists.filter((a) => a.name.toLowerCase().includes(q)),
  }
}

export function seedHome(): YtmShelf[] {
  const by = (artist: string) => seedTracks.filter((t) => t.artistName === artist)
  return [
    {
      title: 'Recently played',
      tracks: seedTracks.slice(0, 8),
    },
    {
      title: 'Made for you',
      subtitle: 'Mixes built from what you love',
      tracks: [seedTracks[4], seedTracks[9], seedTracks[14], seedTracks[19], seedTracks[22], seedTracks[25]],
    },
    {
      title: 'Trending hits',
      tracks: [...seedTracks].sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 10),
    },
    {
      title: 'Throwback classics',
      tracks: [...seedTracks].sort((a, b) => (a.year || 9999) - (b.year || 9999)).slice(0, 8),
    },
    {
      title: 'Artists you may like',
      artists: seedArtists.slice(0, 6),
    },
    {
      title: 'New releases',
      albums: seedAlbums,
    },
    {
      title: 'Daft Punk radio',
      tracks: by('Daft Punk'),
    },
    {
      title: 'Chill evening',
      tracks: [seedTracks[5], seedTracks[10], seedTracks[14], seedTracks[19], seedTracks[25]],
    },
  ]
}

export function seedArtist(browseId: string): { name: string; thumbnail: string; description: string; subscribers: string; shelves: YtmShelf[]; topTracks: YtmTrack[] } {
  const artist = seedArtists.find((a) => a.browseId === browseId) ?? seedArtists[0]
  const tracks = seedTracks.filter((t) => t.artistId === artist.browseId)
  return {
    name: artist.name,
    thumbnail: artist.thumbnail,
    description: `${artist.name} — seeded artist page (offline mode).`,
    subscribers: '—',
    shelves: [
      { title: 'Albums', albums: seedAlbums.filter((a) => a.artistName === artist.name) },
      { title: 'Fans might also like', artists: seedArtists.filter((a) => a.browseId !== artist.browseId).slice(0, 5) },
    ],
    topTracks: tracks,
  }
}

export function seedAlbumTracks(browseId: string) {
  const album = seedAlbums.find((a) => a.browseId === browseId)
  if (!album) {
    return { title: 'Liked Songs', subtitle: 'Your saved tracks', thumbnail: '', tracks: seedTracks.slice(0, 12) }
  }
  return {
    title: album.name,
    subtitle: `${album.artistName} • ${album.year ?? ''}`,
    thumbnail: album.thumbnail,
    tracks: seedTracks.filter((t) => t.albumName === album.name),
  }
}

export const SEED = { tracks: seedTracks, albums: seedAlbums, artists: seedArtists }
