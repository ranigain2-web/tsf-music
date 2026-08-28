'use client'

/**
 * TSF Music — Top bar
 * Back/forward, view title or search input, offline indicator.
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Search, X, WifiOff } from 'lucide-react'
import { useNav } from '@/store/nav'

export function TopBar() {
  const view = useNav((s) => s.view)
  const pop = useNav((s) => s.pop)
  const stack = useNav((s) => s.stack)
  const push = useNav((s) => s.push)
  const [scrolled, setScrolled] = useState(false)
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // scroll detection for the bar's background fade
  useEffect(() => {
    const main = document.querySelector('main .overflow-y-auto') as HTMLElement | null
    if (!main) return
    const onScroll = () => setScrolled(main.scrollTop > 64)
    main.addEventListener('scroll', onScroll, { passive: true })
    return () => main.removeEventListener('scroll', onScroll)
  }, [view])

  useEffect(() => {
    if (view.type === 'search' && view.q) setQ(view.q)
    if (view.type === 'search') inputRef.current?.focus()
  }, [view])

  const canBack = stack.length > 1

  return (
    <header
      className={`shrink-0 h-16 flex items-center gap-4 px-4 lg:px-6 transition-colors duration-200 ${
        scrolled ? 'tsf-glass' : 'bg-transparent'
      }`}
    >
      {/* back / forward — desktop (Spotify's 32px black circular buttons) */}
      <div className="hidden lg:flex items-center gap-2">
        <button
          onClick={pop}
          disabled={!canBack}
          className={`w-8 h-8 rounded-full bg-black/70 flex items-center justify-center transition-all duration-150 ${
            canBack ? 'text-white hover:bg-black hover:scale-105 active:scale-95' : 'text-white/30 cursor-not-allowed'
          }`}
          aria-label="Go back"
        >
          <ChevronLeft size={18} />
        </button>
        <button
          className="w-8 h-8 rounded-full bg-black/70 flex items-center justify-center text-white/30 cursor-not-allowed"
          aria-label="Forward"
          disabled
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {/* back — mobile (single chevron; iOS PWA has no hardware back) */}
      {canBack && (
        <button
          onClick={pop}
          className="lg:hidden w-9 h-9 -ml-1 flex items-center justify-center text-white active:scale-90 transition-transform"
          aria-label="Go back"
        >
          <ChevronLeft size={24} />
        </button>
      )}

      {/* search input (search view) — desktop only; SearchView renders its
          own mobile field (two stacked inputs looked broken at 390px) */}
      {view.type === 'search' ? (
        <div className="hidden lg:block flex-1 max-w-[420px] relative">
          <Search size={20} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#b3b3b3] pointer-events-none" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && q.trim()) {
                push({ type: 'search', q: q.trim() })
              }
            }}
            placeholder="What do you want to listen to?"
            className="w-full h-12 rounded-full bg-[#242424] text-white placeholder:text-[#b3b3b3] pl-11 pr-10 text-sm font-medium outline-none focus:ring-1 focus:ring-white hover:ring-1 hover:ring-white/60 transition-shadow"
          />
          {q && (
            <button
              onClick={() => {
                setQ('')
                inputRef.current?.focus()
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#b3b3b3] hover:text-white"
              aria-label="Clear search"
            >
              <X size={18} />
            </button>
          )}
        </div>
      ) : (
        <div className="flex-1" />
      )}

      <div className="flex items-center gap-2 ml-auto">
        {/* offline badge is rendered per-view when data falls back */}
        <span className="text-[11px] font-bold uppercase tracking-wider text-[#b3b3b3] hidden sm:block select-none">TSF Music</span>
      </div>
    </header>
  )
}

export { WifiOff }
