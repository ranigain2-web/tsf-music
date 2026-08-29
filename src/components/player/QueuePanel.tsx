'use client'

/**
 * TSF Music — Queue panel (Phase 3 + reorder + BAR-B §2.4 gestures)
 *
 * Lists the currently-playing track + upcoming tracks. Tap an item to play
 * it now. Upcoming tracks are:
 *   - drag-reorderable via dnd-kit (grip handle; the playing track is pinned)
 *   - swipe-LEFT to remove (Spotify's native queue gesture) via framer-motion
 *   - hover shows remove (×) on pointer devices
 * Header shows context.
 *
 * Touch-behavior notes:
 *   - the row itself is NOT touch-none (that would block list scrolling);
 *     framer-motion's drag="x" sets touch-action: pan-y so vertical scroll
 *     still works while a horizontal swipe is captured
 *   - the dnd grip is hover-revealed (touch users swipe instead — matches
 *     Spotify's queue anatomy where rows have no visible chrome)
 */

import { useRef, useState } from 'react'
import { X, GripVertical, Trash2, Music4, Sparkles } from 'lucide-react'
import { motion } from 'framer-motion'
import { usePlayer, type PlayerTrack } from '@/store/player'
import { surfaceFlags } from '@/lib/mindbeat/client'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

/** swipe distance (px) past which a row is removed from the queue */
const SWIPE_REMOVE_THRESHOLD = -72

function SortableRow({
  track,
  realIdx,
  onPlay,
  onRemove,
}: {
  track: PlayerTrack
  realIdx: number
  onPlay: (i: number) => void
  onRemove: (i: number) => void
}) {
  const [armed, setArmed] = useState(false) // true while the red reveal shows
  const didDrag = useRef(false) // suppress the click that follows a swipe
  // KILL SWITCH (plan §10.4): explanations off → the Sparkles badge (which
  // exists purely to carry the reason line) is hidden entirely.
  const showReasonBadge = !!track.__rec && !surfaceFlags().noReasons
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: track.videoId + '-' + realIdx,
    disabled: false,
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
    position: isDragging ? 'relative' : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative overflow-hidden rounded ${isDragging ? 'bg-white/10 shadow-lg shadow-black/60' : ''}`}
    >
      {/* red remove layer revealed under the row while swiping left.
          NOTE: inline opacity, NOT the opacity-0 class — globals.css reveals
          `.group .opacity-0` on touch devices (hover:none), which would pin
          the red layer permanently visible behind every row. */}
      <div
        aria-hidden
        className="absolute inset-y-0 right-0 left-8 flex items-center justify-end pr-4 bg-[#e91429] text-white transition-opacity"
        style={{ opacity: armed ? 1 : 0 }}
      >
        <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide">
          <Trash2 size={15} /> Remove
        </span>
      </div>

      <motion.div
        role="button"
        tabIndex={0}
        aria-label={`Play ${track.title} by ${track.artistName}`}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: -120, right: 0 }}
        dragElastic={0.12}
        dragSnapToOrigin
        onPointerDown={() => {
          didDrag.current = false // re-arm click; set true only if a drag starts
        }}
        onDragStart={() => {
          didDrag.current = true
          setArmed(true)
        }}
        onDragEnd={(_, info) => {
          setArmed(false)
          if (info.offset.x < SWIPE_REMOVE_THRESHOLD) {
            onRemove(realIdx)
          }
        }}
        onClick={() => {
          if (!didDrag.current) onPlay(realIdx)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onPlay(realIdx)
          }
        }}
        className={`relative flex items-center gap-3 px-4 py-2 cursor-pointer touch-pan-y select-none ${
          isDragging ? '' : 'hover:bg-white/5'
        }`}
      >
        {/* grip — pointer-device reorder handle (touch users swipe/drag on it too) */}
        <button
          {...listeners}
          {...attributes}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="text-white/30 hover:text-white/70 shrink-0 p-0.5 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity touch-none"
          aria-label={`Reorder ${track.title}`}
          title="Drag to reorder"
        >
          <GripVertical size={14} />
        </button>
        { }
        <img
          src={track.thumbnail?.replace('w120-h120', 'w60-h60').replace(/=w\d+-h\d+/, '=w40-h40') || '/icon.svg'}
          alt=""
          className="w-10 h-10 rounded object-cover shrink-0 pointer-events-none"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm truncate text-white flex items-center gap-1.5">
            <span className="truncate">{track.title}</span>
            {showReasonBadge && (
              <span title={track.__reason || 'Smart shuffle pick'} className="shrink-0 inline-flex">
                <Sparkles size={12} className="text-[#1ed760]" aria-label="Smart shuffle pick" />
              </span>
            )}
          </div>
          <div className="text-xs text-white/60 truncate">{track.artistName}</div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove(realIdx)
          }}
          className="text-white/40 hover:text-white opacity-0 group-hover:opacity-100 shrink-0 p-1 transition-opacity max-md:hidden"
          aria-label="Remove from queue"
          title="Remove"
        >
          <X size={14} />
        </button>
      </motion.div>
    </div>
  )
}

export function QueuePanel() {
  const queue = usePlayer((s) => s.queue)
  const queueIndex = usePlayer((s) => s.queueIndex)
  const contextTitle = usePlayer((s) => s.contextTitle)
  const playTrackAt = usePlayer((s) => s.playTrackAt)
  const removeFromQueue = usePlayer((s) => s.removeFromQueue)
  const reorderQueue = usePlayer((s) => s.reorderQueue)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const current = queue[queueIndex]
  const upcoming = queue.slice(queueIndex + 1)
  const upcomingIds = upcoming.map((t, i) => t.videoId + '-' + (queueIndex + 1 + i))
  // KILL SWITCH (plan §10.4): explanations off → hide the now-playing reason
  // badge too (read per render; no extra state).
  const showReasonBadge = !!current?.__rec && !surfaceFlags().noReasons

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const fromIdx = upcomingIds.indexOf(String(active.id))
    const toIdx = upcomingIds.indexOf(String(over.id))
    if (fromIdx < 0 || toIdx < 0) return
    // map upcoming indices back to absolute queue indices
    reorderQueue(queueIndex + 1 + fromIdx, queueIndex + 1 + toIdx)
  }

  return (
    <div className="w-full bg-black/40 rounded-lg overflow-hidden flex flex-col max-h-full">
      <div className="px-4 py-3 border-b border-white/10 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-white/50">
            Next from
          </div>
          <div className="text-sm font-semibold text-white truncate">
            {contextTitle || 'Your queue'}
          </div>
        </div>
        <div className="text-[10px] text-white/30 text-right shrink-0 pt-0.5 hidden md:block">
          Drag ⋮ to reorder · tap to play
        </div>
        <div className="text-[10px] text-white/30 text-right shrink-0 pt-0.5 md:hidden">
          Swipe left to remove
        </div>
      </div>

      <div className="overflow-y-auto flex-1 min-h-0 hide-scrollbar">
        {/* now playing — pinned at top, not reorderable/removable */}
        {current && (
          <div className="px-4 pt-3 pb-1">
            <div className="text-[11px] uppercase tracking-wider text-[#1ed760]/80 mb-1.5">
              Now playing
            </div>
            <div className="flex items-center gap-3 p-1 rounded">
              { }
              <img
                src={current.thumbnail?.replace('w120-h120', 'w60-h60').replace(/=w\d+-h\d+/, '=w48-h48') || '/icon.svg'}
                alt=""
                className="w-10 h-10 rounded object-cover shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white truncate font-medium flex items-center gap-1.5">
                  <span className="truncate">{current.title}</span>
                  {showReasonBadge && (
                    <span title={current.__reason || 'Smart shuffle pick'} className="shrink-0 inline-flex">
                      <Sparkles size={12} className="text-[#1ed760]" aria-label="Smart shuffle pick" />
                    </span>
                  )}
                </div>
                <div className="text-xs text-white/60 truncate">{current.artistName}</div>
              </div>
              <span className="shrink-0 flex items-end gap-[2px] h-3.5 pr-1" aria-label="Now playing">
                <i className="tsf-eq-bar w-[3px] h-2" />
                <i className="tsf-eq-bar w-[3px] h-3.5 tsf-eq-2" />
                <i className="tsf-eq-bar w-[3px] h-2.5 tsf-eq-3" />
              </span>
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

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={upcomingIds} strategy={verticalListSortingStrategy}>
            <div className="pb-2">
              {upcoming.map((t, i) => {
                const realIdx = queueIndex + 1 + i
                return (
                  <SortableRow
                    key={t.videoId + '-' + realIdx}
                    track={t}
                    realIdx={realIdx}
                    onPlay={playTrackAt}
                    onRemove={removeFromQueue}
                  />
                )
              })}
            </div>
          </SortableContext>
        </DndContext>

        {upcoming.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-white/40 flex flex-col items-center gap-2">
            <Music4 size={18} className="text-white/25" />
            Nothing else queued. Pick something to play.
          </div>
        )}
      </div>
    </div>
  )
}
