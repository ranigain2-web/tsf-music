'use client'

import { useEffect, useState } from 'react'
import { usePreferences } from '@/store/preferences'

/**
 * OnboardingFlow — multi-step wizard that mimics Spotify's signup onboarding:
 * 1. Welcome  (full-bleed hero, green accent, "Welcome to TSF Music")
 * 2. Name     (single text input, Spotify-style green-bordered on focus)
 * 3. Bio      (textarea, "Tell us about yourself")
 * 4. Artists  (THE big one — search + 4-col grid + sticky footer with count)
 * 5. Genres   (pill grid, multi-select)
 * 6. Summary  ("Here's what we know about you" → Finish)
 *
 * Each step persists to the server on change so refreshes don't lose data.
 */

import { Welcome } from './Welcome'
import { NameStep } from './NameStep'
import { BioStep } from './BioStep'
import { ArtistsStep } from './ArtistsStep'
import { GenresStep } from './GenresStep'
import { SummaryStep } from './SummaryStep'

export type Step = 'welcome' | 'name' | 'bio' | 'artists' | 'genres' | 'summary'
const ORDER: Step[] = ['welcome', 'name', 'bio', 'artists', 'genres', 'summary']

export function OnboardingFlow({ onComplete }: { onComplete: () => void }) {
  const prefs = usePreferences()
  const [step, setStep] = useState<Step>('welcome')

  // If we already have completed onboarding in this session, jump back to summary
  // (so refreshes near the end land at the finish line).
  useEffect(() => {
    if (!prefs.loaded) void prefs.load()
  }, [prefs])

  function next() {
    const i = ORDER.indexOf(step)
    if (i < ORDER.length - 1) setStep(ORDER[i + 1])
  }
  function prev() {
    const i = ORDER.indexOf(step)
    if (i > 0) setStep(ORDER[i - 1])
  }

  return (
    <div className="fixed inset-0 z-[100] bg-black text-white flex flex-col">
      {step !== 'welcome' && (
        <OnboardingHeader step={step} onPrev={prev} />
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {step === 'welcome'  && <Welcome onNext={next} />}
        {step === 'name'     && <NameStep onNext={next} onPrev={prev} />}
        {step === 'bio'      && <BioStep onNext={next} onPrev={prev} />}
        {step === 'artists'  && <ArtistsStep onNext={next} onPrev={prev} />}
        {step === 'genres'   && <GenresStep onNext={next} onPrev={prev} />}
        {step === 'summary'  && <SummaryStep onFinish={onComplete} onPrev={prev} />}
      </div>
    </div>
  )
}

function OnboardingHeader({ step, onPrev }: { step: Step; onPrev: () => void }) {
  const stepLabels: Record<Step, string> = {
    welcome: 'Welcome',
    name: 'Step 1 of 4 — Your name',
    bio: 'Step 2 of 4 — About you',
    artists: 'Step 3 of 4 — Your artists',
    genres: 'Step 4 of 4 — Your genres',
    summary: 'Almost done',
  }
  return (
    <header className="flex items-center gap-4 px-6 py-4 border-b border-white/5">
      <button
        onClick={onPrev}
        className="text-white/70 hover:text-white text-sm font-medium transition-colors flex items-center gap-1"
        aria-label="Go back"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        Back
      </button>
      <div className="text-white/40 text-xs uppercase tracking-[0.2em] font-semibold">
        {stepLabels[step]}
      </div>
      <div className="ml-auto">
        <span className="text-white/30 text-xs font-medium">TSF Music</span>
      </div>
    </header>
  )
}
