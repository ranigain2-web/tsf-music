'use client'

/**
 * TSF Music — AI Playlist Generator (five-stage pipeline client)
 *
 * Consumes the SSE stream from /api/ai/playlist-generator and renders tracks
 * the moment they resolve — no dead spinner. The v2 pipeline reports its
 * stages (understand → hunt → curate → polish → narrate) and each is mapped
 * to a human line; per-track `reason` lines render under every row (the
 * S3 curator explains each pick in ≤8 words).
 *
 * `polish` is special: the deterministic polisher may re-order / correct the
 * sequence, so the server re-emits the corrected order right after that
 * phase — the client clears what it has and re-renders.
 *
 * S1.5 CLARIFY (15-d): a vague prompt (intentConfidence < 0.4) streams ONE
 * {type:'clarify'} event — a question with 2-3 tappable option chips, each
 * carrying a concrete intent patch. Rendered INLINE in the staged progress
 * view (never a modal/form). "Just pick for me" proceeds without a patch;
 * ignoring the question for 12s auto-proceeds — the pipeline never stalls.
 *
 * Regenerate (15-d): the result view carries a ghost RefreshCw button that
 * re-POSTs with variantIndex+1 + previousIds (the take's ids) — the server
 * enforces ≥40% new tracks. Three takes max per prompt.
 *
 * Save to Library (15-d): BookmarkPlus saves the take via the library store
 * (idempotent — the pipeline already persisted the row) and fires the
 * PLAYLIST_SAVE_AI ledger event exactly once per successful save.
 *
 * Purity (Bar 2): the only branding in this surface is "TSF AI".
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Sparkles, Loader2, Wand2, Music2, CheckCircle2, RefreshCw, BookmarkPlus,
  BookmarkCheck, MessageCircleQuestion,
} from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNav } from '@/store/nav'
import { useLibrary } from '@/store/library'
import { aiRegenerate, playlistSaveAi } from '@/lib/mindbeat/client'

interface Track {
  videoId: string
  title: string
  artistName: string
  artistId?: string
  albumName?: string
  thumbnail?: string
  duration?: number
  reason?: string
}

interface DoneEvent {
  playlistId: string
  title: string
  total: number
  ms?: number
}

/** SSE {type:'clarify'} event — question + tappable concrete-patch options. */
interface ClarifyState {
  promptHash: string
  question: string
  options: { label: string; patch: Record<string, unknown> }[]
}

interface GenerateOpts {
  /** re-take index (1-based when > 0) + the previous take's ids for divergence */
  variantIndex?: number
  previousIds?: string[]
  /** clarification round-trip: echoes the promptHash + the tapped patch */
  clarify?: { promptHash: string; optionIndex: number; patch?: Record<string, unknown> }
}

const SUGGESTIONS = [
  'songs to dance to at a beach party at sunset',
  'heartbreak songs that feel like rain',
  'epic workouts that make me feel invincible',
  'chill lo-fi for late-night coding',
  '90s nostalgia bangers',
  'bollywood romantic evening',
  'focus flow for deep work, no vocals',
  'road trip across the desert',
]

/** v2 pipeline phases → human lines (v1 phase names kept as fallbacks). */
const PHASE_LABELS: Record<string, string> = {
  understand: 'Reading your taste…',
  hunt: 'Hunting real tracks…',
  curate: 'Curating the arc…',
  diverge: 'Re-mixing a fresh take…',
  polish: 'Polishing the flow…',
  narrate: 'Naming it…',
  // v1 fallbacks (older cached streams, etc.)
  understanding: 'Reading your taste…',
  curating: 'Curating the arc…',
  filling: 'Hunting real tracks…',
  replayed: 'Back by demand — replaying…',
}

const FALLBACK_HINTS = [
  'Reading your vibe…',
  'Digging through the crates…',
  'Lining up the perfect openers…',
  'Checking the transitions…',
  'Tuning the flow…',
  'Finding a few hidden gems…',
]

const CLARIFY_AUTOPROCEED_MS = 12_000 // ignored question → best-guess proceed
const VARIANT_MAX = 3 // total takes per prompt (take 1 = the original)

function fmtMs(ms?: number): string {
  if (!ms) return ''
  return `${(ms / 1000).toFixed(1)}s`
}

/** djb2 — tiny stable prompt hash for the MINDBEAT ledger events. */
function promptHash(p: string): string {
  let h = 5381
  for (let i = 0; i < p.length; i++) h = ((h << 5) + h + p.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export function AiPlaylistGenerator({
  open,
  onOpenChange,
  initialPrompt,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** Seed the prompt when opened pre-filled (e.g. Vibe Search → "Playlist this vibe"). */
  initialPrompt?: string
}) {
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [meta, setMeta] = useState<{ title: string; description: string } | null>(null)
  const [done, setDone] = useState<DoneEvent | null>(null)
  const [phaseLabel, setPhaseLabel] = useState<string | null>(null)
  const [hintIdx, setHintIdx] = useState(0)
  const [wantCount, setWantCount] = useState(25)
  const [variantIndex, setVariantIndex] = useState(0) // the take on screen (0-based)
  const [clarify, setClarify] = useState<ClarifyState | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** the answered clarification — rides on re-takes so the patched intent carries over */
  const lastClarifyRef = useRef<{ promptHash: string; optionIndex: number; patch?: Record<string, unknown> } | null>(null)
  const push = useNav((s) => s.push)
  const refreshLibrary = useLibrary((s) => s.refresh)
  const savePlaylist = useLibrary((s) => s.savePlaylist)

  // pre-fill support (Vibe Search hands its query over)
  useEffect(() => {
    if (open && initialPrompt) setPrompt(initialPrompt)
  }, [open, initialPrompt])

  // rotate the humanized status copy only while no stage label is streaming
  useEffect(() => {
    if (!loading || done || phaseLabel || clarify) return
    const t = setInterval(() => setHintIdx((i) => (i + 1) % FALLBACK_HINTS.length), 2200)
    return () => clearInterval(t)
  }, [loading, done, phaseLabel, clarify])

  // keep the growing list pinned to the newest entries
  useEffect(() => {
    const el = listRef.current
    if (el && loading) el.scrollTop = el.scrollHeight
  }, [tracks.length, loading])

  const generate = useCallback(async (p: string, opts?: GenerateOpts) => {
    if (!p.trim()) return
    setLoading(true)
    setError(null)
    setTracks([])
    setMeta(null)
    setDone(null)
    setPhaseLabel(null)
    setHintIdx(0)
    setClarify(null)
    setSaveState('idle')
    setVariantIndex(opts?.variantIndex ?? 0)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await fetch('/api/ai/playlist-generator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: p.trim(),
          count: wantCount,
          ...(opts?.variantIndex ? { variantIndex: opts.variantIndex } : {}),
          ...(opts?.previousIds?.length ? { previousIds: opts.previousIds } : {}),
          ...(opts?.clarify ? { clarify: opts.clarify } : {}),
        }),
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error || 'Generation failed')
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done: rd, value } = await reader.read()
        if (rd) break
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, nl)
          buf = buf.slice(nl + 2)
          const line = frame.split('\n').find((l) => l.startsWith('data:'))
          if (!line) continue
          let ev: any
          try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
          if (ev.type === 'clarify') {
            // S1.5: one question, tappable options — the stream closes after
            setClarify({
              promptHash: typeof ev.promptHash === 'string' ? ev.promptHash : promptHash(p.trim()),
              question: typeof ev.question === 'string' ? ev.question : 'Help me narrow the vibe?',
              options: Array.isArray(ev.options)
                ? ev.options
                    .filter((o: any) => o && typeof o.label === 'string')
                    .slice(0, 3)
                    .map((o: any) => ({ label: o.label as string, patch: (o.patch ?? {}) as Record<string, unknown> }))
                : [],
            })
          } else if (ev.type === 'meta') {
            setMeta({ title: ev.title || '', description: ev.description || '' })
          } else if (ev.type === 'phase') {
            // `polish` means the deterministic polisher corrected the order —
            // the corrected sequence is re-emitted right after this event.
            if (ev.phase === 'polish') setTracks([])
            setPhaseLabel(PHASE_LABELS[ev.phase] ?? null)
          } else if (ev.type === 'track' && ev.track) {
            setTracks((prev) => [...prev, { ...ev.track, reason: ev.reason }])
          } else if (ev.type === 'error') {
            throw new Error(ev.message || 'Generation failed')
          } else if (ev.type === 'done') {
            setDone({ playlistId: ev.playlistId, title: ev.title, total: ev.total, ms: ev.ms })
            if (typeof ev.variantIndex === 'number') setVariantIndex(ev.variantIndex)
            void refreshLibrary()
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        setError(e?.message || 'Generation failed. Try a different prompt.')
      }
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }, [wantCount, refreshLibrary])

  // 12s safety: an ignored question auto-proceeds with the best guess
  const clarifyProceedRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!clarify) return
    const t = setTimeout(() => clarifyProceedRef.current(), CLARIFY_AUTOPROCEED_MS)
    return () => clearTimeout(t)
  }, [clarify])
  clarifyProceedRef.current = () => {
    if (!clarify) return
    const c = clarify
    lastClarifyRef.current = { promptHash: c.promptHash, optionIndex: -1 }
    setClarify(null)
    void generate(prompt, { clarify: lastClarifyRef.current })
  }

  const answerClarify = (optIndex: number) => {
    if (!clarify) return
    const c = clarify
    const opt = c.options[optIndex]
    lastClarifyRef.current = { promptHash: c.promptHash, optionIndex: optIndex, ...(opt ? { patch: opt.patch } : {}) }
    setClarify(null)
    void generate(prompt, { clarify: lastClarifyRef.current })
  }

  const regenerate = () => {
    const next = variantIndex + 1
    if (!prompt.trim() || next >= VARIANT_MAX || loading) return
    // MINDBEAT: AI_REGENERATE — fires with the take being requested
    aiRegenerate(promptHash(prompt.trim()), next)
    void generate(prompt, {
      variantIndex: next,
      previousIds: tracks.map((t) => t.videoId).filter(Boolean),
      ...(lastClarifyRef.current ? { clarify: lastClarifyRef.current } : {}),
    })
  }

  const saveToLibrary = async () => {
    if (!done || saveState !== 'idle') return
    setSaveState('saving')
    try {
      const pl = await savePlaylist({
        name: done.title || meta?.title || 'AI Playlist',
        description: meta?.description ?? '',
        tracks: tracks.map((t) => ({
          videoId: t.videoId,
          title: t.title,
          artistName: t.artistName,
          artistId: t.artistId,
          albumName: t.albumName,
          duration: t.duration ?? 0,
          thumbnail: t.thumbnail ?? '',
        })),
        source: 'ai',
        existingId: done.playlistId || undefined,
      })
      if (pl) {
        // PLAYLIST_SAVE_AI — exactly once per successful save
        playlistSaveAi(pl.id, promptHash(prompt.trim()))
        setSaveState('saved')
        toast.success('Saved to Your Library')
      } else {
        setSaveState('idle')
        toast.error("Couldn't save — try again")
      }
    } catch {
      setSaveState('idle')
      toast.error("Couldn't save — try again")
    }
  }

  const close = () => {
    abortRef.current?.abort()
    setPrompt('')
    setError(null)
    setTracks([])
    setMeta(null)
    setDone(null)
    setPhaseLabel(null)
    setLoading(false)
    setVariantIndex(0)
    setClarify(null)
    setSaveState('idle')
    lastClarifyRef.current = null
    onOpenChange(false)
  }

  const curating = loading && !done
  const atTakeCap = variantIndex >= VARIANT_MAX - 1

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); else onOpenChange(o) }}>
      <DialogContent className="bg-[#1c1c1c] border border-white/[0.06] text-white max-w-[580px] p-0 overflow-hidden shadow-2xl shadow-black/60">
        <DialogHeader className="p-6 pb-3">
          <DialogTitle className="text-xl font-bold text-white flex items-center gap-2">
            <Wand2 size={18} className="text-[#1ed760]" />
            Create playlist with AI
          </DialogTitle>
          <p className="text-sm text-[#a7a7a7] mt-1">
            Describe a vibe, mood, or theme. We&apos;ll build you a fresh playlist.
          </p>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-4">
          {(!tracks.length && !done && !clarify) && (
            <>
              <div className="relative">
                <textarea
                  autoFocus
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="e.g. 'songs to dance to at a beach party at sunset'"
                  rows={3}
                  maxLength={280}
                  className="w-full bg-[#2a2a2a] rounded-lg px-3 py-3 text-sm outline-none text-white placeholder:text-[#7a7a7a] resize-none border border-transparent focus-visible:border-white/20 focus-visible:ring-0 transition-colors duration-150"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void generate(prompt)
                  }}
                />
                <span className="absolute bottom-2 right-3 text-[10px] text-[#7a7a7a] tabular-nums">
                  {prompt.length}/280
                </span>
              </div>

              <div>
                <p className="text-[11px] uppercase tracking-wide text-[#7a7a7a] mb-2 font-bold">Try</p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setPrompt(s)}
                      className="px-3 h-8 rounded-full bg-white/[0.08] hover:bg-white/[0.16] text-xs text-white transition-colors duration-150 text-left active:scale-95"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2 text-xs text-[#a7a7a7]">
                <span>Size</span>
                {[10, 25, 40].map((n) => (
                  <button
                    key={n}
                    onClick={() => setWantCount(n)}
                    className={`px-2.5 h-7 rounded-full text-xs font-semibold transition-all duration-150 active:scale-95 ${wantCount === n ? 'bg-[#1ed760] text-black' : 'bg-white/[0.08] hover:bg-white/[0.16] text-white'}`}
                  >
                    {n}
                  </button>
                ))}
                <span className="ml-auto">songs</span>
              </div>

              {error && (
                <div className="bg-red-500/15 border border-red-500/30 rounded-lg px-3 py-2 text-sm text-red-200">
                  {error}
                </div>
              )}

              <div className="flex items-center justify-between pt-1">
                <Button variant="ghost" onClick={close} className="text-white hover:bg-white/10">
                  Cancel
                </Button>
                <Button
                  onClick={() => void generate(prompt)}
                  disabled={loading || !prompt.trim()}
                  className="rounded-full bg-[#1ed760] text-black hover:bg-[#3be477] hover:scale-[1.04] active:scale-95 font-bold px-6 transition-all duration-150 disabled:opacity-50 disabled:hover:scale-100"
                >
                  {loading ? (
                    <>
                      <Loader2 size={16} className="animate-spin mr-2" />
                      Curating…
                    </>
                  ) : (
                    <>
                      <Sparkles size={16} className="mr-2" />
                      Generate playlist
                    </>
                  )}
                </Button>
              </div>
            </>
          )}

          {/* S1.5 CLARIFY — one question, tappable chips, inline in the staged view */}
          {clarify && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs text-[#a7a7a7] px-1">
                <Loader2 size={12} className={`text-[#1ed760] ${loading ? 'animate-spin' : ''}`} />
                <span>Good start — one quick question</span>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 space-y-3">
                <p className="text-sm font-semibold text-white flex items-center gap-2">
                  <MessageCircleQuestion size={15} className="text-[#1ed760] shrink-0" />
                  {clarify.question}
                </p>
                <div className="flex flex-wrap gap-2">
                  {clarify.options.map((o, i) => (
                    <button
                      key={o.label}
                      onClick={() => answerClarify(i)}
                      className="px-3.5 h-9 rounded-full border border-white/[0.1] bg-white/[0.06] hover:border-[#1ed760]/70 hover:bg-[#1ed760]/10 hover:text-[#1ed760] text-xs font-semibold text-white transition-all duration-150 active:scale-95"
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-3 pt-1">
                  <button
                    onClick={() => clarifyProceedRef.current()}
                    className="text-xs text-[#a7a7a7] hover:text-white underline-offset-2 hover:underline transition-colors duration-150"
                  >
                    Just pick for me
                  </button>
                  <span className="text-[10px] text-[#7a7a7a] tabular-nums">
                    Auto-picks in {CLARIFY_AUTOPROCEED_MS / 1000}s
                  </span>
                </div>
                <motion.div
                  initial={{ width: '100%' }}
                  animate={{ width: '0%' }}
                  transition={{ duration: CLARIFY_AUTOPROCEED_MS / 1000, ease: 'linear' }}
                  className="h-0.5 rounded-full bg-[#1ed760]/40"
                />
              </div>
            </div>
          )}

          {(tracks.length > 0 || done) && (
            <div className="space-y-4">
              {/* header */}
              <div className="flex gap-4">
                <AnimatePresence>
                  <motion.div
                    key={done ? 'done' : 'live'}
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 28 }}
                    className="w-24 h-24 rounded-md shadow-xl shadow-black/50 overflow-hidden shrink-0"
                  >
                    {tracks[0]?.thumbnail ? (
                      <img src={tracks[0].thumbnail} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-[#1ed760] to-[#0d73ec] flex items-center justify-center">
                        <Sparkles size={32} className="text-black" />
                      </div>
                    )}
                  </motion.div>
                </AnimatePresence>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] uppercase tracking-wide text-[#1ed760] font-bold mb-1 flex items-center gap-1.5">
                    {done ? (
                      <>
                        <CheckCircle2 size={12} />
                        Created{done.ms ? ` in ${fmtMs(done.ms)}` : ''}{variantIndex > 0 ? ` · Take ${variantIndex + 1}` : ''}
                      </>
                    ) : (
                      <>
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#1ed760] opacity-60" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-[#1ed760]" />
                        </span>
                        Curating
                      </>
                    )}
                  </p>
                  <h3 className="text-lg font-bold text-white truncate">
                    {meta?.title || (done?.title ?? '…')}
                  </h3>
                  <p className="text-sm text-[#a7a7a7] line-clamp-2">
                    {meta?.description || 'Building your playlist'}
                  </p>
                  <p className="text-xs text-[#7a7a7a] mt-1 tabular-nums">
                    {done ? `${done.total} songs` : `${tracks.length} found${wantCount ? ` of ${wantCount}` : ''}`}
                  </p>
                </div>
              </div>

              {/* live status line — pipeline stage label, rotating hints as fallback */}
              {curating && (
                <div className="flex items-center gap-2 text-xs text-[#a7a7a7] px-1">
                  <Loader2 size={12} className="animate-spin text-[#1ed760]" />
                  <AnimatePresence mode="wait">
                    <motion.span
                      key={phaseLabel ?? `hint-${hintIdx}`}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.18 }}
                    >
                      {phaseLabel ?? FALLBACK_HINTS[hintIdx]}
                    </motion.span>
                  </AnimatePresence>
                </div>
              )}

              {/* growing track list */}
              <div ref={listRef} className="max-h-[240px] overflow-y-auto -mx-1 px-1 space-y-0.5 tsf-scroll">
                <AnimatePresence initial={false}>
                  {tracks.map((t, i) => (
                    <motion.div
                      key={t.videoId || i}
                      initial={{ opacity: 0, x: -14 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 32 }}
                      className="flex items-center gap-3 py-1.5 px-2 rounded-md hover:bg-white/[0.06] group"
                    >
                      <span className="text-[#7a7a7a] text-xs w-5 text-right tabular-nums">{i + 1}</span>
                      {t.thumbnail ? (
                        <img src={t.thumbnail} alt="" className="w-9 h-9 rounded object-cover shrink-0" loading="lazy" />
                      ) : (
                        <div className="w-9 h-9 rounded bg-white/10 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate group-hover:text-white">{t.title}</div>
                        <div className="text-xs text-[#a7a7a7] truncate">{t.artistName}</div>
                        {t.reason && (
                          <div className="text-[10px] text-[#6a6a6a] truncate italic">{t.reason}</div>
                        )}
                      </div>
                      <Music2 size={12} className="text-[#1ed760] opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
                    </motion.div>
                  ))}
                </AnimatePresence>
                {curating && (
                  <div className="flex items-center gap-3 py-1.5 px-2">
                    <span className="text-[#7a7a7a] text-xs w-5 text-right">·</span>
                    <div className="w-9 h-9 rounded bg-white/[0.05] animate-pulse shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 rounded bg-white/[0.05] animate-pulse w-2/5" />
                      <div className="h-2 rounded bg-white/[0.04] animate-pulse w-1/4" />
                    </div>
                  </div>
                )}
              </div>

              {/* actions */}
              <div className="flex items-center justify-between pt-1">
                {done ? (
                  <>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setTracks([]); setMeta(null); setDone(null); setPhaseLabel(null)
                          setVariantIndex(0); setClarify(null); setSaveState('idle')
                          lastClarifyRef.current = null
                        }}
                        className="text-white hover:bg-white/10"
                      >
                        Make another
                      </Button>
                      {prompt.trim() && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className={atTakeCap ? 'inline-block' : ''}
                              title={atTakeCap ? 'Three takes is the limit — try a new angle' : undefined}
                            >
                              <Button
                                variant="ghost"
                                onClick={regenerate}
                                disabled={atTakeCap}
                                aria-label={atTakeCap ? 'Three takes is the limit — try a new angle' : 'Regenerate — a different take on the same vibe'}
                                className="text-[#a7a7a7] hover:text-white hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
                              >
                                <RefreshCw size={13} className="mr-1.5" />
                                Regenerate
                              </Button>
                            </span>
                          </TooltipTrigger>
                          {atTakeCap && (
                            <TooltipContent side="top">
                              Three takes is the limit — try a new angle
                            </TooltipContent>
                          )}
                        </Tooltip>
                      )}
                      <Button
                        variant="ghost"
                        onClick={() => void saveToLibrary()}
                        disabled={saveState !== 'idle'}
                        className={saveState === 'saved'
                          ? 'text-[#1ed760] hover:text-[#1ed760] hover:bg-transparent'
                          : 'text-[#a7a7a7] hover:text-white hover:bg-white/10'}
                      >
                        {saveState === 'saved' ? (
                          <>
                            <BookmarkCheck size={13} className="mr-1.5" />
                            Saved
                          </>
                        ) : (
                          <>
                            <BookmarkPlus size={13} className="mr-1.5" />
                            {saveState === 'saving' ? 'Saving…' : 'Save'}
                          </>
                        )}
                      </Button>
                    </div>
                    <Button
                      onClick={() => {
                        if (!done.playlistId) return
                        close()
                        push({ type: 'playlist', id: done.playlistId })
                      }}
                      disabled={!done.playlistId}
                      className="rounded-full bg-white text-black hover:scale-[1.04] active:scale-95 font-bold px-6 transition-all duration-150 disabled:opacity-50"
                    >
                      Open playlist
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => abortRef.current?.abort()}
                    className="text-[#a7a7a7] hover:text-white hover:bg-white/10 mx-auto"
                  >
                    Stop
                  </Button>
                )}
              </div>
            </div>
          )}

          {!tracks.length && !done && !clarify && !loading && (
            <p className="text-[11px] text-[#7a7a7a] text-center">
              Powered by TSF AI
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
