'use client'

/**
 * Welcome — Spotify-signup-onboarding hero.
 *
 * Matched to Spotify's actual signup hero (not their marketing home):
 *   - Pure black background, no decorative gradient
 *   - One central brand mark (Spotify uses solid green circle, no gradient)
 *   - Bold tight-tracked headline + small muted subtitle
 *   - Single solid-green rounded CTA
 *   - Subtle one-line fine print
 *
 * Brand color: Spotify green #1DB954 (used as solid fill, not gradient).
 */

export function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="relative min-h-full flex flex-col items-center justify-center px-6 py-16 overflow-hidden bg-black">
      {/* Very subtle top wash — Spotify does this on their signup hero */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-1/2 pointer-events-none"
        style={{
          background: 'linear-gradient(180deg, rgba(29,185,84,0.06) 0%, rgba(0,0,0,0) 100%)',
        }}
      />

      <div className="relative z-10 w-full max-w-lg mx-auto text-center flex flex-col items-center gap-10">
        {/* Brand mark — SOLID green rounded square, no gradient, no glow */}
        <div className="w-40 h-40 rounded-[40px] bg-[#1DB954] flex items-center justify-center shadow-[0_8px_30px_-8px_rgba(29,185,84,0.4)]">
          <svg width="92" height="92" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <circle cx="12" cy="12" r="3" fill="black"/>
          </svg>
        </div>

        <div className="space-y-3 w-full">
          <h1 className="text-5xl sm:text-6xl md:text-7xl font-black tracking-[-0.04em] text-white leading-[0.92]">
            Welcome to <span className="text-[#1DB954]">TSF Music</span>
          </h1>
          <p className="text-white/60 text-base sm:text-lg max-w-md mx-auto font-medium leading-snug">
            Endless tracks. No login. We learn your taste and play what you love —
            just like Spotify, but yours alone.
          </p>
        </div>

        <button
          onClick={onNext}
          className="inline-flex items-center justify-center rounded-full bg-[#1DB954] hover:bg-[#1ed760] hover:scale-[1.05] active:scale-[0.98] transition-all text-black font-bold text-base tracking-wide"
          style={{ paddingLeft: '56px', paddingRight: '56px', paddingTop: '16px', paddingBottom: '16px' }}
        >
          Get started
        </button>

        <p className="text-white/35 text-sm">Takes 30 seconds · No account · No email</p>
      </div>
    </div>
  )
}
