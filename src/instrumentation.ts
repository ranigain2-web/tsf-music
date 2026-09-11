/**
 * TSF Music — server instrumentation (runs once per server process boot).
 *
 * WHY THIS EXISTS (the "the Mac app loads music slower than the phone" fix):
 * The desktop shell boots a COLD embedded engine on every app launch — its own
 * Bun + Next standalone + POT provider + yt-dlp — while phones stream from an
 * always-running server whose caches, provider probes and process caches are
 * already warm. So the very first thing the user touches feels slower on the
 * Mac even though it is on loopback.
 *
 * We shave the avoidable part of that cold cost by warming, in the background
 * and fire-and-forget, right after the HTTP listener is up:
 *   1. the yt-dlp binary probe — the first exec of a bundled binary pays the
 *      macOS Gatekeeper/first-exec cost plus the OS binary cache miss;
 *   2. the AI gateway config preload — removes first-request file IO;
 *   3. the home-feed payload — this is the big one: it exercises the real
 *      InnerTube + AI + DB pipeline the client is about to ask for, so the
 *      first screen (and the user's first pick) hits warm caches;
 *   4. the stream resolver for the most recent history tracks — the ones
 *      Quick Picks serves first — so the first TAP after launch is fast too.
 *
 * Every step is best-effort: failures are swallowed and the lazy on-demand
 * paths behave exactly as before. Nothing here may delay the listener — the
 * Tauri shell health-gates on /api/health before it shows the window.
 */

export async function register() {
  // Never run during build / static analysis phases or in the edge runtime.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.TSF_NO_WARMUP === '1') return

  // Defer past the current tick so the listener finishes binding first, and
  // give the shell's /api/health poll a clear lane ahead of our real work.
  setTimeout(() => {
    void warmup()
  }, 750)
}

async function warmup(): Promise<void> {
  // Sequential on purpose: the home-feed warm is CPU/network heavy and must
  // not compete with the health gate or the binary probe on a cold machine.
  const steps: Array<[string, () => Promise<void>]> = [
    ['yt-dlp', warmYtDlp],
    ['ai-config', warmAiConfig],
    ['home-feed', warmHomeFeed],
    ['recent-streams', warmRecentTracks],
  ]
  for (const [name, run] of steps) {
    try {
      await run()
      if (process.env.TSF_WARMUP_DEBUG === '1') console.log(`[warmup] ${name}: ok`)
    } catch (e) {
      if (process.env.TSF_WARMUP_DEBUG === '1') console.log(`[warmup] ${name}: failed: ${e}`)
    }
  }
}

/**
 * Probe the yt-dlp binary once so it is OS-cached and its availability is
 * memoized. On macOS this also absorbs the first-exec cost of a bundled
 * binary (Gatekeeper assessment + dyld cache) that would otherwise land on
 * the user's first play.
 */
async function warmYtDlp(): Promise<void> {
  const { ytDlpBinary } = await import('@/lib/ytm/stream')
  await ytDlpBinary()
}

/**
 * Preload the fast-gateway config so the first real AI call skips config file
 * IO. NOTE: this is a cheap synchronous config read — it does NOT open a TLS
 * connection. Real gateway handshake warmth comes from the home-feed warm
 * below, which drives the actual request path end-to-end.
 */
async function warmAiConfig(): Promise<void> {
  const { aiStatus } = await import('@/lib/ai/engine')
  aiStatus()
}

/**
 * Render the home-feed payload once so the client's first /api/ai/home hits
 * warm caches (InnerTube metadata, AI output, DB) instead of starting cold.
 * Bounded by a 20s abort and fully best-effort.
 */
async function warmHomeFeed(): Promise<void> {
  const base = `http://127.0.0.1:${process.env.PORT || '3000'}`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 20_000)
  try {
    await fetch(`${base}/api/ai/home`, { signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

/**
 * THE STREAMING-LATENCY LEVER: warm the resolver for the tracks the user most
 * recently played — which is exactly what Quick Picks serves first. This
 * drives the full provider chain (JioSaavn / yt-dlp + POT / InnerTube) once at
 * boot, so the first tap after launch is as fast as the always-warm server the
 * phone talks to. Bounded to 3 tracks and opt-out via TSF_NO_STREAM_WARM=1.
 *
 * Runs LAST on purpose: it spawns the heaviest work (yt-dlp subprocesses +
 * BotGuard token minting), which must not compete with the health gate or the
 * user's first interaction.
 */
async function warmRecentTracks(): Promise<void> {
  if (process.env.TSF_NO_STREAM_WARM === '1') return
  const { db } = await import('@/lib/db')
  const { warmStreams } = await import('@/lib/ytm/stream')

  const rows = await db.historyItem.findMany({
    orderBy: { playedAt: 'desc' },
    take: 10,
    include: { track: true },
  })

  const ids: string[] = []
  const meta: Record<string, { title?: string; artist?: string; durationSec?: number }> = {}
  for (const r of rows) {
    const t = r.track
    if (!t || ids.includes(t.id)) continue
    ids.push(t.id)
    meta[t.id] = {
      title: t.title,
      artist: t.artistName || undefined,
      durationSec: t.duration > 0 ? t.duration : undefined,
    }
    if (ids.length >= 3) break
  }
  if (ids.length === 0) return

  await warmStreams(ids, meta)
}
