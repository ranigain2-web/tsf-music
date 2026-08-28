/**
 * TSF Music — Synth Arrangement Planner
 *
 * Turns (videoId, durationSec) into a deterministic, full-length song plan:
 * key, tempo, genre, song structure (intro/verse/chorus/bridge/outro),
 * chord progressions, drum patterns, bass lines, arpeggios, pad voicings
 * and lead melodies — all as a flat, time-sorted list of note events.
 *
 * Determinism: same videoId + duration → byte-identical song, forever.
 * Uniqueness: different videoIds → different songs (key/tempo/genre/melody).
 *
 * The renderer (render.ts) turns this plan into PCM samples as a pure
 * function of the absolute sample index, so any byte range of the track
 * can be rendered on demand (seeking + streaming with no full-file cost).
 */

export const SR = 44100 // sample rate

export type InstKind = 'kick' | 'snare' | 'hat' | 'ohat' | 'clap' | 'bass' | 'pad' | 'arp' | 'lead' | 'pluck' | 'riser'

export interface NoteEvent {
  inst: InstKind
  start: number // absolute sample index
  len: number // samples
  freq: number | string // Hz (drums: 0; pad: comma-joined freq list)
  vel: number // 0..1
  x: number // per-instrument extra param (brightness etc.)
}

export interface SongPlan {
  videoId: string
  durationSec: number
  totalSamples: number
  bpm: number
  genre: string
  masterGain: number
  swing: number
  events: NoteEvent[] // sorted by start
  maxNoteLen: number // longest event (for range scan window)
}

// ---------- deterministic PRNG ----------

export function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- music theory ----------

const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

// semitone offsets
const SCALES: Record<string, number[]> = {
  minorPent: [0, 3, 5, 7, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  harmMinor: [0, 2, 3, 5, 7, 8, 11],
}

/** Scale-degree index (can exceed scale length → octaves) → midi note */
function degreeToMidi(rootMidi: number, scale: number[], degree: number): number {
  const n = scale.length
  const oct = Math.floor(degree / n)
  const idx = ((degree % n) + n) % n
  return rootMidi + scale[idx] + 12 * oct
}

/** Chord tones for a scale degree (triad or 7th) */
function chordDegrees(degree: number, seventh: boolean): number[] {
  return seventh ? [degree, degree + 2, degree + 4, degree + 6] : [degree, degree + 2, degree + 4]
}

// ---------- genre presets ----------

interface GenrePreset {
  bpm: [number, number]
  scales: string[]
  verseProgs: number[][]
  chorusProgs: number[][]
  drums: 'four' | 'rock' | 'boombap' | 'trap' | 'lofi' | 'halftime'
  bassStyle: 'eighths' | 'offbeat' | 'boombap' | 'sparse' | 'sustained'
  arp: 'up' | 'down' | 'updown' | 'random' | 'none'
  arpGrid: 2 | 4 // steps per beat (4 = 16ths, 2 = 8ths)
  swing: number
  padLevel: number
  leadLevel: number
}

const GENRES: Record<string, GenrePreset> = {
  pop: {
    bpm: [98, 118], scales: ['major', 'minor'],
    verseProgs: [[0, 4, 5, 3], [5, 3, 0, 4], [0, 5, 3, 4]],
    chorusProgs: [[5, 3, 0, 4], [0, 4, 5, 3], [3, 4, 0, 5]],
    drums: 'four', bassStyle: 'eighths', arp: 'up', arpGrid: 2, swing: 0,
    padLevel: 0.9, leadLevel: 1.0,
  },
  rock: {
    bpm: [118, 140], scales: ['minor', 'minorPent', 'dorian'],
    verseProgs: [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 5, 4]],
    chorusProgs: [[5, 2, 6, 0], [0, 5, 6, 4]],
    drums: 'rock', bassStyle: 'eighths', arp: 'none', arpGrid: 2, swing: 0,
    padLevel: 0.7, leadLevel: 1.0,
  },
  hiphop: {
    bpm: [80, 94], scales: ['minorPent', 'minor', 'harmMinor'],
    verseProgs: [[0, 0, 5, 5], [0, 3, 0, 4], [0, 5, 3, 3]],
    chorusProgs: [[0, 5, 3, 4], [0, 0, 5, 4]],
    drums: 'boombap', bassStyle: 'boombap', arp: 'none', arpGrid: 2, swing: 0.18,
    padLevel: 1.0, leadLevel: 0.85,
  },
  electronic: {
    bpm: [120, 128], scales: ['minor', 'dorian'],
    verseProgs: [[0, 5, 2, 6], [0, 3, 5, 6]],
    chorusProgs: [[0, 5, 6, 4], [5, 2, 6, 0]],
    drums: 'four', bassStyle: 'offbeat', arp: 'updown', arpGrid: 4, swing: 0,
    padLevel: 1.0, leadLevel: 0.95,
  },
  dance: {
    bpm: [122, 130], scales: ['minor', 'major'],
    verseProgs: [[0, 5, 3, 4], [5, 3, 0, 4]],
    chorusProgs: [[0, 4, 5, 3], [3, 4, 0, 5]],
    drums: 'four', bassStyle: 'offbeat', arp: 'up', arpGrid: 4, swing: 0,
    padLevel: 0.9, leadLevel: 1.0,
  },
  lofi: {
    bpm: [72, 86], scales: ['dorian', 'minor', 'major'],
    verseProgs: [[0, 3, 5, 4], [1, 4, 0, 0], [0, 5, 1, 4]],
    chorusProgs: [[3, 4, 0, 5], [0, 3, 5, 4]],
    drums: 'lofi', bassStyle: 'sparse', arp: 'random', arpGrid: 2, swing: 0.22,
    padLevel: 1.1, leadLevel: 0.8,
  },
  rnb: {
    bpm: [88, 102], scales: ['minor', 'dorian'],
    verseProgs: [[0, 3, 5, 4], [1, 4, 0, 5], [0, 4, 3, 4]],
    chorusProgs: [[5, 3, 4, 0], [0, 3, 4, 5]],
    drums: 'halftime', bassStyle: 'sustained', arp: 'up', arpGrid: 2, swing: 0.12,
    padLevel: 1.05, leadLevel: 0.9,
  },
  ambient: {
    bpm: [62, 76], scales: ['major', 'dorian', 'minor'],
    verseProgs: [[0, 5, 3, 4], [0, 3, 0, 4]],
    chorusProgs: [[3, 0, 4, 5], [0, 5, 3, 4]],
    drums: 'halftime', bassStyle: 'sustained', arp: 'up', arpGrid: 2, swing: 0,
    padLevel: 1.2, leadLevel: 0.7,
  },
}

const GENRE_NAMES = Object.keys(GENRES)

// ---------- drum patterns (16 steps / bar) ----------

interface DrumPattern {
  kick: number[]
  snare: number[]
  hat: number[]
  ohat: number[]
  clap: number[]
}

function drumPattern(style: GenrePreset['drums'], rand: () => number, energy: number, fill: boolean): DrumPattern {
  const p: DrumPattern = { kick: [], snare: [], hat: [], ohat: [], clap: [] }
  switch (style) {
    case 'four':
      p.kick = [0, 4, 8, 12]
      p.snare = energy >= 0.9 ? [] : [4, 12]
      p.clap = energy >= 0.9 ? [4, 12] : []
      p.hat = energy >= 0.8 ? [2, 6, 10, 14] : [4, 12]
      p.ohat = energy >= 1 ? [14] : []
      if (energy >= 1 && rand() < 0.5) p.hat.push(7)
      break
    case 'rock':
      p.kick = energy >= 0.9 ? [0, 6, 8, 14] : [0, 8]
      p.snare = [4, 12]
      p.hat = energy >= 0.6 ? [0, 2, 4, 6, 8, 10, 12, 14] : [0, 4, 8, 12]
      p.ohat = energy >= 0.9 ? [6, 14] : []
      break
    case 'boombap':
      p.kick = [0, 6, 10]
      if (rand() < 0.4) p.kick.push(14)
      p.snare = [4, 12]
      p.hat = [2, 6, 10, 14]
      if (energy >= 0.9) p.hat.push(0, 8)
      break
    case 'trap':
      p.kick = [0, 6, 10]
      p.snare = [8]
      p.hat = [0, 2, 4, 6, 8, 10, 12, 14]
      if (rand() < 0.5) p.hat.push(15)
      break
    case 'lofi':
      p.kick = [0, 10]
      p.snare = [4, 12]
      p.hat = [2, 6, 10, 14]
      if (rand() < 0.3) p.ohat.push(6)
      break
    case 'halftime':
      p.kick = energy >= 0.9 ? [0, 10] : [0]
      p.snare = [8]
      p.clap = energy >= 1 ? [8] : []
      p.hat = energy >= 0.8 ? [0, 4, 8, 12] : [0, 8]
      break
  }
  if (fill) {
    // last-bar fill: 16th-note snare roll ramp in the last beat
    p.snare = p.snare.filter((s) => s < 12).concat([12, 13, 14, 15])
    p.kick = p.kick.filter((s) => s < 12)
  }
  return p
}

// ---------- section planning ----------

type SectionKind = 'intro' | 'verse' | 'chorus' | 'bridge' | 'outro'

const ENERGY: Record<SectionKind, number> = { intro: 0.4, verse: 0.62, chorus: 1.0, bridge: 0.45, outro: 0.35 }

interface Section {
  kind: SectionKind
  bars: number
  startBar: number
}

function planSections(rand: () => number, totalBars: number): Section[] {
  const out: Section[] = []
  const push = (kind: SectionKind, bars: number) => out.push({ kind, bars, startBar: 0 })
  push('intro', 4)
  let used = 4
  const cycle = () => {
    const vb = 8, cb = 8
    if (used + vb + cb > totalBars) return false
    push('verse', vb); used += vb
    push('chorus', cb); used += cb
    return true
  }
  // at least one verse-chorus
  cycle()
  while (used + 20 <= totalBars) cycle()
  // bridge + final chorus if room
  if (used + 14 <= totalBars) {
    push('bridge', 6); used += 6
    push('chorus', 8); used += 8
    while (used + 8 <= totalBars) { push('chorus', 8); used += 8 }
  }
  const outroBars = Math.max(2, Math.min(6, totalBars - used))
  push('outro', outroBars)
  used += outroBars
  // fix starts, trim overflow
  let bar = 0
  for (const s of out) {
    s.startBar = bar
    if (bar + s.bars > totalBars) s.bars = Math.max(1, totalBars - bar)
    bar += s.bars
    if (bar >= totalBars) break
  }
  const trimmed = out.filter((s) => s.bars > 0)
  // guarantee at least intro+chorus+outro for very short tracks
  if (trimmed.length < 3) {
    const q = Math.max(1, Math.floor(totalBars / 4))
    return [
      { kind: 'intro', bars: q, startBar: 0 },
      { kind: 'chorus', bars: Math.max(1, totalBars - q - 1), startBar: q },
      { kind: 'outro', bars: 1, startBar: totalBars - 1 },
    ]
  }
  return trimmed
}

// ---------- motif (lead melody) generation ----------

interface MotifNote { step: number; degree: number; len: number } // step/len in 16ths

function makeMotif(rand: () => number, density: number): MotifNote[] {
  // rhythmic templates on a 16th grid (2 bars = 32 steps)
  const templates: number[][] = [
    [0, 4, 8, 12, 16, 20, 24, 28],
    [0, 3, 6, 8, 12, 14, 16, 22, 24, 28],
    [0, 4, 6, 12, 16, 20, 26],
    [0, 2, 4, 10, 12, 16, 20, 24, 26],
    [0, 6, 8, 14, 16, 24, 28],
    [0, 4, 8, 10, 16, 20, 24, 30],
  ]
  const base = templates[Math.floor(rand() * templates.length)]
  const notes: MotifNote[] = []
  // pitch walk
  let deg = Math.floor(rand() * 5) + 2
  for (let i = 0; i < base.length; i++) {
    const keep = rand() < density
    if (keep) {
      const step = Math.min(1, Math.floor(rand() * 3)) - 1
      deg = Math.max(0, Math.min(12, deg + step))
      const next = i + 1 < base.length ? base[i + 1] : base[i] + 4
      const len = Math.max(1, Math.min(6, next - base[i] - (rand() < 0.4 ? 1 : 0)))
      notes.push({ step: base[i], degree: deg, len })
    }
  }
  if (notes.length === 0) notes.push({ step: 0, degree: 4, len: 4 })
  return notes
}

// ---------- main planner ----------

const planCache = new Map<string, SongPlan>()

export function clampDuration(d: number): number {
  if (!isFinite(d) || d <= 0) return 187
  return Math.max(21, Math.min(600, Math.round(d)))
}

/**
 * Effective track duration for synthesis. When the caller has no real
 * duration metadata (some YTM sources return 0), derive a deterministic
 * VARIED duration from the videoId hash (138–278s) — so every track in the
 * catalog feels like it has its own natural length instead of one flat 187s.
 */
export function deriveDuration(videoId: string, d: number): number {
  if (isFinite(d) && d > 0) return clampDuration(d)
  return 138 + (hashSeed(`len:${videoId}`) % 141)
}

export function buildPlan(videoId: string, durationSec: number): SongPlan {
  const dur = deriveDuration(videoId, durationSec)
  const cacheKey = `${videoId}:${dur}`
  const hit = planCache.get(cacheKey)
  if (hit) return hit

  const seed = hashSeed(videoId)
  const rand = mulberry32(seed)

  const genreName = GENRE_NAMES[Math.floor(rand() * GENRE_NAMES.length)]
  const g = GENRES[genreName]
  const bpm = Math.round(g.bpm[0] + rand() * (g.bpm[1] - g.bpm[0]))
  const scaleName = g.scales[Math.floor(rand() * g.scales.length)]
  const scale = SCALES[scaleName]
  const rootMidi = 45 + Math.floor(rand() * 12) // A2..G#3 root
  const masterGain = 0.82 + rand() * 0.16

  const secPerBeat = 60 / bpm
  const secPerBar = secPerBeat * 4
  const totalSamples = Math.floor(dur * SR)
  const totalBars = Math.max(4, Math.ceil(dur / secPerBar))

  const sections = planSections(rand, totalBars)

  const verseProg = g.verseProgs[Math.floor(rand() * g.verseProgs.length)]
  const chorusProg = g.chorusProgs[Math.floor(rand() * g.chorusProgs.length)]
  const seventhChorus = rand() < 0.6
  const twoBarChords = bpm < 90 && rand() < 0.5

  const verseMotif = makeMotif(rand, 0.85)
  const chorusMotif = makeMotif(rand, 1.0)
  const bridgeMotif = makeMotif(rand, 0.55)

  const events: NoteEvent[] = []
  const push = (e: NoteEvent) => {
    if (e.start < totalSamples && e.len > 0) events.push(e)
  }
  const step16 = secPerBeat / 4 // seconds per 16th
  const swingOff = g.swing * step16 * 0.5 // seconds delayed for swung 16ths

  // arp pattern order helper
  const arpSeq = (tones: number[], i: number, mode: GenrePreset['arp']): number => {
    if (mode === 'up') return tones[i % tones.length]
    if (mode === 'down') return tones[tones.length - 1 - (i % tones.length)]
    if (mode === 'updown') {
      const cycle = tones.length * 2 - 2
      const k = i % cycle
      return tones[k < tones.length ? k : cycle - k]
    }
    // random (deterministic per event)
    const r = ((Math.imul(i + 0x9e3779b9, 0x85ebca6b) >>> 8) % 1000) / 1000
    return tones[Math.floor(r * tones.length) % tones.length]
  }

  for (const sec of sections) {
    const energy = ENERGY[sec.kind]
    const prog = sec.kind === 'chorus' ? chorusProg : sec.kind === 'bridge' ? [verseProg[0], verseProg[2]] : verseProg
    const motif = sec.kind === 'chorus' ? chorusMotif : sec.kind === 'bridge' ? bridgeMotif : verseMotif

    for (let b = 0; b < sec.bars; b++) {
      const barIdx = sec.startBar + b
      const barSec = barIdx * secPerBar
      const barStart = Math.floor(barSec * SR)
      if (barStart >= totalSamples) break

      const chordIdx = twoBarChords ? Math.floor(b / 2) % prog.length : b % prog.length
      const chordDeg = prog[chordIdx]
      const seventh = sec.kind === 'chorus' && seventhChorus
      const tones = chordDegrees(chordDeg, seventh)
      const barFill = b === sec.bars - 1 && (sec.kind === 'verse' || sec.kind === 'chorus' || sec.kind === 'bridge') &&
        sec.startBar + sec.bars < totalBars

      const drumsOn =
        (sec.kind === 'verse' || sec.kind === 'chorus') ||
        (sec.kind === 'bridge' && b >= Math.floor(sec.bars / 2)) ||
        (sec.kind === 'outro' && energy >= 0.4 && b === 0)

      // ---- drums ----
      if (drumsOn) {
        const pat = drumPattern(g.drums, rand, energy, barFill)
        for (const s of pat.kick) {
          const t = barSec + s * step16 + (s % 2 === 1 ? swingOff : 0)
          push({ inst: 'kick', start: Math.floor(t * SR), len: Math.floor(0.24 * SR), freq: 0, vel: 0.85 + rand() * 0.12, x: 0 })
        }
        for (const s of pat.snare) {
          const t = barSec + s * step16 + (s % 2 === 1 ? swingOff : 0)
          push({ inst: 'snare', start: Math.floor(t * SR), len: Math.floor(0.2 * SR), freq: 0, vel: 0.7 + rand() * 0.15, x: 0 })
        }
        for (const s of pat.clap) {
          push({ inst: 'clap', start: Math.floor((barSec + s * step16) * SR), len: Math.floor(0.22 * SR), freq: 0, vel: 0.75 + rand() * 0.12, x: 0 })
        }
        for (const s of pat.hat) {
          const t = barSec + s * step16 + (s % 2 === 1 ? swingOff : 0)
          push({ inst: 'hat', start: Math.floor(t * SR), len: Math.floor(0.06 * SR), freq: 0, vel: 0.5 + rand() * 0.15, x: 0 })
        }
        for (const s of pat.ohat) {
          push({ inst: 'ohat', start: Math.floor((barSec + s * step16) * SR), len: Math.floor(0.28 * SR), freq: 0, vel: 0.55 + rand() * 0.1, x: 0 })
        }
      } else if (sec.kind === 'intro') {
        // sparse hats in the intro
        for (const s of [4, 12]) {
          push({ inst: 'hat', start: Math.floor((barSec + s * step16) * SR), len: Math.floor(0.06 * SR), freq: 0, vel: 0.35 + rand() * 0.1, x: 0 })
        }
      }

      // ---- bass ----
      if (sec.kind !== 'intro' && sec.kind !== 'outro' && !(sec.kind === 'bridge' && b < Math.floor(sec.bars / 2))) {
        const bassRoot = degreeToMidi(rootMidi, scale, chordDeg) - 12
        const bassF = midiToFreq(bassRoot)
        const steps: number[] =
          g.bassStyle === 'eighths' ? [0, 2, 4, 6, 8, 10, 12, 14]
          : g.bassStyle === 'offbeat' ? [2, 6, 10, 14]
          : g.bassStyle === 'boombap' ? [0, 6, 10]
          : g.bassStyle === 'sparse' ? [0, 10]
          : [0]
        for (const s of steps) {
          const t = barSec + s * step16 + (s % 2 === 1 ? swingOff : 0)
          const lenSec = g.bassStyle === 'sustained' ? secPerBar : step16 * 1.8
          const fifth = rand() < 0.12 && s > 0
          push({
            inst: 'bass',
            start: Math.floor(t * SR),
            len: Math.floor(lenSec * SR),
            freq: fifth ? bassF * 1.5 : bassF,
            vel: (0.7 + rand() * 0.12) * (0.85 + energy * 0.15),
            x: 0.4 + rand() * 0.3, // brightness
          })
        }
      }

      // ---- pad (chord) ----
      {
        const skip = twoBarChords && b % 2 === 1
        if (!skip) {
          const chordLenSec = twoBarChords ? secPerBar * 2 : secPerBar
          const voicing = tones.map((d) => degreeToMidi(rootMidi + 12, scale, d))
          voicing.push(degreeToMidi(rootMidi, scale, chordDeg))
          const rel = 0.55 + energy * 0.45
          push({
            inst: 'pad',
            start: barStart,
            len: Math.floor(chordLenSec * SR * 1.02),
            freq: voicing.map((m) => midiToFreq(m).toFixed(3)).join(','),
            vel: g.padLevel * rel * (0.85 + rand() * 0.1),
            x: 0,
          })
        }
      }

      // ---- arp ----
      const arpOn =
        g.arp !== 'none' &&
        (sec.kind === 'chorus' || sec.kind === 'intro' || sec.kind === 'outro' ||
          (sec.kind === 'verse' && energy >= 0.6) || sec.kind === 'bridge')
      if (arpOn) {
        const gridSteps = g.arpGrid === 4 ? 16 : 8
        const arpTones = chordDegrees(chordDeg, seventh).map((d) => degreeToMidi(rootMidi + 24, scale, d))
        const arpDense = sec.kind === 'verse' ? 0.75 : 1
        let ai = b * gridSteps
        for (let s = 0; s < gridSteps; s++) {
          if (g.arp === 'random' && ((Math.imul(ai + 0x9e3779b9, 0x85ebca6b) >>> 8) % 1000) / 1000 > arpDense) { ai++; continue }
          const t = barSec + s * (secPerBeat / gridSteps) + (s % 2 === 1 ? swingOff : 0)
          const midi = arpSeq(arpTones, ai, g.arp)
          push({
            inst: 'arp',
            start: Math.floor(t * SR),
            len: Math.floor(step16 * 1.6 * SR),
            freq: midiToFreq(midi),
            vel: (0.5 + rand() * 0.15) * (0.7 + energy * 0.3),
            x: 0,
          })
          ai++
        }
      }

      // ---- lead melody (verse: root octave+12; chorus: +24) ----
      const leadOn = sec.kind === 'verse' || sec.kind === 'chorus' || (sec.kind === 'bridge' && b % 2 === 0)
      if (leadOn) {
        const octave = sec.kind === 'chorus' ? 12 : 0
        const motifBar = b % 2 // motif is 2 bars
        for (const n of motif) {
          if (Math.floor(n.step / 16) !== motifBar) continue
          const stepInBar = n.step % 16
          const variation = ((Math.imul(barIdx * 31 + n.step, 0x45d9f3b) >>> 9) % 1000) / 1000
          if (variation < 0.08) continue // small per-repetition variation drop
          // snap strong beats to chord tones
          let degree = n.degree
          if (stepInBar % 8 === 0) {
            const chordTone = tones[Math.floor(rand() * tones.length)]
            degree = chordTone + (n.degree > 7 ? 7 : n.degree > 4 ? 2 : 0)
          }
          const midi = degreeToMidi(rootMidi + 12 + octave, scale, degree)
          if (midi > 88) continue
          const t = barSec + stepInBar * step16 + (stepInBar % 2 === 1 ? swingOff : 0)
          push({
            inst: 'lead',
            start: Math.floor(t * SR),
            len: Math.floor(n.len * step16 * 0.95 * SR),
            freq: midiToFreq(midi),
            vel: g.leadLevel * (0.68 + rand() * 0.15) * (0.8 + energy * 0.2),
            x: 0.3 + rand() * 0.25, // brightness mix
          })
        }
      }

      // ---- pluck accents (intro / outro / bridge) ----
      if (sec.kind === 'intro' || sec.kind === 'bridge' || sec.kind === 'outro') {
        if (rand() < 0.55) {
          const tones2 = chordDegrees(chordDeg, false).map((d) => degreeToMidi(rootMidi + 24, scale, d))
          const midi = tones2[Math.floor(rand() * tones2.length)]
          const s = [0, 6, 8, 12][Math.floor(rand() * 4)]
          push({
            inst: 'pluck',
            start: Math.floor((barSec + s * step16) * SR),
            len: Math.floor(1.4 * SR),
            freq: midiToFreq(midi),
            vel: 0.5 + rand() * 0.2,
            x: 0,
          })
        }
      }
    }

    // ---- riser into the section after a bridge ----
    if (sec.kind === 'bridge') {
      const chorusStartBar = sec.startBar + sec.bars
      const riserSec = Math.min(2 * secPerBar, 4)
      const t0 = chorusStartBar * secPerBar - riserSec
      if (t0 > 0) push({ inst: 'riser', start: Math.floor(t0 * SR), len: Math.floor(riserSec * SR), freq: 0, vel: 0.5, x: 0 })
    }
  }

  events.sort((a, b) => a.start - b.start)

  const plan: SongPlan = {
    videoId,
    durationSec: dur,
    totalSamples,
    bpm,
    genre: genreName,
    masterGain,
    swing: g.swing,
    events,
    maxNoteLen: Math.ceil(secPerBar * 2 * SR) + Math.ceil(2 * SR),
  }

  if (planCache.size > 48) {
    const first = planCache.keys().next().value
    if (first) planCache.delete(first)
  }
  planCache.set(cacheKey, plan)
  return plan
}

/** Pad events carry multiple freqs as a comma-joined string — parse them. */
export function padFreqs(e: NoteEvent): number[] {
  return String(e.freq).split(',').map(Number).filter((n) => isFinite(n) && n > 0)
}
