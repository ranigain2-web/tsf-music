'use client'

/**
 * TSF Music — Queue drawer (right side)
 *
 * Slides in from the right when the user taps the queue icon in
 * NowPlayingBar. Different from the in-now-playing queue panel —
 * this is the slide-out drawer on the main app surface.
 */

import { X } from 'lucide-react'
import { usePlayer } from '@/store/player'
import { QueuePanel } from './QueuePanel'

export function QueueDrawer() {
  const open = usePlayer((s) => s.queueOpen)
  const toggleQueue = usePlayer((s) => s.toggleQueue)

  if (!open) return null
  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-black/30 lg:bg-transparent"
        onClick={toggleQueue}
        aria-hidden
      />
      {/* Mobile: bottom sheet that stops above the mini-player + tab bar
          (compact bar ≈64px + MobileNav ≈56px + safe area). Desktop: the
          original right-side drawer, clear of the desktop player bar. */}
      <div className="fixed z-40 inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+7.75rem)] sm:inset-x-auto sm:right-2 sm:w-[420px] sm:max-w-[calc(100vw-1rem)] lg:inset-x-auto lg:top-2 lg:right-2 lg:bottom-[88px] max-lg:rounded-2xl bg-[#121212] border border-white/10 rounded-lg shadow-2xl flex flex-col view-enter max-h-[70dvh] lg:max-h-none">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="text-base font-semibold text-white">Queue</div>
          <button
            onClick={toggleQueue}
            className="text-white/60 hover:text-white p-1.5 -mr-1"
            aria-label="Close queue"
            title="Close queue"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <QueuePanel />
        </div>
      </div>
    </>
  )
}
