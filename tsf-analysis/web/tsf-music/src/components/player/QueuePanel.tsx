'use client'

/**
 * TSF Music — Queue panel (Phase 3)
 *
 * Lists the currently-playing track + upcoming tracks. Click an item to play
 * it now, hover shows remove (×). Header shows context (playlist/radio name).
 */

import { X, GripVertical, Play } from 'lucide-react'
import { usePlayer, type PlayerTrack } from '@/store/player'

export function QueuePanel() {
  const queue = usePlayer((s) => s.queue)
  const queueIndex = usePlayer((s) => s.queueIndex)
  const contextTitle = usePlayer((s) => s.contextTitle)
  const playTrackAt = usePlayer((s) => s.playTrackAt)
  const removeFromQueue = usePlayer((s) => s.removeFromQueue)

  const current = queue[queueIndex]
  const upcoming = queue.slice(queueIndex + 1)

  return (
    <div className="w-full bg-black/40 rounded-lg overflow-hidden flex flex-col max-h-full">
      <div className="px-4 py-3 border-b border-white/10">
        <div className="text-[11px] uppercase tracking-wider text-white/50">
          Next from
        </div>
        <div className="text-sm font-semibold text-white truncate">
          {contextTitle || 'Your queue'}
        </div>
      </div>

      <div className="overflow-y-auto flex-1 min-h-0 hide-scrollbar">
        {/* now playing */}
        {current && (
          <div className="px-4 pt-3 pb-1">
            <div className="text-[11px] uppercase tracking-wider text-[#1ed760]/80 mb-1.5">
              Now playing
            </div>
            <div className="flex items-center gap-3 p-1 rounded">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={current.thumbnail?.replace('w120-h120', 'w60-h60').replace(/=w\d+-h\d+/, '=w48-h48') || '/icon.svg'}
                alt=""
                className="w-10 h-10 rounded object-cover shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white truncate font-medium">{current.title}</div>
                <div className="text-xs text-white/60 truncate">{current.artistName}</div>
              </div>
              <Play size={14} className="text-[#1ed760] shrink-0" fill="currentColor" />
            </div>
          </div>
        )}

        {/* next up */}
        {upcoming.length > 0 && (
          <div className="px-4 pt-4 pb-1">
            <div className="text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
              Next in queue
            </div>
          </div>
        )}
        {upcoming.map((t, i) => {
          const realIdx = queueIndex + 1 + i
          return (
            <div
              key={t.videoId + '-' + realIdx}
              className="group flex items-center gap-3 px-4 py-2 rounded hover:bg-white/5 cursor-pointer"
              onClick={() => playTrackAt(realIdx)}
            >
              <GripVertical size={14} className="text-white/30 shrink-0 cursor-grab opacity-0 group-hover:opacity-100" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={t.thumbnail?.replace('w120-h120', 'w60-h60').replace(/=w\d+-h\d+/, '=w40-h40') || '/icon.svg'}
                alt=""
                className="w-10 h-10 rounded object-cover shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white truncate">{t.title}</div>
                <div className="text-xs text-white/60 truncate">{t.artistName}</div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  removeFromQueue(realIdx)
                }}
                className="text-white/40 hover:text-white opacity-0 group-hover:opacity-100 shrink-0 p-1"
                aria-label="Remove from queue"
                title="Remove"
              >
                <X size={14} />
              </button>
            </div>
          )
        })}

        {upcoming.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-white/40">
            Nothing else queued. Pick something to play.
          </div>
        )}
      </div>
    </div>
  )
}
