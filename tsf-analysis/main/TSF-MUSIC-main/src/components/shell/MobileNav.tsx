'use client'

/**
 * TSF Music — Mobile bottom navigation
 * Home / Search / Your Library, shown below lg breakpoint. Mini-player
 * (NowPlayingBar compact mode) sits above it.
 */

import { Home, Search, Library } from 'lucide-react'
import { useNav } from '@/store/nav'

export function MobileNav() {
  const view = useNav((s) => s.view)
  const push = useNav((s) => s.push)

  const items = [
    { type: 'home' as const, label: 'Home', icon: Home },
    { type: 'search' as const, label: 'Search', icon: Search },
    { type: 'library' as const, label: 'Your Library', icon: Library },
  ]

  return (
    <nav
      className="lg:hidden shrink-0 h-14 bg-black border-t border-white/5 flex items-center justify-around px-2 pb-[env(safe-area-inset-bottom)]"
      aria-label="Main navigation"
    >
      {items.map(({ type, label, icon: Icon }) => {
        const active = view.type === type || (type === 'library' && ['library', 'playlist', 'liked'].includes(view.type))
        return (
          <button
            key={type}
            onClick={() => {
              if (view.type !== type) push({ type })
            }}
            className={`flex flex-col items-center gap-1 px-5 py-1.5 min-w-[72px] rounded-md transition-colors ${
              active ? 'text-white' : 'text-[#8f8f8f] hover:text-white'
            }`}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={23} strokeWidth={active ? 2.6 : 1.9} />
            <span className={`text-[10px] ${active ? 'font-bold' : 'font-medium'}`}>{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
