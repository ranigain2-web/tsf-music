'use client'

import { usePreferences } from '@/store/preferences'

/**
 * SummaryStep — final review screen before completing onboarding.
 *
 * Spotify-pattern: shows a "Here's what we know about you" card with the
 * collected data and a giant green Finish button.
 */

import { StepFooter } from './StepFooter'

export function SummaryStep({ onFinish, onPrev }: { onFinish: () => void; onPrev: () => void }) {
  const { name, bio, artists, genres } = usePreferences()

  return (
    <div className="min-h-full flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 max-w-2xl mx-auto w-full">
        <div className="text-center space-y-2 mb-10">
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
            You're all set{name ? `, ${name}` : ''}.
          </h1>
          <p className="text-white/55 text-sm">
            Here's what we know about you. We'll use this to seed your home and your Daily Mixes.
          </p>
        </div>

        <div className="w-full space-y-3">
          {name && <Field label="Your name" value={name} />}
          {bio && <Field label="About you" value={bio} multiline />}

          <Field
            label="Your artists"
            value={
              artists.length === 0
                ? 'No artists selected yet.'
                : artists.slice(0, 12).map((a) => a.name).join(' · ') + (artists.length > 12 ? ` + ${artists.length - 12} more` : '')
            }
            chips={artists.length > 0 ? artists.slice(0, 8).map((a) => ({ label: a.name, thumbnail: a.thumbnail })) : undefined}
          />

          <Field
            label="Your genres"
            value={
              genres.length === 0
                ? 'No genres selected yet.'
                : genres.join(' · ')
            }
            chips={genres.length > 0 ? genres.slice(0, 12).map((g) => ({ label: g })) : undefined}
          />
        </div>

        <p className="text-white/30 text-xs mt-8 text-center max-w-md">
          Tap Finish to start exploring. You can edit any of this later from Settings.
        </p>
      </div>

      <StepFooter
        onPrev={onPrev}
        onNext={onFinish}
        nextLabel="Finish"
        nextDisabled={false}
        nextVariant="primary"
      />
    </div>
  )
}

function Field({ label, value, multiline, chips }: {
  label: string
  value: string
  multiline?: boolean
  chips?: { label: string; thumbnail?: string }[]
}) {
  return (
    <div className="rounded-md bg-[#181818] border border-white/5 p-4">
      <div className="text-white/40 text-[11px] uppercase tracking-[0.15em] font-bold mb-1.5">
        {label}
      </div>
      {chips && chips.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {chips.map((c) => (
            <span key={c.label} className="inline-flex items-center gap-1.5 bg-white/5 rounded-full pl-1 pr-2.5 py-0.5">
              {c.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.thumbnail} alt="" className="w-5 h-5 rounded-full object-cover" referrerPolicy="no-referrer" />
              ) : null}
              <span className="text-white text-xs font-medium">{c.label}</span>
            </span>
          ))}
        </div>
      ) : (
        <div className={`text-white ${multiline ? 'whitespace-pre-wrap' : 'truncate'} text-sm`}>
          {value}
        </div>
      )}
    </div>
  )
}
