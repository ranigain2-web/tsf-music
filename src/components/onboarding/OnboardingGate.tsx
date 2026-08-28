'use client'

import { useEffect, useState } from 'react'
import { AppShell } from '@/components/shell/AppShell'
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow'
import { usePreferences } from '@/store/preferences'

/**
 * OnboardingGate
 *   First-launch gate: shows onboarding flow until /api/onboarding returns
 *   complete=true, then shows the main AppShell.
 *
 *   While prefs are still loading we show a small splash (black with the
 *   TSF mark) so the screen is not empty.
 */

export function OnboardingGate() {
  const { loaded, complete, load, complete_ } = usePreferences()
  const [finishing, setFinishing] = useState(false)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  async function handleFinish() {
    setFinishing(true)
    try {
      await complete_()
    } finally {
      setFinishing(false)
    }
  }

  if (!loaded) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#1ed760] to-[#1aa548] flex items-center justify-center animate-pulse">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <circle cx="12" cy="12" r="3" fill="black"/>
          </svg>
        </div>
      </div>
    )
  }

  if (!complete || finishing) {
    return <OnboardingFlow onComplete={handleFinish} />
  }

  return <AppShell />
}
