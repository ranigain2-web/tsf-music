/**
 * TSF Music — incremental JSON extraction for streaming LLM output.
 *
 * As the model streams a playlist JSON object, this extractor pulls out:
 *   - `title` / `description` the moment their string closes, and
 *   - each complete song seed object (`{"q": "...", "r": "..."}`) the moment
 *     its closing brace arrives.
 *
 * Tolerant of: markdown fences, newlines, spaces after colons, escaped
 * quotes inside strings, trailing commas, and surrounding prose.
 *
 * This is what turns "10 seconds of spinner" into "tracks popping in live".
 */

export interface SongSeed {
  q: string
  r: string
}

export interface PartialExtract {
  title: string
  description: string
  songs: SongSeed[] // newly completed songs since last push
}

interface ExtractorState {
  buf: string
  scanned: number // how far we've scanned for song objects (index into buf)
  titleDone: boolean
  descDone: boolean
}

export function createExtractor() {
  const st: ExtractorState = { buf: '', scanned: 0, titleDone: false, descDone: false }

  /** Extract a JSON string value for `key` from the buffer (complete strings only). */
  function jsonStringAt(key: string): string | null {
    // find "key" : "....."  with a CLOSED string (ends with unescaped ")
    const re = new RegExp(`"${key}"\\s*:\\s*"`)
    const m = re.exec(st.buf)
    if (!m) return null
    let i = m.index + m[0].length
    let out = ''
    while (i < st.buf.length) {
      const c = st.buf[i]
      if (c === '\\') {
        const nxt = st.buf[i + 1]
        if (nxt === undefined) return null // incomplete escape
        out += nxt === 'n' ? '\n' : nxt === 't' ? '\t' : nxt === '"' ? '"' : nxt === '\\' ? '\\' : nxt === '/' ? '/' : nxt === 'u' ? 'u' : nxt
        i += 2
        continue
      }
      if (c === '"') return out // closed
      out += c
      i++
    }
    return null // string not closed yet
  }

  /**
   * Locate the start of the songs array contents ("songs" : [ ... ]).
   * Returns null until the opening bracket has streamed in. Re-run per push
   * (positions are relative to the current buffer).
   */
  function songsArrayStart(): number | null {
    const m = /"\s*songs\s*"\s*:\s*\[/.exec(st.buf)
    return m ? m.index + m[0].length : null
  }

  /**
   * Scan for the next complete song object at/after `from` INSIDE the songs
   * array. Objects in our schema are flat (no nesting), so we walk to the
   * first matching close brace while respecting string escaping.
   */
  function nextSongFrom(from: number): { end: number; seed: SongSeed | null } | null {
    const start = st.buf.indexOf('{', from)
    if (start < 0) return null
    let i = start
    let inStr = false
    let raw = ''
    while (i < st.buf.length) {
      const c = st.buf[i]
      if (inStr) {
        if (c === '\\') {
          raw += c + (st.buf[i + 1] ?? '')
          if (i + 1 >= st.buf.length) return null // incomplete escape at buffer end
          i += 2
          continue
        }
        if (c === '"') inStr = false
        raw += c
        i++
        continue
      }
      if (c === '"') {
        inStr = true
        raw += c
        i++
        continue
      }
      if (c === '{' && raw.length > 0) {
        // nested object inside a song — not in our schema; skip this candidate
        // by scanning past its close brace so we don't mis-parse.
        let depth = 1
        let j = i
        let inS = false
        while (j < st.buf.length && depth > 0) {
          const cj = st.buf[j]
          if (inS) {
            if (cj === '\\') { j += 2; continue }
            if (cj === '"') inS = false
          } else {
            if (cj === '"') inS = true
            else if (cj === '{') depth++
            else if (cj === '}') depth--
          }
          j++
        }
        if (depth > 0) return null // nested object not closed yet
        return { end: j, seed: parseSeed(raw + st.buf.slice(start + raw.length, j)) }
      }
      if (c === '}') {
        raw += c
        return { end: i + 1, seed: parseSeed(raw) }
      }
      raw += c
      i++
    }
    return null // not closed yet
  }

  function parseSeed(rawObj: string): SongSeed | null {
    if (!/"\s*q\s*"/.test(rawObj)) return null
    let q = extractJsonStr(rawObj, 'q')
    let r = extractJsonStr(rawObj, 'r') ?? extractJsonStr(rawObj, 'reason') ?? ''
    if (!q) return null
    q = q.replace(/\s+/g, ' ').trim().slice(0, 90)
    r = r.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (q.length < 2) return null
    return { q, r }
  }

  function extractJsonStr(obj: string, key: string): string | null {
    const re = new RegExp(`"${key}"\\s*:\\s*"`)
    const m = re.exec(obj)
    if (!m) return null
    let i = m.index + m[0].length
    let out = ''
    while (i < obj.length) {
      const c = obj[i]
      if (c === '\\') {
        const nxt = obj[i + 1]
        out += nxt === 'n' ? '\n' : nxt === 't' ? '\t' : nxt
        i += 2
        continue
      }
      if (c === '"') return out
      out += c
      i++
    }
    return null
  }

  return {
    push(delta: string): PartialExtract {
      st.buf += delta
      // keep the buffer bounded: drop consumed head (title/desc extraction uses
      // the head only until found; song scanning is monotonic)
      const out: PartialExtract = { title: '', description: '', songs: [] }

      if (!st.titleDone) {
        const t = jsonStringAt('title')
        if (t !== null) {
          st.titleDone = true
          out.title = t
        }
      }
      if (!st.descDone) {
        const d = jsonStringAt('description')
        if (d !== null) {
          st.descDone = true
          out.description = d
        }
      }

      // scan for newly completed song objects — ONLY inside the songs array
      const arrStart = songsArrayStart()
      if (arrStart !== null) {
        if (st.scanned < arrStart) st.scanned = arrStart
        for (;;) {
          const found = nextSongFrom(st.scanned)
          if (!found) break
          st.scanned = found.end
          if (found.seed) out.songs.push(found.seed)
          if (st.scanned > 512 * 1024) break
        }
      }

      // trim consumed buffer (keep last 4KB of tail for in-flight strings)
      if (st.titleDone && st.descDone && st.scanned > 4096) {
        st.buf = st.buf.slice(st.scanned - 1024)
        st.scanned = 1024
      }
      return out
    },
    /** Final flush: full buffered text (for fallback full-JSON parse). */
    text(): string {
      return st.buf
    },
  }
}

/**
 * Tolerant full-JSON parse (non-streaming path / final validation).
 * Handles fences, prose around JSON, single quotes (rare), trailing commas.
 */
export function parseTolerantJson<T = any>(raw: string): T | null {
  if (!raw) return null
  let s = raw.trim()
  // strip fences
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```\s*$/i, '')
  // direct try
  try {
    return JSON.parse(s) as T
  } catch { /* continue */ }
  // find outermost { ... }
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) {
    const cut = s.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1')
    try {
      return JSON.parse(cut) as T
    } catch { /* continue */ }
  }
  return null
}
