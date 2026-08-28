'use client'

import { useState } from 'react'
import { usePreferences } from '@/store/preferences'
import { StepFooter } from './StepFooter'

/**
 * BioStep — textarea for "Tell us about yourself".
 *
 * Spotify-pattern (mirrors their "what should we call you?" extended-form step):
 *   - Same column layout as NameStep
 *   - Headline "Tell us about yourself"
 *   - Subtitle: "What you like, what you do, anything. The more we know, the better your mixes."
 *   - Auto-resizing textarea (8 rows) with dark bg + green focus border
 *   - Optional — can skip (Next is always enabled)
 */

export function BioStep({ onNext, onPrev }: { onNext: () => void; onPrev: () => void }) {
  const bio = usePreferences((s) => s.bio)
  const setBio = usePreferences((s) => s.setBio)
  const [local, setLocal] = useState<string>(() => bio || '')
  const [focused, setFocused] = useState(false)

  function commit() {
    setBio(local.trim())
    usePreferences.getState().save().catch(() => {})
  }

  return (
    <div className="min-h-full flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-md space-y-6">
          <div className="space-y-2">
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
              Tell us about yourself
            </h1>
            <p className="text-white/55 text-sm">
              What you like, what you do, anything. The more we know, the smarter
              your mixes get.
            </p>
          </div>

          <div className="space-y-2">
            <textarea
              autoFocus
              value={local}
              onChange={(e) => setLocal(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => { setFocused(false); commit() }}
              placeholder="e.g. I love lo-fi beats while I code and old soul on Sunday mornings."
              rows={5}
              maxLength={500}
              className="w-full px-4 py-3 rounded-md bg-[#1a1a1a] border text-white text-base placeholder-white/30 outline-none transition-colors resize-none"
              style={{ borderColor: focused ? '#1ed760' : 'rgba(255,255,255,0.12)' }}
            />
            <p className="text-white/30 text-xs">Optional · {local.length}/500</p>
          </div>

          <p className="text-white/35 text-xs">
            We store this locally on your device only — no account, no cloud, no email.
          </p>
        </div>
      </div>

      <StepFooter
        onPrev={onPrev}
        onNext={() => { commit(); onNext() }}
        nextLabel={local.trim() ? 'Continue' : 'Skip'}
        nextDisabled={false}
        nextVariant="primary"
      />
    </div>
  )
}
