'use client'

import { useState } from 'react'
import { usePreferences } from '@/store/preferences'
import { StepFooter } from './StepFooter'

/**
 * NameStep — single text input.
 *
 * Spotify-signup-pattern:
 *   - Centered column, max-w-md
 *   - Bold "What's your name?" headline
 *   - Subtitle "So we know what to call you." (muted)
 *   - Full-width text input — black bg, white text, white/10 border that
 *     turns GREEN on focus
 *   - Large rounded green primary CTA in footer (disabled if empty)
 */

export function NameStep({ onNext, onPrev }: { onNext: () => void; onPrev: () => void }) {
  const name = usePreferences((s) => s.name)
  const setName = usePreferences((s) => s.setName)
  // Lazy-initialize local state from the store once; no re-sync after that
  // (we own local edits, store syncs on blur / Enter).
  const [local, setLocal] = useState<string>(() => name || '')
  const [focused, setFocused] = useState(false)

  function commit() {
    const trimmed = local.trim()
    setName(trimmed)
    usePreferences.getState().save().catch(() => {})
  }

  return (
    <div className="min-h-full flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-md space-y-6">
          <div className="space-y-2">
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
              What's your name?
            </h1>
            <p className="text-white/55 text-sm">
              We'll use it to greet you on the home screen and in your "Made For You" mixes.
            </p>
          </div>

          <div className="space-y-2">
            <input
              type="text"
              autoFocus
              value={local}
              onChange={(e) => setLocal(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => { setFocused(false); commit() }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && local.trim()) { commit(); onNext() }
              }}
              placeholder="Your name"
              className="w-full px-4 py-3.5 rounded-md bg-[#1a1a1a] border text-white text-base placeholder-white/30 outline-none transition-colors"
              style={{ borderColor: focused ? '#1ed760' : 'rgba(255,255,255,0.12)' }}
              maxLength={60}
            />
            <p className="text-white/30 text-xs">First name only is fine. {local.length}/60</p>
          </div>
        </div>
      </div>

      <StepFooter
        onPrev={onPrev}
        onNext={() => { commit(); onNext() }}
        nextLabel="Continue"
        nextDisabled={!local.trim()}
        nextVariant="primary"
      />
    </div>
  )
}
