/**
 * TSF Music — client-side dominant color extraction (Spotify signature)
 *
 * Extracts the dominant saturated color from album artwork so the lyrics
 * screen can wear it as its background (Spotify mobile anatomy BAR-B §2.6:
 * "background = dominant color extracted from album art").
 *
 * Algorithm: downscale to 24×24 canvas, HSV-score every pixel
 * (saturation² × brightness-window), bucket by hue, pick the winning
 * bucket, average it, and darken slightly so white text stays readable.
 * Results are cached per image URL for the session.
 */

const cache = new Map<string, string>()

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : d / max
  return [h, s, max]
}

export async function dominantColor(src: string): Promise<string | null> {
  if (cache.has(src)) return cache.get(src)!
  if (typeof window === 'undefined' || !src || src.startsWith('/')) return null
  try {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.referrerPolicy = 'no-referrer'
    img.src = src
    await img.decode()
    const N = 24
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = N
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, N, N)
    const { data } = ctx.getImageData(0, 0, N, N)

    // hue buckets (24 × 15°)
    const buckets = new Map<number, { r: number; g: number; b: number; score: number; n: number }>()
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const a = data[i + 3]
      if (a < 128) continue
      const [h, s, v] = rgbToHsv(r, g, b)
      if (v < 0.1) continue // near-black
      if (s < 0.15) continue // near-gray
      const weight = s * s * (1 - Math.abs(v - 0.55))
      const bucket = Math.floor(h / 15) % 24
      const cur = buckets.get(bucket) || { r: 0, g: 0, b: 0, score: 0, n: 0 }
      cur.r += r * weight
      cur.g += g * weight
      cur.b += b * weight
      cur.score += weight
      cur.n += 1
      buckets.set(bucket, cur)
    }
    let best: { r: number; g: number; b: number; score: number; n: number } | null = null
    for (const cur of buckets.values()) {
      if (cur.n < 6) continue // noise floor
      if (!best || cur.score > best.score) best = cur
    }
    if (!best || best.score <= 0) return null
    // slightly darken for white-text contrast
    const k = 0.78
    const r = Math.round((best.r / best.score) * k)
    const g = Math.round((best.g / best.score) * k)
    const b = Math.round((best.b / best.score) * k)
    const out = `rgb(${r}, ${g}, ${b})`
    if (cache.size > 300) cache.clear()
    cache.set(src, out)
    return out
  } catch {
    return null // CORS-tainted or broken image — caller keeps ambient fallback
  }
}
