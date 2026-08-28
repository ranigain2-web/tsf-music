/**
 * TSF Music — Synth Renderer
 *
 * Renders a SongPlan into 16-bit mono PCM WAV bytes.
 *
 * KEY DESIGN: every oscillator/noise source is a PURE FUNCTION of the
 * absolute sample index. That means any byte range of the track can be
 * rendered on demand — enabling HTTP Range seeking, progressive streaming
 * (ReadableStream pull-chunks), and perfect determinism across requests.
 *
 * Instruments (all synthesized, no samples):
 *   kick   — pitch-swept sine (closed-form phase integral) + click
 *   snare  — 186Hz tone + high-passed deterministic noise
 *   hat/ohat — high-passed deterministic noise, fast/slow decay
 *   clap   — 3 delayed noise bursts
 *   bass   — additive harmonics w/ brightness param
 *   pad    — detuned sine pairs per chord tone w/ slow drift LFO
 *   arp    — fast-decaying harmonic "pluck"
 *   pluck  — slow pluck w/ echo taps
 *   lead   — detuned pair + vibrato (closed-form) + echo taps + brightness
 *   riser  — noise swell into the chorus
 *
 * Master: gentle soft-clip saturation, 8ms fade-in, 2.5s fade-out.
 */

import { SongPlan, NoteEvent, SR, padFreqs } from './arrangement'

// ---------- wavetable sine (fast, linear-interpolated) ----------

const TABLE_SIZE = 4096
const SIN = new Float64Array(TABLE_SIZE + 1)
for (let i = 0; i <= TABLE_SIZE; i++) SIN[i] = Math.sin((2 * Math.PI * i) / TABLE_SIZE)

/** phase in CYCLES (phase 1.0 == 2π) */
function wt(phase: number): number {
  const p = phase - Math.floor(phase)
  const x = p * TABLE_SIZE
  const i0 = x | 0
  const frac = x - i0
  return SIN[i0] + (SIN[i0 + 1] - SIN[i0]) * frac
}

// ---------- deterministic noise (pure function of integer index) ----------

function noiseAt(i: number, seed: number): number {
  let z = (i + seed) | 0
  z = Math.imul(z ^ (z >>> 16), 0x2c1b3c6d) | 0
  z = Math.imul(z ^ (z >>> 13), 0x297a2d39) | 0
  z ^= z >>> 16
  return ((z >>> 0) / 4294967296) * 2 - 1 // -1..1
}

// ---------- WAV encoding ----------

export function wavTotalBytes(plan: SongPlan): number {
  return 44 + plan.totalSamples * 2
}

export function makeWavHeader(totalBytes: number): Uint8Array {
  const h = new Uint8Array(44)
  const dv = new DataView(h.buffer)
  const w = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i))
  }
  const dataBytes = totalBytes - 44
  w(0, 'RIFF')
  dv.setUint32(4, 36 + dataBytes, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true) // PCM
  dv.setUint16(22, 1, true) // mono
  dv.setUint32(24, SR, true)
  dv.setUint32(28, SR * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  w(36, 'data')
  dv.setUint32(40, dataBytes, true)
  return h
}

function toInt16(s: number): number {
  const c = s < -1 ? -1 : s > 1 ? 1 : s
  return c < 0 ? c * 0x8000 : c * 0x7fff
}

// ---------- per-instrument signal generators ----------
// All take t (seconds since note start) and absolute sample index i.
// Echo instruments internally add delayed copies (still closed-form).

const TWO_PI = 2 * Math.PI

function sigKick(t: number, i: number, e: NoteEvent, seed: number): number {
  const k = 26
  const fEnd = 44
  const fSpan = 108
  // closed-form phase integral of f(t) = fEnd + fSpan*e^(-kt)
  const phase = fEnd * t + (fSpan * (1 - Math.exp(-t * k))) / k
  const amp = Math.exp(-t * 7.5)
  const click = t < 0.02 ? noiseAt(i, seed) * Math.exp(-t * 160) * 0.35 : 0
  return (wt(phase) * amp + click) * e.vel * 1.05
}

function sigSnare(t: number, i: number, e: NoteEvent, seed: number): number {
  const tone = wt(186 * t) * Math.exp(-t * 24) * 0.55 + wt(372 * t) * Math.exp(-t * 30) * 0.2
  const hp = (noiseAt(i, seed) - noiseAt(i - 1, seed)) * 0.5
  const nz = hp * Math.exp(-t * 17) * 0.9
  return (tone + nz) * e.vel * 0.8
}

function sigHat(t: number, i: number, e: NoteEvent, seed: number, open: boolean): number {
  const hp = (noiseAt(i, seed) - noiseAt(i - 1, seed)) * 1.6
  const amp = open ? Math.exp(-t * 11) : Math.exp(-t * 75)
  return hp * amp * e.vel * 0.42
}

const CLAP_BURSTS = [0, 0.012, 0.026]

function sigClap(t: number, i: number, e: NoteEvent, seed: number): number {
  let s = 0
  for (let b = 0; b < CLAP_BURSTS.length; b++) {
    const bt = t - CLAP_BURSTS[b]
    if (bt < 0) continue
    const ib = Math.round((i - bt * SR) | 0)
    const hp = (noiseAt(ib, seed) - noiseAt(ib - 1, seed)) * 0.6
    const decay = b === CLAP_BURSTS.length - 1 ? 12 : 30
    s += hp * Math.exp(-bt * decay)
  }
  return s * e.vel * 0.7
}

function sigBass(t: number, e: NoteEvent): number {
  const f = e.freq as number
  const x = e.x
  const lenSec = e.len / SR
  const rel = t < lenSec ? 1 : Math.exp(-(t - lenSec) * 18)
  const env = Math.min(1, t / 0.006) * (0.45 + 0.55 * Math.exp(-t * 2.2)) * rel
  const sig =
    wt(f * t) +
    wt(2 * f * t) * 0.5 * x +
    wt(3 * f * t) * 0.28 * x +
    wt(4 * f * t) * 0.16 * x * x +
    wt(5 * f * t) * 0.09 * x * x
  return sig * env * e.vel * 0.5
}

function sigPad(t: number, e: NoteEvent): number {
  const freqs = padFreqs(e)
  const lenSec = e.len / SR
  const attack = Math.min(1.5, lenSec * 0.4)
  const rel = t < lenSec ? 1 : Math.exp(-(t - lenSec) * 4)
  const env = Math.min(1, t / attack) * rel
  const drift = 0.0018
  const driftW = TWO_PI * 0.55
  let s = 0
  for (let v = 0; v < freqs.length; v++) {
    const f = freqs[v]
    const ph = f * (t + (drift * (1 - Math.cos(driftW * t))) / driftW)
    s += wt(ph * 1.0026) + wt(ph * 0.9974 + 0.37)
  }
  return (s * env * e.vel * 0.4) / freqs.length
}

function sigArp(t: number, e: NoteEvent): number {
  const f = e.freq as number
  const env = Math.min(1, t / 0.002) * Math.exp(-t * 5)
  const sig =
    wt(f * t) +
    wt(2 * f * t) * 0.5 * Math.exp(-t * 6) +
    wt(3 * f * t) * 0.25 * Math.exp(-t * 13) +
    wt(4 * f * t) * 0.12 * Math.exp(-t * 21)
  return sig * env * e.vel * 0.42
}

function pluckCore(t: number, e: NoteEvent): number {
  const f = e.freq as number
  const sig =
    wt(f * t) * Math.exp(-t * 2.2) +
    wt(2 * f * t) * 0.5 * Math.exp(-t * 5) +
    wt(3 * f * t) * 0.25 * Math.exp(-t * 9) +
    wt(4 * f * t) * 0.12 * Math.exp(-t * 14)
  return sig * Math.min(1, t / 0.003) * e.vel * 0.4
}

function sigPluck(t: number, e: NoteEvent): number {
  let s = 0
  if (t >= 0) s += pluckCore(t, e)
  if (t >= 0.18) s += pluckCore(t - 0.18, e) * 0.4
  if (t >= 0.36) s += pluckCore(t - 0.36, e) * 0.22
  if (t >= 0.54) s += pluckCore(t - 0.54, e) * 0.12
  return s
}

function leadCore(t: number, e: NoteEvent): number {
  const f = e.freq as number
  const x = e.x
  const vibW = TWO_PI * 5.5
  const vib = (0.004 * (1 - Math.cos(vibW * t))) / vibW
  const p = f * (t + vib)
  const sig =
    0.6 * wt(p) +
    0.4 * wt(f * 1.0045 * (t + vib) + 0.31) +
    x * 0.3 * wt(2 * p) +
    x * 0.12 * wt(3 * p)
  const lenSec = e.len / SR
  const rel = t < lenSec ? 1 : Math.exp(-(t - lenSec) * 14)
  const env = Math.min(1, t / 0.012) * (0.78 + 0.22 * Math.exp(-t * 1.5)) * rel
  return sig * env * e.vel * 0.5
}

function sigLead(t: number, e: NoteEvent): number {
  let s = 0
  if (t >= 0) s += leadCore(t, e)
  if (t >= 0.17) s += leadCore(t - 0.17, e) * 0.32
  if (t >= 0.34) s += leadCore(t - 0.34, e) * 0.17
  if (t >= 0.51) s += leadCore(t - 0.51, e) * 0.09
  return s
}

function sigRiser(t: number, i: number, e: NoteEvent, seed: number): number {
  const T = e.len / SR
  const prog = t / T
  const amp = Math.pow(prog, 2.2) * e.vel
  const hp = (noiseAt(i, seed) - noiseAt(i - 1, seed)) * 0.7
  return hp * amp * 0.55
}

// ---------- master chain ----------

function master(sample: number, gain: number): number {
  // gentle saturation soft-clip
  const y = sample / (1 + Math.abs(sample) * 0.55)
  const g = y * gain
  return g > 0.995 ? 0.995 : g < -0.995 ? -0.995 : g
}

// ---------- range rendering ----------

const ECHO_TAIL_SAMPLES = Math.floor(0.6 * SR)
const FADE_IN = Math.floor(0.008 * SR)
const FADE_OUT = Math.floor(2.5 * SR)

/** Render PCM samples [fromSample, fromSample+count) into a Float32Array. */
export function renderSamples(plan: SongPlan, fromSample: number, count: number): Float32Array {
  const out = new Float32Array(count)
  const total = plan.totalSamples
  const from = Math.max(0, fromSample)
  const end = Math.min(from + count, total)
  if (end <= from) return out

  const ev = plan.events
  const scanBack = plan.maxNoteLen + ECHO_TAIL_SAMPLES

  // upper bound: first event with start >= end (binary search)
  let lo = 0
  let hi = ev.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ev[mid].start < end) lo = mid + 1
    else hi = mid
  }

  const seed = 0
  const fadeOutStart = total - FADE_OUT

  for (let k = lo - 1; k >= 0; k--) {
    const e = ev[k]
    if (e.start <= from - scanBack) break
    const eEnd = e.start + e.len + (e.inst === 'lead' || e.inst === 'pluck' ? ECHO_TAIL_SAMPLES : 0)
    if (eEnd <= from) continue

    const iStart = Math.max(from, e.start)
    const iEnd = Math.min(end, eEnd)
    if (iStart >= iEnd) continue

    for (let i = iStart; i < iEnd; i++) {
      const t = (i - e.start) / SR
      let v = 0
      switch (e.inst) {
        case 'kick': v = sigKick(t, i, e, seed); break
        case 'snare': v = sigSnare(t, i, e, seed); break
        case 'hat': v = sigHat(t, i, e, seed, false); break
        case 'ohat': v = sigHat(t, i, e, seed, true); break
        case 'clap': v = sigClap(t, i, e, seed); break
        case 'bass': v = sigBass(t, e); break
        case 'pad': v = sigPad(t, e); break
        case 'arp': v = sigArp(t, e); break
        case 'pluck': v = sigPluck(t, e); break
        case 'lead': v = sigLead(t, e); break
        case 'riser': v = sigRiser(t, i, e, seed); break
      }
      out[i - from] += v
    }
  }

  // master chain + fades
  for (let i = from; i < end; i++) {
    let s = master(out[i - from], plan.masterGain)
    if (i < FADE_IN) s *= i / FADE_IN
    if (i >= fadeOutStart) s *= (total - i) / FADE_OUT
    out[i - from] = s
  }
  return out
}

/** Render an arbitrary byte range of the WAV file (header-aware, odd-byte safe). */
export function renderWavBytes(plan: SongPlan, byteStart: number, byteCount: number): Uint8Array {
  const total = wavTotalBytes(plan)
  const start = Math.max(0, byteStart)
  const end = Math.min(total, start + byteCount) // exclusive
  const out = new Uint8Array(Math.max(0, end - start))
  if (end <= start) return out

  const header = start < 44 ? makeWavHeader(total) : null

  // sample range covering the requested bytes
  const s0 = Math.max(0, Math.floor((start - 44) / 2))
  const s1 = Math.min(plan.totalSamples, Math.ceil((end - 44) / 2))
  const pcm = s1 > s0 ? renderSamples(plan, s0, s1 - s0) : null

  for (let b = start; b < end; b++) {
    if (b < 44) {
      out[b - start] = header![b]
    } else {
      const rel = b - 44
      const sampleIdx = rel >> 1
      const high = rel & 1
      const v = pcm ? pcm[sampleIdx - s0] : 0
      const n = toInt16(v)
      out[b - start] = high ? (n >> 8) & 0xff : n & 0xff
    }
  }
  return out
}

// ---------- HTTP streaming ----------

const CHUNK_BYTES = 192 * 1024 // 96k samples per pull — ~15ms render

export interface SynthRange {
  start: number
  end: number // inclusive
  isRange: boolean
}

export function parseRange(req: Request, total: number): SynthRange {
  const range = req.headers.get('range')
  if (!range) return { start: 0, end: total - 1, isRange: false }
  const m = range.match(/bytes=(\d*)-(\d*)/)
  if (!m) return { start: 0, end: total - 1, isRange: false }
  const s = m[1] ? parseInt(m[1], 10) : 0
  const e = m[2] ? parseInt(m[2], 10) : total - 1
  if (s <= e && s < total) {
    return { start: s, end: Math.min(e, total - 1), isRange: true }
  }
  return { start: 0, end: total - 1, isRange: false }
}

/**
 * Build the HTTP Response for a synth track: pull-based ReadableStream
 * that renders 192KB chunks on demand. If the client aborts (browser
 * buffer full), rendering stops — no wasted CPU.
 */
export function synthStreamResponse(plan: SongPlan, req: Request, opts: { head?: boolean } = {}): Response {
  const total = wavTotalBytes(plan)
  const { start, end, isRange } = parseRange(req, total)

  const headers = new Headers()
  headers.set('Content-Type', 'audio/wav')
  headers.set('Accept-Ranges', 'bytes')
  headers.set('X-Stream-Provider', 'tsf-synth')
  headers.set('X-Synth-Genre', plan.genre)
  headers.set('X-Synth-Bpm', String(plan.bpm))
  headers.set('Cache-Control', 'public, max-age=1800')
  headers.set('Access-Control-Allow-Origin', '*')
  if (opts.head) {
    headers.set('Content-Length', '0')
    if (isRange) {
      headers.set('Content-Range', `bytes ${start}-${end}/${total}`)
      return new Response(null, { status: 206, headers })
    }
    headers.set('Content-Length', String(total))
    return new Response(null, { status: 200, headers })
  }

  const outLen = end - start + 1
  headers.set('Content-Length', String(outLen))
  if (isRange) {
    headers.set('Content-Range', `bytes ${start}-${end}/${total}`)
  }

  let pos = start
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pos > end) {
        controller.close()
        return
      }
      const len = Math.min(CHUNK_BYTES, end - pos + 1)
      try {
        const chunk = renderWavBytes(plan, pos, len)
        controller.enqueue(chunk)
        pos += len
      } catch (err) {
        controller.error(err)
      }
    },
  })

  return new Response(stream, { status: isRange ? 206 : 200, headers })
}
