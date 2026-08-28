'use client'

/**
 * Shared sticky footer for onboarding steps.
 *
 * Spotify-pattern: bottom-anchored bar with:
 *   - back chevron (left)
 *   - primary green Next button (right, disabled state until ready)
 *   - subtle top border + dark blur backdrop
 */

import { ButtonHTMLAttributes } from 'react'

interface StepFooterProps {
  onPrev: () => void
  onNext: () => void
  nextLabel: string
  nextDisabled?: boolean
  nextVariant?: 'primary' | 'secondary'
  hint?: string
}

export function StepFooter({
  onPrev,
  onNext,
  nextLabel,
  nextDisabled = false,
  nextVariant = 'primary',
  hint,
}: StepFooterProps) {
  return (
    <footer className="sticky bottom-0 left-0 right-0 z-20 border-t border-white/5 bg-black/80 backdrop-blur-md">
      <div className="max-w-5xl mx-auto px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] flex items-center gap-4">
        <button
          onClick={onPrev}
          className="text-white/60 hover:text-white text-sm font-bold uppercase tracking-wider transition-colors px-2 py-1"
          aria-label="Back"
        >
          ← Back
        </button>

        {hint && <span className="text-white/40 text-sm">{hint}</span>}

        <button
          onClick={onNext}
          disabled={nextDisabled}
          className={[
            'ml-auto inline-flex items-center justify-center px-8 py-3 rounded-full font-bold text-sm transition-all',
            nextVariant === 'primary'
              ? (nextDisabled
                  ? 'bg-white/10 text-white/30 cursor-not-allowed'
                  : 'bg-[#1ed760] hover:bg-[#1fdf64] hover:scale-[1.03] active:scale-[0.97] text-black shadow-lg shadow-[#1ed760]/20')
              : (nextDisabled
                  ? 'bg-white/10 text-white/30 cursor-not-allowed'
                  : 'bg-white/10 hover:bg-white/20 text-white')
          ].join(' ')}
        >
          {nextLabel}
        </button>
      </div>
    </footer>
  )
}

export type { StepFooterProps }
