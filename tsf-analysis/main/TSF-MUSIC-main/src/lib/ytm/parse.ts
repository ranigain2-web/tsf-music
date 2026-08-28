/**
 * TSF Music — InnerTube response parsers
 * Walks nested renderer trees into clean, typed objects.
 */

export interface YtmTrack {
  videoId: string
  title: string
  artistName: string
  artistId?: string
  albumName?: string
  albumId?: string
  duration: number
  thumbnail: string
  year?: number
  explicit?: boolean
  plays?: string
}

export interface YtmAlbum {
  browseId: string
  name: string
  artistName?: string
  artistId?: string
  year?: number
  thumbnail: string
  trackCount?: number
}

export interface YtmArtist {
  browseId: string
  name: string
  thumbnail: string
  description?: string
  subscribers?: string
}

export interface YtmShelf {
  title: string
  subtitle?: string
  tracks?: YtmTrack[]
  albums?: YtmAlbum[]
  artists?: YtmArtist[]
}

// ---------- deep-walk helpers ----------

type AnyObj = Record<string, any>

export function* walk(node: any): Generator<AnyObj> {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) yield* walk(item)
    return
  }
  yield node as AnyObj
  for (const value of Object.values(node)) yield* walk(value)
}

export function findAll(node: any, key: string): AnyObj[] {
  const out: AnyObj[] = []
  for (const obj of walk(node)) {
    if (key in obj) out.push(obj[key])
  }
  return out
}

function text(node: any): string {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (node.runs) return node.runs.map((r: any) => r.text).join('')
  if (node.simpleText) return node.simpleText
  return ''
}

function parseDuration(s: string): number {
  if (!s) return 0
  const parts = s.split(':').map(Number)
  if (parts.some(isNaN)) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

const TYPE_LABELS = ['Song', 'Album', 'Video', 'Artist', 'Playlist', 'Episode', 'Profile', 'Podcast', 'Single', 'EP']

/** Collect every run across flexColumns (flat, in order). */
function collectRuns(r: any): any[] {
  const runs: any[] = []
  for (const col of r.flexColumns || []) {
    const colRuns = col.musicResponsiveListItemFlexColumnRenderer?.text?.runs
    if (Array.isArray(colRuns)) runs.push(...colRuns)
  }
  return runs
}

/** Universal videoId extraction from a row. */
function extractVideoId(r: any): string | undefined {
  for (const run of collectRuns(r)) {
    if (run.navigationEndpoint?.watchEndpoint?.videoId) return run.navigationEndpoint.watchEndpoint.videoId
  }
  if (r.playlistItemData?.videoId) return r.playlistItemData.videoId
  const overlay = r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
  if (overlay?.playNavigationEndpoint?.watchEndpoint?.videoId) return overlay.playNavigationEndpoint.watchEndpoint.videoId
  if (r.navigationEndpoint?.watchEndpoint?.videoId) return r.navigationEndpoint.watchEndpoint.videoId
  return undefined
}

function thumbUrl(thumbnails: any, min = 226): string {
  if (!thumbnails || !Array.isArray(thumbnails) || !thumbnails.length) return ''
  const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0))
  return sorted[0]?.url || sorted[sorted.length - 1]?.url || ''
}

// ---------- track parsing ----------

export function parseTrackRenderer(item: any): YtmTrack | null {
  const r = item.musicResponsiveListItemRenderer ?? item
  if (!r) return null

  const runs = collectRuns(r)
  if (!runs.length) return null

  const title = runs[0]?.text || ''
  const videoId = extractVideoId(r)
  if (!videoId || !title) return null

  let artistName = ''
  let artistId: string | undefined
  let albumName: string | undefined
  let albumId: string | undefined
  let durationStr = ''
  let plays = ''
  let year: number | undefined

  for (const run of runs.slice(1)) {
    const bep = run.navigationEndpoint?.browseEndpoint?.browseId
    const t = run.text || ''
    if (bep?.startsWith('UC')) {
      if (!artistName) { artistName = t; artistId = bep }
    } else if (bep?.startsWith('MPREb')) {
      if (!albumName) { albumName = t; albumId = bep }
    } else if (/^\d+(?::\d+)+$/.test(t)) {
      durationStr = t
    } else if (/\d+(?:\.\d+)?[MK]?\s*(?:plays|views|monthly audience|subscribers)/i.test(t)) {
      plays = t
    } else if (/^(19|20)\d{2}$/.test(t)) {
      year = Number(t)
    }
  }

  if (!durationStr) {
    const fixed = r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text
    durationStr = text(fixed)
  }

  // fallback: type-label pattern "Title / Song / Artist / plays" — artist is the
  // first unlabeled run after the type label that isn't a duration/year/playcount
  if (!artistName) {
    const typeIdx = runs.findIndex((x: any) => TYPE_LABELS.includes(x.text))
    for (let i = (typeIdx >= 0 ? typeIdx + 1 : 1); i < runs.length; i++) {
      const t = runs[i].text || ''
      if (t === ' • ' || !t) continue
      if (/^\d+(?::\d+)+$/.test(t)) break
      if (/^(19|20)\d{2}$/.test(t)) continue
      if (/(plays|views|monthly audience|subscribers)/i.test(t)) break
      artistName = t
      break
    }
  }

  return {
    videoId,
    title,
    artistName: artistName || 'Unknown artist',
    artistId,
    albumName,
    albumId,
    duration: parseDuration(durationStr),
    thumbnail: thumbUrl(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails),
    year,
    plays,
    explicit: !!r.badges?.some((b: any) => b.musicInlineBadgeRenderer?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE'),
  }
}

// ---------- search parsing ----------

export function parseSearch(response: any): { tracks: YtmTrack[]; albums: YtmAlbum[]; artists: YtmArtist[] } {
  const tracks: YtmTrack[] = []
  const albums: YtmAlbum[] = []
  const artists: YtmArtist[] = []
  const seenT = new Set<string>()
  const seenAl = new Set<string>()
  const seenAr = new Set<string>()

  const pushRow = (r: any) => {
    const runs = collectRuns(r)
    if (!runs.length) return
    const title = runs[0]?.text || ''
    const typeLabel = runs[1]?.text || ''
    const videoId = extractVideoId(r)
    const itemBrowseId = r.navigationEndpoint?.browseEndpoint?.browseId
    const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails

    // NON-MUSIC JUNK FILTER: the unfiltered search groups results by type
    // into shelves whose rows carry a type label ("Song", "Video",
    // "Episode", …). Podcast episodes / profiles ("Kesariya Controversy &
    // More", interview clips, channel plugs…) must never pollute a music
    // app's song list — Spotify-style search is songs/videos/albums/artists
    // only. Videos stay: official music videos are core music content.
    if (typeLabel === 'Episode' || typeLabel === 'Podcast' || typeLabel === 'Profile') return

    // meta from runs
    let artistName = ''
    let artistId: string | undefined
    let year: number | undefined
    let plays = ''
    for (const run of runs.slice(1)) {
      const bep = run.navigationEndpoint?.browseEndpoint?.browseId
      if (bep?.startsWith('UC') && !artistName) { artistName = run.text; artistId = bep }
      if (/^(19|20)\d{2}$/.test(run.text || '') && year === undefined) year = Number(run.text)
      if (/\d/.test(run.text || '') && /(plays|views|monthly audience|subscribers)/i.test(run.text || '')) plays = run.text
    }

    if (itemBrowseId?.startsWith('MPREb')) {
      // album row
      if (!seenAl.has(itemBrowseId)) {
        seenAl.add(itemBrowseId)
        albums.push({
          browseId: itemBrowseId,
          name: title,
          artistName: artistName || undefined,
          artistId,
          year,
          thumbnail: thumbUrl(thumbs),
        })
      }
      return
    }

    if (typeLabel === 'Artist' || (itemBrowseId?.startsWith('UC') && !videoId)) {
      // artist row
      const id = itemBrowseId || artistId
      if (id && !seenAr.has(id)) {
        seenAr.add(id)
        artists.push({
          browseId: id,
          name: title,
          thumbnail: thumbUrl(thumbs),
          subscribers: plays,
        })
      }
      return
    }

    if (videoId) {
      // song or video row → playable track
      if (!seenT.has(videoId)) {
        seenT.add(videoId)
        const t = parseTrackRenderer(r)
        if (t) tracks.push(t)
      }
    }
  }

  const contents =
    response?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []

  for (const section of contents) {
    // top-result card
    const card = section.musicCardShelfRenderer
    if (card) {
      const cardTitleRun = card.title?.runs?.[0]
      const cardBrowseId = cardTitleRun?.navigationEndpoint?.browseEndpoint?.browseId
      const cardSubtitle = text(card.subtitle)
      if (cardBrowseId?.startsWith('UC')) {
        if (!seenAr.has(cardBrowseId)) {
          seenAr.add(cardBrowseId)
          artists.push({
            browseId: cardBrowseId,
            name: cardTitleRun.text,
            thumbnail: thumbUrl(card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails),
            subscribers: cardSubtitle.split(' • ')[1],
          })
        }
      }
      // scan ALL card contents for the first track row — contents[0] can be a
      // messageRenderer ("More from YouTube") with the actual track at [1].
      const inner = (card.contents || []).map((c: any) => c.musicResponsiveListItemRenderer).find(Boolean)
      if (inner) pushRow(inner)
      continue
    }

    // shelf section
    const shelfItems = section.musicShelfRenderer?.contents
    if (Array.isArray(shelfItems)) {
      for (const item of shelfItems) {
        if (item.musicResponsiveListItemRenderer) pushRow(item.musicResponsiveListItemRenderer)
      }
      continue
    }

    // item sections (unfiltered search)
    const itemSectionItems = section.itemSectionRenderer?.contents
    if (Array.isArray(itemSectionItems)) {
      for (const item of itemSectionItems) {
        const r = item.musicResponsiveListItemRenderer
        if (r) pushRow(r)
        else if (item.musicTwoRowItemRenderer) {
          // carousel-style cards
          const rr = item.musicTwoRowItemRenderer
          const bep = rr.navigationEndpoint?.browseEndpoint
          const name = text(rr.title)
          if (bep?.browseId?.startsWith('MPREb') && !seenAl.has(bep.browseId)) {
            seenAl.add(bep.browseId)
            albums.push({
              browseId: bep.browseId,
              name,
              artistName: text(rr.subtitle).split(' • ')[0] || undefined,
              year: Number(text(rr.subtitle).match(/\b(19|20)\d{2}\b/)?.[0]) || undefined,
              thumbnail: thumbUrl(rr.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails),
            })
          }
        }
      }
    }
  }

  return { tracks, albums, artists }
}

// ---------- album / playlist tracklist ----------

export function parseTracklist(response: any): { title: string; subtitle: string; thumbnail: string; tracks: YtmTrack[] } {
  // album pages: twoColumnBrowseResultsRenderer with musicResponsiveHeaderRenderer in primary
  const twoCol = response?.contents?.twoColumnBrowseResultsRenderer
  const primarySections =
    twoCol?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []
  const responsiveHeader = primarySections.find((s: any) => s.musicResponsiveHeaderRenderer)
    ?.musicResponsiveHeaderRenderer

  const header =
    responsiveHeader ||
    response?.header?.musicDetailHeaderRenderer ||
    response?.header?.musicResponsiveHeaderRenderer ||
    response?.header?.musicImmersiveHeaderRenderer ||
    {}

  const contents =
    response?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer
      ?.contents || []
  const playlistContents = twoCol?.secondaryContents?.sectionListRenderer?.contents || []

  const sections = [...contents, ...playlistContents]
  const tracks: YtmTrack[] = []
  const seen = new Set<string>()

  for (const section of sections) {
    const items =
      section.musicShelfRenderer?.contents ||
      section.musicPlaylistShelfRenderer?.contents ||
      []
    for (const item of items) {
      const t = parseTrackRenderer(item)
      if (t && !seen.has(t.videoId)) {
        seen.add(t.videoId)
        tracks.push(t)
      }
    }
  }

  return {
    title: text(header.title),
    subtitle: text(header.subtitle),
    thumbnail: thumbUrl(
      header.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
        header.thumbnailMenuRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails
    ),
    tracks,
  }
}

// ---------- artist page ----------

export function parseArtistPage(response: any): {
  name: string
  thumbnail: string
  description: string
  subscribers: string
  shelves: YtmShelf[]
  topTracks: YtmTrack[]
} {
  const header =
    response?.header?.musicImmersiveHeaderRenderer ||
    response?.header?.musicVisualHeaderRenderer ||
    response?.header?.musicDetailHeaderRenderer ||
    {}

  const shelves: YtmShelf[] = []
  const topTracks: YtmTrack[] = []
  const seenTop = new Set<string>()

  const sections =
    response?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer
      ?.contents || []

  for (const section of sections) {
    const shelf = section.musicShelfRenderer
    if (shelf) {
      const tracks: YtmTrack[] = []
      for (const item of shelf.contents || []) {
        const t = parseTrackRenderer(item)
        if (t) {
          tracks.push(t)
          if (text(shelf.title).toLowerCase().includes('top') && !seenTop.has(t.videoId)) {
            seenTop.add(t.videoId)
            topTracks.push(t)
          }
        }
      }
      if (tracks.length) {
        shelves.push({ title: text(shelf.title), tracks })
      }
      continue
    }

    const carousel = section.musicCarouselShelfRenderer
    if (carousel) {
      const title = text(carousel.header?.musicCarouselShelfBasicHeaderRenderer?.title)
      const albums: YtmAlbum[] = []
      const artists: YtmArtist[] = []
      const tracks: YtmTrack[] = []
      for (const item of carousel.contents || []) {
        const r = item.musicTwoRowItemRenderer
        if (r) {
          const bep = r.navigationEndpoint?.browseEndpoint
          const name = text(r.title)
          if (bep?.browseId?.startsWith('MPREb')) {
            albums.push({
              browseId: bep.browseId,
              name,
              year: Number(text(r.subtitle).match(/\b(19|20)\d{2}\b/)?.[0]) || undefined,
              thumbnail: thumbUrl(r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails),
            })
          } else if (bep?.browseId?.startsWith('UC')) {
            artists.push({
              browseId: bep.browseId,
              name,
              thumbnail: thumbUrl(r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails),
            })
          } else if (r.navigationEndpoint?.watchEndpoint?.videoId) {
            const t = parseTwoRowAsTrack(r)
            if (t) tracks.push(t)
          }
        }
        if (item.musicResponsiveListItemRenderer) {
          const t = parseTrackRenderer(item)
          if (t) tracks.push(t)
        }
      }
      if (albums.length) shelves.push({ title, albums })
      else if (artists.length) shelves.push({ title, artists })
      else if (tracks.length) shelves.push({ title, tracks })
    }
  }

  return {
    name: text(header.title),
    thumbnail: thumbUrl(
      header.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
        header.foregroundThumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
    ),
    description: text(header.description),
    subscribers: text(header.subscriptionButton?.subscribeButtonRenderer?.subscriberCountText) ||
      text(header.secondSubtitle),
    shelves,
    topTracks,
  }
}

function parseTwoRowAsTrack(r: any): YtmTrack | null {
  const videoId = r.navigationEndpoint?.watchEndpoint?.videoId
  if (!videoId) return null
  const sub = text(r.subtitle)
  // two-row video cards often end with " • 4:24" — pick the mm:ss tail up.
  const durMatch = sub.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/)
  return {
    videoId,
    title: text(r.title),
    artistName: sub.split(' • ')[0] || 'Unknown artist',
    duration: durMatch ? parseDuration(durMatch[1]) : 0,
    thumbnail: thumbUrl(r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails),
  }
}

// ---------- home feed ----------

export function parseHomeFeed(response: any): YtmShelf[] {
  const shelves: YtmShelf[] = []
  const sections =
    response?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer
      ?.contents || []

  for (const section of sections) {
    const carousel = section.musicCarouselShelfRenderer
    if (!carousel) continue
    const title = text(carousel.header?.musicCarouselShelfBasicHeaderRenderer?.title)
    const subtitle = text(carousel.header?.musicCarouselShelfBasicHeaderRenderer?.subtitle)
    const albums: YtmAlbum[] = []
    const tracks: YtmTrack[] = []
    const artists: YtmArtist[] = []

    for (const item of carousel.contents || []) {
      const r = item.musicTwoRowItemRenderer
      if (!r) continue
      const bep = r.navigationEndpoint?.browseEndpoint
      const wep = r.navigationEndpoint?.watchEndpoint
      if (bep?.browseId?.startsWith('MPREb')) {
        albums.push({
          browseId: bep.browseId,
          name: text(r.title),
          artistName: text(r.subtitle).split(' • ')[0],
          year: Number(text(r.subtitle).match(/\b(19|20)\d{2}\b/)?.[0]) || undefined,
          thumbnail: thumbUrl(r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails),
        })
      } else if (bep?.browseId?.startsWith('UC')) {
        artists.push({
          browseId: bep.browseId,
          name: text(r.title),
          thumbnail: thumbUrl(r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails),
        })
      } else if (bep?.browseId?.startsWith('MPSP')) {
        // playlist card — treat as album-like card
        albums.push({
          browseId: bep.browseId,
          name: text(r.title),
          artistName: text(r.subtitle),
          thumbnail: thumbUrl(r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails),
        })
      } else if (wep?.videoId) {
        const t = parseTwoRowAsTrack(r)
        if (t) tracks.push(t)
      }
    }

    if (albums.length) shelves.push({ title, subtitle, albums })
    else if (tracks.length) shelves.push({ title, subtitle, tracks })
    else if (artists.length) shelves.push({ title, subtitle, artists })
  }

  return shelves
}

// ---------- radio / up next ----------

export function parseRadio(response: any): YtmTrack[] {
  // path-agnostic: find every playlistPanelVideoRenderer in the tree
  const items = findAll(response, 'playlistPanelVideoRenderer')
  const tracks: YtmTrack[] = []
  const seen = new Set<string>()
  for (const r of items) {
    const videoId = r.videoId
    if (!videoId || seen.has(videoId)) continue
    seen.add(videoId)
    const longByline = r.longBylineText?.runs || []
    let artistName = ''
    let artistId: string | undefined
    let albumName: string | undefined
    for (const run of longByline) {
      const bep = run.navigationEndpoint?.browseEndpoint
      if (bep?.browseId?.startsWith('UC')) { if (!artistName) { artistName = run.text; artistId = bep.browseId } }
      else if (bep?.browseId?.startsWith('MPREb')) { if (!albumName) albumName = run.text }
    }
    if (!artistName) {
      const r0 = longByline.find((x: any) => x.text && x.text !== ' • ' && !/\d+:\d+/.test(x.text))
      if (r0) artistName = r0.text
    }
    tracks.push({
      videoId,
      title: text(r.title),
      artistName: artistName || 'Unknown artist',
      artistId,
      albumName,
      duration: parseDuration(text(r.lengthText)),
      thumbnail: thumbUrl(r.thumbnail?.thumbnails),
    })
  }
  return tracks
}

// ---------- lyrics ----------

export function parseLyrics(response: any): { synced: boolean; lines: { time: number; text: string }[] } {
  const renderer =
    response?.contents?.elementRenderer?.newElement?.type?.componentType?.model?.timedLyricsModel ||
    response?.continuationContents?.musicLyricsSectionRenderer?.continuation?.timedLyricsRender ||
    null

  const lines = renderer?.lyrics?.lines || []
  const result = lines.map((l: any) => ({
    time: (l.startTimeMs ?? l.startTimeMillis ?? 0) / 1000,
    text: (l.words ?? l.text ?? '').replace(/ +/g, ' '),
  }))

  return { synced: result.some((l: any) => l.time > 0), lines: result }
}
