'use client'

/**
 * TSF Music — App shell
 * Spotify's exact layout anatomy:
 *   ┌─────────┬──────────────────┐
 *   │ sidebar │  topbar          │
 *   │ (nav +  │──────────────────│
 *   │ library)│  main (scroll)   │
 *   ├─────────┴──────────────────┤
 *   │  now-playing bar (fixed)   │
 *   └────────────────────────────┘
 * Mobile: sidebar hidden, bottom nav + mini player.
 */

import { useEffect } from 'react'
import { Sidebar } from '@/components/shell/Sidebar'
import { TopBar } from '@/components/shell/TopBar'
import { NowPlayingBar } from '@/components/player/NowPlayingBar'
import { FullScreenNowPlaying } from '@/components/player/FullScreenNowPlaying'
import { QueueDrawer } from '@/components/player/QueueDrawer'
import { MobileNav } from '@/components/shell/MobileNav'
import { AudioEngine } from '@/components/player/AudioEngine'
import { useNav } from '@/store/nav'
import { useLibrary } from '@/store/library'
import { Views } from '@/components/views/Views'

export function AppShell() {
  const view = useNav((s) => s.view)
  const refreshLibrary = useLibrary((s) => s.refresh)

  useEffect(() => {
    void refreshLibrary()
  }, [refreshLibrary])

  return (
    <div className="h-dvh w-full overflow-hidden bg-black text-white flex flex-col">
      <div className="flex flex-1 min-h-0 gap-2 p-2 pb-0 lg:pb-2">
        {/* sidebar (desktop) */}
        <aside className="hidden lg:flex w-[280px] shrink-0 flex-col gap-2">
          <Sidebar />
        </aside>

        {/* main column */}
        <main className="flex-1 min-w-0 flex flex-col rounded-lg overflow-hidden bg-[#121212]">
          <TopBar />
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div key={JSON.stringify(view)} className="view-enter min-h-full">
              <Views />
            </div>
          </div>
        </main>
      </div>

      {/* player bars */}
      <NowPlayingBar />
      <MobileNav />

      {/* queue drawer (right side, toggle from NowPlayingBar) */}
      <QueueDrawer />

      {/* full-screen now playing overlay */}
      <FullScreenNowPlaying />

      {/* audio engine — no UI */}
      <AudioEngine />
    </div>
  )
}
