/**
 * MINDBEAT v2.0 — Proxy Feature Space ("Sonic Signal Synthesis") — L2/L3.
 *
 * YouTube's catalog carries no audio-analysis attributes, so MINDBEAT
 * synthesizes them in two layers:
 *
 *   1. METADATA HEURISTICS (instant, confidence LOW) — keyword rules over
 *      title/album (plan §6.4: "remix" → energetic, "lofi" → calm,
 *      "bhajan" → devotional-acoustic, …). Applied synchronously inside
 *      getFeatures() and persisted, so a read NEVER blocks on the network.
 *
 *   2. LLM CULTURAL PRIORS (confidence HIGH) — the model knows "Tum Hi Ho"
 *      is a slow melancholic Bollywood ballad without being told. Applied
 *      in background batches of 40, fire-and-forget; failures are swallowed
 *      (heuristic values are already on disk).
 *
 *   3. BEHAVIORAL CALIBRATION — effEnergy/effValence drift toward the
 *      energy context where the track actually succeeded (or away from where
 *      it was instantly rejected), clamped ±0.25 of the prior.
 *
 * SERVER-ONLY: z-ai-web-dev-sdk + Prisma. Never import from client code.
 */

import type { TrackFeature } from '@prisma/client'
import { db } from '@/lib/db'
import { aiChatJson } from '@/lib/ai/engine'
import { parseTolerantJson } from '@/lib/ai/partial'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TempoClass = 'slow' | 'mid' | 'fast'
export type AcousticKind = 'acoustic' | 'amplified' | 'electronic'
export type EraBucket = 'pre-80s' | '80s' | '90s' | '2000s' | '2010s' | 'current'
export type FeatureConfidence = 'HIGH' | 'MEDIUM' | 'LOW'

/** Shape of a TrackFeature row (heuristic rows are built to the same shape). */
export type TrackFeatureRow = TrackFeature

interface TrackMetaLite {
  id: string
  title: string
  artistName: string
  albumName?: string | null
  year?: number | null
  duration?: number | null
}

interface LlmFeatureGuess {
  energy?: number
  valence?: number
  tempoClass?: string
  acoustic?: string
  eraBucket?: string
  language?: string
  moodTags?: string[]
}

// ---------------------------------------------------------------------------
// Metadata heuristics (plan §6.4) — keyword rules on title + album
// ---------------------------------------------------------------------------

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** Test title+album for a keyword group. */
function hit(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w))
}

/**
 * Apply the plan's keyword rules. First matching cultural rule wins
 * (devotional > ghazal > sufi > chill > sad > party > remix > default),
 * then tempoClass/acoustic/eraBucket/language are layered on top.
 */
export function heuristicFeatures(t: TrackMetaLite): Omit<TrackFeatureRow, 'updatedAt' | 'effEnergy' | 'effValence' | 'calibrations'> {
  const text = `${t.title} ${t.albumName ?? ''}`.toLowerCase()

  let energy = 0.5
  let valence = 0.5
  let tempoClass: TempoClass = 'mid'
  let acoustic: AcousticKind = 'amplified'
  const moodTags: string[] = []
  let language = 'unknown'

  if (hit(text, ['bhajan', 'shabad', 'kirtan', 'aarti', 'hanuman', 'shiv', 'krishna', 'mantra', 'stotra'])) {
    energy = 0.3; valence = 0.65; acoustic = 'acoustic'
    moodTags.push('devotional', 'spiritual')
    language = text.includes('shabad') ? 'punjabi' : 'hindi'
    tempoClass = 'slow'
  } else if (text.includes('ghazal')) {
    energy = 0.25; valence = 0.45; acoustic = 'acoustic'
    moodTags.push('ghazal')
    language = 'urdu'; tempoClass = 'slow'
  } else if (text.includes('sufi')) {
    energy = 0.5; valence = 0.6
    moodTags.push('sufi')
    language = 'urdu'
  } else if (hit(text, ['unplugged', 'lofi', 'lo-fi', 'acoustic', 'slowed', 'reverb', '8d', 'nightcore'])) {
    energy = 0.3
    if (hit(text, ['slowed', 'lofi', 'lo-fi'])) valence = 0.4
    acoustic = 'acoustic'; tempoClass = 'slow'
    moodTags.push('chill')
  } else if (hit(text, ['sad', 'dukh', 'bewafa', 'judai', 'alone', 'tanha', 'dard', 'gham'])) {
    valence = 0.2; energy = 0.35; tempoClass = 'slow'
    moodTags.push('sad')
    if (hit(text, ['dukh', 'bewafa', 'judai', 'tanha', 'dard', 'gham'])) language = 'hindi'
  } else if (hit(text, ['party', 'dance', 'club', 'bhangra', 'nachdi'])) {
    energy = 0.9; valence = 0.8; acoustic = 'electronic'; tempoClass = 'fast'
    moodTags.push('party', 'dance')
  } else if (hit(text, ['remix', 'edm', 'bass boosted', 'bounce', 'trap', 'dubstep'])) {
    energy = 0.85; acoustic = 'electronic'; tempoClass = 'fast'
    moodTags.push('remix', 'energetic')
  }

  // eraBucket from the catalog year when present
  let eraBucket: EraBucket | undefined
  if (t.year && t.year > 1900) {
    if (t.year < 1980) eraBucket = 'pre-80s'
    else if (t.year < 1990) eraBucket = '80s'
    else if (t.year < 2000) eraBucket = '90s'
    else if (t.year < 2010) eraBucket = '2000s'
    else if (t.year < 2020) eraBucket = '2010s'
    else eraBucket = 'current'
  }

  return {
    trackId: t.id,
    energy,
    valence,
    tempoClass,
    acoustic,
    eraBucket: eraBucket ?? null,
    language: language === 'unknown' ? null : language,
    moodTags: JSON.stringify(moodTags),
    confidence: 'LOW',
  }
}

// ---------------------------------------------------------------------------
// LLM cultural priors — z-ai-web-dev-sdk (backend only) with house fallback
// ---------------------------------------------------------------------------

/** One enrichment call handles at most 40 tracks (plan contract). */
const LLM_BATCH = 40
const LLM_TIMEOUT_MS = 45_000

function batchPrompt(batch: TrackMetaLite[]): { system: string; user: string } {
  const system =
    'You are a music-culture database. For each numbered track, use your knowledge of the song, artist, film and regional music culture to estimate audio features. ' +
    'Reply with COMPACT JSON only — no markdown, no prose. Schema: {"results":[{"i":<number>,"energy":<0-1>,"valence":<0-1>,"tempoClass":"slow"|"mid"|"fast","acoustic":"acoustic"|"amplified"|"electronic","eraBucket":"pre-80s"|"80s"|"90s"|"2000s"|"2010s"|"current","language":"<iso-ish name or unknown>","moodTags":["<2-4 tags>"]}]}. ' +
    'Include every i from the list. If truly unknown, output your best guess from the title language and keywords — never omit an index.'
  const lines = batch.map((t, i) => `${i}. "${t.title}" — ${t.artistName}${t.albumName ? ` [${t.albumName}]` : ''}${t.year ? ` (${t.year})` : ''}`)
  return { system, user: lines.join('\n') }
}

function parseLlmResult(raw: string | null, batch: TrackMetaLite[]): Map<string, LlmFeatureGuess> {
  const out = new Map<string, LlmFeatureGuess>()
  if (!raw) return out
  let j: any = parseTolerantJson<any>(raw)
  if (!j) return out
  // tolerate {results:[…]} or a bare array or {tracks:[…]}
  const arr: any[] = Array.isArray(j) ? j : (j.results ?? j.tracks ?? j.features ?? [])
  if (!Array.isArray(arr)) return out
  for (const r of arr) {
    const i = Number(r?.i ?? r?.index)
    if (!Number.isFinite(i) || i < 0 || i >= batch.length) continue
    const track = batch[i]
    const num = (v: unknown): number | undefined => {
      const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN
      return Number.isFinite(n) ? clamp01(n) : undefined
    }
    out.set(track.id, {
      energy: num(r.energy),
      valence: num(r.valence),
      tempoClass: ['slow', 'mid', 'fast'].includes(r.tempoClass) ? r.tempoClass : undefined,
      acoustic: ['acoustic', 'amplified', 'electronic'].includes(r.acoustic) ? r.acoustic : undefined,
      eraBucket: ['pre-80s', '80s', '90s', '2000s', '2010s', 'current'].includes(r.eraBucket) ? r.eraBucket : undefined,
      language: typeof r.language === 'string' && r.language && r.language !== 'unknown' ? r.language.slice(0, 24) : undefined,
      moodTags: Array.isArray(r.moodTags) ? r.moodTags.filter((m: unknown) => typeof m === 'string').slice(0, 4) : undefined,
    })
  }
  return out
}

/**
 * Enrich a batch of ≤40 tracks via the z-ai SDK (thinking disabled, JSON
 * mode — same call shape the rest of the AI layer uses). Falls back to the
 * house engine (engine.ts → keyless gateway) when the SDK path fails.
 * NEVER throws: the caller's heuristic rows are already persisted.
 */
export async function enrichWithLLM(batch: TrackMetaLite[]): Promise<Map<string, LlmFeatureGuess>> {
  if (!batch.length) return new Map()
  const { system, user } = batchPrompt(batch)
  try {
    const { default: ZAI } = await import('z-ai-web-dev-sdk')
    const zai = await ZAI.create()
    const completion = (await Promise.race([
      zai.chat.completions.create({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        thinking: { type: 'disabled' },
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      new Promise((_res, rej) => setTimeout(() => rej(new Error('llm timeout')), LLM_TIMEOUT_MS)),
    ])) as any
    const text: string | undefined = completion?.choices?.[0]?.message?.content
    if (text) {
      const parsed = parseLlmResult(text, batch)
      if (parsed.size) return parsed
    }
  } catch {
    // SDK missing/unconfigured → house engine fallback below
  }
  try {
    const text = await aiChatJson<string>(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.2, maxTokens: 2400, json: true, timeoutMs: LLM_TIMEOUT_MS }
    )
    return parseLlmResult(text, batch)
  } catch {
    return new Map()
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function heuristicRow(t: TrackMetaLite): TrackFeatureRow {
  return {
    ...heuristicFeatures(t),
    effEnergy: null,
    effValence: null,
    calibrations: 0,
    updatedAt: new Date(),
  }
}

async function saveHeuristic(row: TrackFeatureRow): Promise<void> {
  try {
    await db.trackFeature.upsert({
      where: { trackId: row.trackId },
      // never clobber HIGH-confidence LLM priors or calibration state
      update: { confidence: 'LOW' },
      create: {
        trackId: row.trackId,
        energy: row.energy,
        valence: row.valence,
        tempoClass: row.tempoClass,
        acoustic: row.acoustic,
        eraBucket: row.eraBucket,
        language: row.language,
        moodTags: row.moodTags,
        confidence: 'LOW',
      },
    })
  } catch {
    // row raced into existence / db hiccup — non-fatal
  }
}

async function saveLlmRow(trackId: string, g: LlmFeatureGuess): Promise<void> {
  try {
    await db.trackFeature.upsert({
      where: { trackId },
      update: {
        ...(g.energy !== undefined ? { energy: g.energy } : {}),
        ...(g.valence !== undefined ? { valence: g.valence } : {}),
        ...(g.tempoClass ? { tempoClass: g.tempoClass } : {}),
        ...(g.acoustic ? { acoustic: g.acoustic } : {}),
        ...(g.eraBucket ? { eraBucket: g.eraBucket } : {}),
        ...(g.language ? { language: g.language } : {}),
        ...(g.moodTags ? { moodTags: JSON.stringify(g.moodTags) } : {}),
        confidence: 'HIGH',
      },
      create: {
        trackId,
        energy: g.energy ?? 0.5,
        valence: g.valence ?? 0.5,
        tempoClass: g.tempoClass ?? 'mid',
        acoustic: g.acoustic ?? 'amplified',
        eraBucket: g.eraBucket ?? null,
        language: g.language ?? null,
        moodTags: JSON.stringify(g.moodTags ?? []),
        confidence: 'HIGH',
      },
    })
  } catch {
    // non-fatal
  }
}

/** Rows the LLM gave nothing for: wipe after 2h (if still LOW) so a later pass can retry. */
function scheduleEmptyWipe(trackId: string): void {
  const timer = setTimeout(() => {
    // only wipe untouched LOW-confidence rows (never LLM priors or calibration work)
    void db.trackFeature
      .deleteMany({ where: { trackId, confidence: 'LOW', calibrations: 0 } })
      .then(() => enrichedDone.delete(trackId)) // re-mark as enrichable
      .catch(() => {})
  }, 2 * 60 * 60 * 1000)
  if (typeof timer.unref === 'function') timer.unref()
}

// ---------------------------------------------------------------------------
// Background enrichment queue (fire-and-forget, deduped, never awaited)
// ---------------------------------------------------------------------------

const enrichedDone = new Set<string>()   // attempted successfully at least once
const enrichAttempts = new Map<string, number>()
let enrichQueue: TrackMetaLite[] = []
let enrichFlushTimer: ReturnType<typeof setTimeout> | null = null
let enrichInFlight = false
const MAX_ATTEMPTS = 3

function scheduleEnrichFlush(delayMs = 300): void {
  if (enrichFlushTimer) return
  enrichFlushTimer = setTimeout(() => {
    enrichFlushTimer = null
    void flushEnrichQueue()
  }, delayMs)
  if (typeof enrichFlushTimer.unref === 'function') enrichFlushTimer.unref()
}

async function flushEnrichQueue(): Promise<void> {
  if (enrichInFlight) return
  enrichInFlight = true
  try {
    while (enrichQueue.length) {
      const batch = enrichQueue.splice(0, LLM_BATCH)
      const parsed = await enrichWithLLM(batch)
      for (const t of batch) {
        const guess = parsed.get(t.id)
        if (guess && (guess.energy !== undefined || guess.moodTags?.length)) {
          await saveLlmRow(t.id, guess)
          enrichedDone.add(t.id)
          enrichAttempts.delete(t.id)
        } else {
          // empty result → wipe heuristic row after 2h to allow a retry later
          scheduleEmptyWipe(t.id)
          const attempts = (enrichAttempts.get(t.id) ?? 0) + 1
          enrichAttempts.set(t.id, attempts)
          if (attempts < MAX_ATTEMPTS) {
            enrichQueue.push(t) // retry a later pass
          } else {
            enrichedDone.add(t.id) // give up for this process lifetime
          }
        }
      }
    }
  } catch {
    // swallow — enrichment is opportunistic
  } finally {
    enrichInFlight = false
    if (enrichQueue.length) scheduleEnrichFlush(5_000)
  }
}

/** Queue metadata-light tracks for LLM enrichment. Fire-and-forget. */
function enqueueEnrichment(metas: TrackMetaLite[]): void {
  const fresh = metas.filter((m) => !enrichedDone.has(m.id) && (enrichAttempts.get(m.id) ?? 0) < MAX_ATTEMPTS)
  if (!fresh.length) return
  const seen = new Set(enrichQueue.map((q) => q.id))
  enrichQueue.push(...fresh.filter((m) => !seen.has(m.id)))
  scheduleEnrichFlush()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read features for trackIds. Cache misses get metadata heuristics applied
 * SYNCHRONOUSLY (persisted, confidence LOW) and are enqueued for LLM
 * enrichment in the background. The returned Map always covers every
 * requested id (best-effort; db failure → empty map).
 */
export async function getFeatures(trackIds: string[]): Promise<Map<string, TrackFeatureRow>> {
  const out = new Map<string, TrackFeatureRow>()
  const ids = [...new Set(trackIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (!ids.length) return out

  let rows: TrackFeatureRow[] = []
  try {
    rows = await db.trackFeature.findMany({ where: { trackId: { in: ids } } })
  } catch {
    return out
  }
  for (const r of rows) out.set(r.trackId, r)

  const misses = ids.filter((id) => !out.has(id))
  if (!misses.length) return out

  let metas: TrackMetaLite[] = []
  try {
    metas = await db.track.findMany({
      where: { id: { in: misses } },
      select: { id: true, title: true, artistName: true, albumName: true, year: true, duration: true },
    })
  } catch {
    metas = []
  }
  // tracks absent from the catalog cache still get a stub so lookups resolve
  const metaById = new Map<string, TrackMetaLite>(metas.map((m) => [m.id, m]))
  for (const id of misses) {
    if (!metaById.has(id)) metaById.set(id, { id, title: id, artistName: 'Unknown artist' })
  }

  const heuristicRows: TrackFeatureRow[] = []
  const enrichedMisses: TrackMetaLite[] = []
  for (const id of misses) {
    const meta = metaById.get(id)!
    const row = heuristicRow(meta)
    heuristicRows.push(row)
    out.set(id, row)
    // only bother the LLM when we have a real title to reason about
    if (meta.title && meta.title !== id) enrichedMisses.push(meta)
  }

  // persist heuristics + fire background LLM enrichment (never awaited)
  void (async () => {
    for (const row of heuristicRows) await saveHeuristic(row)
    enqueueEnrichment(enrichedMisses)
  })().catch(() => {})

  return out
}

// ---------------------------------------------------------------------------
// Behavioral calibration
// ---------------------------------------------------------------------------

/**
 * Nudge effEnergy toward the observed success context (COMPLETED) or away
 * from the rejected context (INSTANT_REJECT), clamped to ±0.25 of the prior.
 * Called by the ledger engine when a decisive listen has features.
 */
export async function calibrate(
  trackId: string,
  observed: { completed: boolean; energyAt: number }
): Promise<void> {
  try {
    const row = await db.trackFeature.findUnique({ where: { trackId } })
    const prior = row?.effEnergy ?? row?.energy
    if (prior === null || prior === undefined) return
    const target = clamp01(observed.energyAt)
    const ALPHA = 0.15
    const CLAMP = 0.25
    let next = observed.completed
      ? prior + ALPHA * (target - prior)
      : prior - ALPHA * (target - prior)
    next = Math.max(prior - CLAMP, Math.min(prior + CLAMP, next))
    next = clamp01(next)
    if (Math.abs(next - prior) < 0.005) return
    await db.trackFeature.update({
      where: { trackId },
      data: { effEnergy: next, calibrations: { increment: 1 } },
    })
  } catch {
    // calibration is opportunistic — never surface errors
  }
}

// ---------------------------------------------------------------------------
// Effective getters (eff ?? prior ?? neutral)
// ---------------------------------------------------------------------------

export async function getEffectiveEnergy(trackId: string): Promise<number> {
  try {
    const row = await db.trackFeature.findUnique({
      where: { trackId },
      select: { effEnergy: true, energy: true },
    })
    return row?.effEnergy ?? row?.energy ?? 0.5
  } catch {
    return 0.5
  }
}

export async function getEffectiveValence(trackId: string): Promise<number> {
  try {
    const row = await db.trackFeature.findUnique({
      where: { trackId },
      select: { effValence: true, valence: true },
    })
    return row?.effValence ?? row?.valence ?? 0.5
  } catch {
    return 0.5
  }
}
