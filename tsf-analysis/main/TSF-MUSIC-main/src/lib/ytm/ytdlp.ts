/**
 * TSF Music — yt-dlp subprocess provider
 *
 * THE MOST MAINTAINED YouTube extractor on Earth, invoked as a subprocess.
 * Handles SABR / PO tokens / JS challenges / client rotation itself and is
 * updated daily. On a residential IP this resolves FULL-LENGTH official
 * audio for international tracks (verified on the user's Mac:
 * "Blank Space" → googlevideo dur=231.826s clen=3753890 audio/mp4).
 *
 * SECURITY (adversarial-critic hardened):
 *   - argv-array spawn, NEVER a shell string — no injection surface.
 *   - videoId is regex-gated (^[a-zA-Z0-9_-]{10,12}$) before it ever reaches
 *     the argv. The URL is constructed server-side.
 *   - --ignore-config so a stray user ~/.config/yt-dlp/config can't inject
 *     arbitrary flags.
 *   - stdout is parsed as JSON and only the selected format's URL is used;
 *     HLS (m3u8) manifests are rejected (the byte proxy needs a plain
 *     progressive URL).
 *
 * RETRY STRATEGY (per-video bot-wall variance):
 *   Attempt 1: yt-dlp defaults (visionos + web clients, PO-token machinery).
 *   Attempt 2 (only on failure): explicit fallback client list
 *   `youtube:player_client=tv_embedded,mweb,web_safari` — a different
 *   failure domain, recovers a meaningful share of per-video walls.
 *
 * CONCURRENCY: at most 2 subprocesses at once (semaphore) so a burst of
 * track switches can't fork-bomb the machine.
 */

import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import type { StreamResult } from './stream'

const RESOLVE_TIMEOUT_MS = 25_000
const SPAWN_MAX_CONCURRENT = 2
const BINARY_PROBE_TTL_MS = 10 * 60 * 1000

const CANDIDATE_PATHS = [
  '/usr/local/bin/yt-dlp',
  '/opt/homebrew/bin/yt-dlp',
  '/usr/bin/yt-dlp',
  '/usr/local/bin/youtube-dl',
  '/opt/homebrew/bin/youtube-dl',
]

export const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{10,12}$/

// globalThis singleton: binary discovery cache (also survives Turbopack's
// per-route module graphs in dev)
interface YtDlpBinary {
  path: string
  version: string
}
function binaryCache(): { at: number; value: YtDlpBinary | null } | undefined {
  const g = globalThis as unknown as { __tsfYtDlpBinary?: { at: number; value: YtDlpBinary | null } }
  return g.__tsfYtDlpBinary
}
function setBinaryCache(value: YtDlpBinary | null) {
  ;(globalThis as unknown as { __tsfYtDlpBinary?: { at: number; value: YtDlpBinary | null } }).__tsfYtDlpBinary = {
    at: Date.now(),
    value,
  }
}

function whichFromPath(): string | null {
  const pathVar = process.env.PATH || ''
  for (const dir of pathVar.split(':')) {
    if (!dir) continue
    try {
      const full = `${dir.replace(/\/$/, '')}/yt-dlp`
      if (statSync(full).isFile()) return full
    } catch {
      /* not present in this dir */
    }
  }
  return null
}

function probeBinary(path: string): Promise<YtDlpBinary | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn(path, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(null)
      }, 4000)
      child.stdout.on('data', (d) => (out += String(d)))
      child.on('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const version = out.trim().split('\n')[0] || ''
        resolve(code === 0 && /^\d{4}\./.test(version) ? { path, version } : null)
      })
    } catch {
      resolve(null)
    }
  })
}

export async function ytDlpBinary(): Promise<YtDlpBinary | null> {
  const cached = binaryCache()
  if (cached && Date.now() - cached.at < BINARY_PROBE_TTL_MS) return cached.value
  for (const p of CANDIDATE_PATHS) {
    const found = await probeBinary(p)
    if (found) {
      setBinaryCache(found)
      return found
    }
  }
  const fromPath = whichFromPath()
  if (fromPath) {
    const found = await probeBinary(fromPath)
    if (found) {
      setBinaryCache(found)
      return found
    }
  }
  setBinaryCache(null)
  return null
}

export async function ytDlpStatus(): Promise<{
  available: boolean
  path?: string
  version?: string
}> {
  const bin = await ytDlpBinary()
  return bin ? { available: true, path: bin.path, version: bin.version } : { available: false }
}

// ---------- concurrency semaphore ----------

let running = 0
const waiters: Array<() => void> = []

async function acquire(): Promise<() => void> {
  if (running < SPAWN_MAX_CONCURRENT) {
    running++
    return () => release()
  }
  await new Promise<void>((resolve) => waiters.push(resolve))
  running++
  return () => release()
}

function release() {
  running--
  const next = waiters.shift()
  if (next) next()
}

// ---------- subprocess resolve ----------

function runYtDlp(
  binPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve({ code: -1, stdout, stderr: stderr || 'timeout' })
      }, timeoutMs)
      child.stdout.on('data', (d) => {
        stdout += String(d)
        if (stdout.length > 20_000_000) child.kill('SIGKILL') // 20MB of JSON is beyond sane
      })
      child.stderr.on('data', (d) => (stderr += String(d)))
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ code: -1, stdout, stderr: String(e) })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? -1, stdout, stderr })
      })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e) })
    }
  })
}

interface FormatInfo {
  url?: string
  protocol?: string
  ext?: string
  acodec?: string
  vcodec?: string
  abr?: number
  tbr?: number
  audio_ext?: string
  format_id?: string
  filesize?: number
}

/** Pick the best progressive http audio-only format from a yt-dlp JSON dump. */
function pickAudioFormat(j: any): FormatInfo | null {
  const formats: FormatInfo[] = Array.isArray(j?.formats) ? j.formats : []
  const audioOnly = formats.filter(
    (f) =>
      f.url &&
      f.protocol &&
      /^https?/.test(f.protocol) &&
      (f.vcodec === 'none' || f.audio_ext !== 'none') &&
      f.vcodec === 'none', // audio-only; never muxed video (ads live in video streams)
  )
  const rank = (f: FormatInfo) => (f.ext === 'm4a' ? 2 : f.ext === 'webm' ? 1 : 0)
  audioOnly.sort((a, b) => rank(b) - rank(a) || (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))
  return audioOnly[0] ?? null
}

function computeExpiry(url: string, fallbackMs: number): number {
  const fallback = Date.now() + fallbackMs
  try {
    const exp = parseInt(new URL(url).searchParams.get('expire') || '', 10)
    if (Number.isFinite(exp) && exp > Date.now() / 1000) {
      return Math.max(Date.now() + 30_000, Math.min(fallback, (exp - 120) * 1000))
    }
  } catch {
    /* keep default */
  }
  return fallback
}

const BASE_ARGS = [
  '--ignore-config',
  '--no-warnings',
  '--no-playlist',
  '--no-progress',
  '--socket-timeout',
  '8',
  '-f',
  'bestaudio[protocol^=http][ext=m4a]/bestaudio[protocol^=http]/bestaudio',
  '-J',
]

export async function resolveYtDlp(videoId: string): Promise<StreamResult | null> {
  if (!VIDEO_ID_RE.test(videoId)) return null
  const bin = await ytDlpBinary()
  if (!bin) return null

  const release = await acquire()
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`

    // Attempt 1 — current yt-dlp defaults (visionos + web + PO-token machinery)
    let run = await runYtDlp(bin.path, [...BASE_ARGS, watchUrl], RESOLVE_TIMEOUT_MS)

    // Attempt 2 — different client failure domain (per-video bot-wall variance)
    if (run.code !== 0 || !run.stdout.trim()) {
      run = await runYtDlp(
        bin.path,
        [...BASE_ARGS, '--extractor-args', 'youtube:player_client=tv_embedded,mweb,web_safari', watchUrl],
        RESOLVE_TIMEOUT_MS,
      )
    }

    if (run.code !== 0 || !run.stdout.trim()) return null
    let j: any
    try {
      j = JSON.parse(run.stdout)
    } catch {
      return null
    }

    const fmt = pickAudioFormat(j)
    const url = fmt?.url || (typeof j?.url === 'string' && /^https?:\/\//.test(j.url) ? j.url : '')
    if (!url) return null
    // Never hand out HLS manifests — the byte proxy needs a progressive URL.
    if (/m3u8/i.test(url) || (fmt?.protocol && !/^https?$/.test(fmt.protocol))) return null

    return {
      url,
      provider: 'yt-dlp',
      bitrate: Math.round((fmt?.abr ?? fmt?.tbr ?? 128) * 1000) || 128000,
      expiresAt: computeExpiry(url, 6 * 60 * 60 * 1000),
      mime: fmt?.ext === 'webm' ? 'audio/webm' : 'audio/mp4',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    }
  } finally {
    release()
  }
}
