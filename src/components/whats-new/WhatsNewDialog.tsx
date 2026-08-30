'use client'

/**
 * WHAT'S NEW dialog (reference repo v3.2 pattern) — shows once per version,
 * reopenable from the sidebar version badge. Spotify-clean: dark surface,
 * emerald accents, honest changelog copy from the closed WHATS_NEW list.
 */

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Sparkles } from 'lucide-react'
import { APP_VERSION, WHATS_NEW } from './whats-new'

const SEEN_KEY = 'tsf-whats-new-seen'

export function useWhatsNewOpen() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    try {
      const seen = localStorage.getItem(SEEN_KEY)
      if (seen !== APP_VERSION) setOpen(true)
    } catch {
      /* private mode — never block */
    }
  }, [])

  const dismiss = () => {
    try {
      localStorage.setItem(SEEN_KEY, APP_VERSION)
    } catch {
      /* ignore */
    }
    setOpen(false)
  }

  return { open, dismiss, reopen: () => setOpen(true) }
}

export function WhatsNewDialog({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  // Only the entries newer than the previously seen version, newest first.
  const [prevSeen, setPrevSeen] = useState<string | null>(null)
  useEffect(() => {
    try {
      setPrevSeen(localStorage.getItem(SEEN_KEY))
    } catch {
      setPrevSeen(null)
    }
  }, [])

  if (!open) return null
  const entries = WHATS_NEW.filter((e) => !prevSeen || e.version > prevSeen)
  const shown = entries.length ? entries : [WHATS_NEW[0]]

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onDismiss()}>
      <DialogContent className="bg-[#181818] border-white/[0.06] max-w-md p-0 overflow-hidden">
        <div className="relative px-6 pt-6 pb-5">
          <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-[#1ed760]/15 to-transparent pointer-events-none" />
          <DialogHeader className="relative text-left space-y-1.5">
            <div className="flex items-center gap-2 text-[#1ed760]">
              <Sparkles className="h-4 w-4" />
              <span className="text-xs font-bold uppercase tracking-widest">
                What&apos;s new
              </span>
            </div>
            <DialogTitle className="text-xl font-bold text-white">
              {shown[0].title}
            </DialogTitle>
            <DialogDescription className="text-[13px] text-[#a7a7a7]">
              Version {shown[0].version} · {shown.length > 1 ? `${shown.length} updates` : shown[0].date}
            </DialogDescription>
          </DialogHeader>

          <div className="relative mt-4 space-y-5 max-h-[50vh] overflow-y-auto pr-1 thin-scrollbar">
            {shown.map((entry) => (
              <div key={entry.version}>
                {shown.length > 1 && (
                  <div className="text-[11px] font-bold uppercase tracking-widest text-[#a7a7a7] mb-2">
                    v{entry.version}
                  </div>
                )}
                <ul className="space-y-2.5">
                  {entry.items.map((item, i) => (
                    <li key={i} className="flex gap-2.5 text-[13px] leading-snug text-white/90">
                      <span className="mt-[7px] h-1.5 w-1.5 rounded-full bg-[#1ed760] shrink-0" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <button
            onClick={onDismiss}
            className="relative mt-5 w-full rounded-full bg-[#1ed760] px-6 py-3 text-sm font-bold text-black transition-transform hover:scale-[1.02] active:scale-[0.99]"
          >
            Continue listening
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
