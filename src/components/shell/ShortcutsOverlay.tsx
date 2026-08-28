'use client'

/**
 * TSF Music — Keyboard shortcuts overlay
 *
 * Opens with the `?` key anywhere in the app (also Shift+/). Shows every
 * player + navigation shortcut in a Spotify-styled two-column grid.
 */

import { useEffect, useState } from 'react'
import { Command } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: 'Playback',
    items: [
      { keys: ['Space'], label: 'Play / Pause' },
      { keys: ['Shift', '→'], label: 'Next track' },
      { keys: ['Shift', '←'], label: 'Previous track' },
      { keys: ['→'], label: 'Seek forward 5s' },
      { keys: ['←'], label: 'Seek back 5s' },
    ],
  },
  {
    title: 'Volume & Panels',
    items: [
      { keys: ['↑'], label: 'Volume up 5%' },
      { keys: ['↓'], label: 'Volume down 5%' },
      { keys: ['M'], label: 'Mute / unmute' },
      { keys: ['?'], label: 'Show this overlay' },
      { keys: ['Esc'], label: 'Close overlays' },
    ],
  },
]

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.75rem] h-7 items-center justify-center rounded-md border border-white/15 bg-white/8 px-1.5 font-mono text-[11px] font-semibold text-white/85 shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_2px_4px_rgba(0,0,0,0.5)]">
      {children}
    </kbd>
  )
}

export function ShortcutsOverlay() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing =
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (typing) return
      if (e.key === '?') {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent aria-describedby={undefined} className="max-w-[440px] gap-0 rounded-2xl border-white/10 bg-[#181818] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2.5 text-lg font-bold tracking-tight">
            <span className="grid size-8 place-items-center rounded-lg bg-[#1ed760]/15 text-[#1ed760]">
              <Command size={16} />
            </span>
            Keyboard shortcuts
          </DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-6 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#1ed760] mb-2.5">
                {g.title}
              </h3>
              <ul className="space-y-2">
                {g.items.map((it) => (
                  <li key={it.label} className="flex items-center justify-between gap-3">
                    <span className="text-[13px] text-white/70">{it.label}</span>
                    <span className="flex items-center gap-1">
                      {it.keys.map((k) => (
                        <Key key={k}>{k}</Key>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="border-t border-white/8 px-6 py-3 text-[11px] text-white/35">
          Tip: on touch devices, double-tap rows to play — shortcuts are desktop-only.
        </div>
      </DialogContent>
    </Dialog>
  )
}
