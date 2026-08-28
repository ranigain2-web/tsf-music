/**
 * TSF Music — /api/stream/demo
 * Deterministic pleasant melody generator (dev fallback when all providers
 * are unreachable). Generates a WAV rendered from the videoId hash.
 *
 * HARDENED: supports Range requests properly (206), uses a clearly audible
 * melody, sets CORS + Content-Length + Accept-Ranges so the <audio> element
 * can seek and play cleanly.
 */
import { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const SAMPLE_RATE = 44100
const NOTE_DUR = 0.45 // seconds per note
const NOTES = 32 // ~14s loopable melody

// A minor-pentatonic-ish pleasant scale (Hz)
const SCALE = [196.0, 220.0, 246.94, 261.63, 293.66, 329.63, 392.0, 440.0]

// Bass note underneath (one per bar of 4 notes)
const BASS = [98.0, 110.0, 130.81, 146.83]

function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Build a 16-bit mono PCM buffer once per videoId (cached in-process). */
function buildPcm(videoId: string): Float32Array {
  const totalSamples = Math.floor(SAMPLE_RATE * NOTE_DUR * NOTES)
  const rand = mulberry32(hashSeed(videoId))

  // melody: melodic line
  const melody: number[] = []
  for (let i = 0; i < NOTES; i++) {
    // restrict first 4 notes to lower part for a sense of "intro"
    const pool = i < 4 ? SCALE.slice(0, 5) : SCALE
    melody.push(pool[Math.floor(rand() * pool.length)])
  }

  const pcm = new Float32Array(totalSamples)
  const noteSamples = Math.floor(SAMPLE_RATE * NOTE_DUR)
  for (let i = 0; i < NOTES; i++) {
    const f = melody[i]
    const start = i * noteSamples
    const bassFreq = BASS[Math.floor(i / 4) % BASS.length]

    for (let j = 0; j < noteSamples && start + j < totalSamples; j++) {
      const t = j / SAMPLE_RATE
      const noteT = j / SAMPLE_RATE
      // smooth envelope — attack 30ms, decay, sustain, soft release at end
      const attack = Math.min(1, noteT * 33)
      const release = j < noteSamples - Math.floor(SAMPLE_RATE * 0.05)
        ? 1
        : Math.max(0, (noteSamples - j) / Math.floor(SAMPLE_RATE * 0.05))
      const env = attack * release

      // melody: sine + soft 2nd harmonic + fundamental fifth
      const melodyV =
        Math.sin(2 * Math.PI * f * t) * 0.55 +
        Math.sin(2 * Math.PI * f * 2 * t) * 0.12 +
        Math.sin(2 * Math.PI * f * 0.5 * t) * 0.18

      // bass: triangle-ish (sine fundamental + soft 3rd harmonic)
      const bassV =
        Math.sin(2 * Math.PI * bassFreq * t) * 0.32 +
        Math.sin(2 * Math.PI * bassFreq * 3 * t) * 0.06

      pcm[start + j] = (melodyV + bassV) * env * 0.55
    }
  }

  // soft clipper to avoid any harsh peaks
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i]
    pcm[i] = s > 0.95 ? 0.95 + (s - 0.95) * 0.3 : s < -0.95 ? -0.95 - (-0.95 - s) * 0.3 : s
  }
  return pcm
}

const pcmCache = new Map<string, Float32Array>()
function getPcm(videoId: string): Float32Array {
  let p = pcmCache.get(videoId)
  if (!p) {
    p = buildPcm(videoId)
    if (pcmCache.size > 256) pcmCache.clear()
    pcmCache.set(videoId, p)
  }
  return p
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const videoId = searchParams.get('id') || 'tsf'
  const range = req.headers.get('range')

  const pcm = getPcm(videoId)
  const totalSamples = pcm.length
  const dataBytes = totalSamples * 2
  const totalBytes = 44 + dataBytes

  // Parse Range header (e.g. "bytes=0-1", "bytes=0-", "bytes=123-")
  let start = 0
  let end = totalBytes - 1
  let isRange = false
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/)
    if (m) {
      const s = m[1] ? parseInt(m[1], 10) : 0
      const e = m[2] ? parseInt(m[2], 10) : totalBytes - 1
      if (s <= e && s < totalBytes) {
        start = s
        end = Math.min(e, totalBytes - 1)
        isRange = true
      }
    }
  }

  const outLen = end - start + 1
  const out = new Uint8Array(outLen)

  // header (if included in the requested range)
  if (start < 44) {
    const headerBytes = Math.min(outLen, 44 - start)
    writeHeaderTo(out.subarray(0, headerBytes), totalBytes, start, headerBytes)
  }

  // data (if included)
  const dataStartSrc = Math.max(0, start - 44)
  const dataEndSrc = Math.min(dataBytes - 1, end - 44)
  if (dataEndSrc >= dataStartSrc) {
    const dstStart = Math.max(0, 44 - start)
    for (let i = 0; i <= dataEndSrc - dataStartSrc; i++) {
      // Each sample is 2 bytes; sample index n occupies bytes 44+2n, 44+2n+1
      const sampleIdx = (dataStartSrc + i) >> 1
      const byteInSample = (dataStartSrc + i) & 1
      // Sign: little-endian. Low byte first, then high byte.
      if (byteInSample === 0) {
        // low byte
        out[dstStart + i] = (toInt16(pcm[sampleIdx]) & 0xff)
      } else {
        out[dstStart + i] = ((toInt16(pcm[sampleIdx]) >> 8) & 0xff)
      }
    }
  }

  const headers = new Headers()
  headers.set('Content-Type', 'audio/wav')
  headers.set('Content-Length', String(outLen))
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Stream-Provider', 'demo-tone')
  headers.set('Access-Control-Allow-Origin', '*')
  if (isRange) {
    headers.set('Content-Range', `bytes ${start}-${end}/${totalBytes}`)
    return new Response(out, { status: 206, headers })
  }
  return new Response(out, { status: 200, headers })
}

function toInt16(sample: number): number {
  const s = Math.max(-1, Math.min(1, sample))
  return s < 0 ? Math.floor(s * 0x8000) : Math.floor(s * 0x7fff)
}

function writeHeaderTo(buf: Uint8Array, totalBytes: number, startByte: number, len: number) {
  const header = new Uint8Array(44)
  const dv = new DataView(header.buffer)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i))
  }
  const dataBytes = totalBytes - 44
  writeStr(0, 'RIFF')
  dv.setUint32(4, 36 + dataBytes, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, SAMPLE_RATE, true)
  dv.setUint32(28, SAMPLE_RATE * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  writeStr(36, 'data')
  dv.setUint32(40, dataBytes, true)

  for (let i = 0; i < len; i++) {
    buf[i] = header[startByte + i]
  }
}
