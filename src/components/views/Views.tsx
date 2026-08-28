'use client'

/**
 * TSF Music — view switcher
 */

import { useNav } from '@/store/nav'
import { HomeView } from './HomeView'
import { SearchView } from './SearchView'
import { AlbumView } from './AlbumView'
import { ArtistView } from './ArtistView'
import { LibraryView } from './LibraryView'
import { LikedView } from './LikedView'
import { PlaylistView } from './PlaylistView'
import { AiGeneratedView } from './AiGeneratedView'

export function Views() {
  const view = useNav((s) => s.view)

  switch (view.type) {
    case 'home':
      return <HomeView />
    case 'search':
      return <SearchView initialQuery={view.q} />
    case 'album':
      return <AlbumView id={view.id} />
    case 'artist':
      return <ArtistView id={view.id} />
    case 'library':
      return <LibraryView />
    case 'liked':
      return <LikedView />
    case 'playlist':
      return <PlaylistView id={view.id} />
    case 'ai-generated':
      return (
        <AiGeneratedView
          endpoint={view.endpoint}
          title={view.title}
          subtitle={view.subtitle}
          gradient={view.gradient}
          emoji={view.emoji}
        />
      )
    case 'mood':
      return (
        <AiGeneratedView
          endpoint={`/api/ai/mood-playlists?mood=${encodeURIComponent(view.mood)}`}
          title={view.title}
          gradient={view.gradient}
          emoji={view.emoji}
        />
      )
    default:
      return <HomeView />
  }
}

