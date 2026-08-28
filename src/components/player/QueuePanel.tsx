'use client'

/**
 * TSF Music — Queue panel (Phase 3 + reorder)
 *
 * Lists the currently-playing track + upcoming tracks. Click an item to play
 * it now, hover shows remove (×). Upcoming tracks are drag-reorderable via
 * dnd-kit (the playing track is pinned at top). Header shows context.
 */

import { X, GripVertical, Play } from 'lucide-react'
import { usePlayer, type PlayerTrack } from '@/store/player'
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
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

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
      className={`group flex items-center gap-3 px-4 py-2 rounded cursor-pointer touch-none ${
        isDragging ? 'bg-white/10 shadow-lg shadow-black/60' : 'hover:bg-white/5'
      }`}
      onClick={() => onPlay(realIdx)}
      {...attributes}
    >
      <button
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className="text-white/30 hover:text-white/70 shrink-0 p-0.5 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label="Reorder track"
        title="Drag to reorder"
      >
        <GripVertical size={14} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={track.thumbnail?.replace('w120-h120', 'w60-h60').replace(/=w\d+-h\d+/, '=w40-h40') || '/icon.svg'}
        alt=""
        className="w-10 h-10 rounded object-cover shrink-0 pointer-events-none"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-white truncate">{track.title}</div>
        <div className="text-xs text-white/60 truncate">{track.artistName}</div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onRemove(realIdx)
        }}
        className="text-white/40 hover:text-white opacity-0 group-hover:opacity-100 shrink-0 p-1"
        aria-label="Remove from queue"
        title="Remove"
      >
        <X size={14} />
      </button>
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
            <div className="text-[10px] text-white/30 mb-1">Drag ⋮ to reorder · tap to play</div>
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
          <div className="px-4 py-6 text-center text-xs text-white/40">
            Nothing else queued. Pick something to play.
          </div>
        )}
      </div>
    </div>
  )
}
