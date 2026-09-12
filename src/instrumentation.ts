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
 * Steps 3 and 4 run concurrently so neither waits behind the other.
 *
 * Every step is best-effort: failures are swallowed and the lazy on-demand
 * paths behave exactly as before. Nothing here may delay the listener — the
 * Tauri shell health-gates on /api/health before it shows the window.
 */

/** Grace period before ANY stream warming may be attempted at boot. */
const BOOT_STREAM_WARM_GRACE_MS = 10_000
/** How long we are willing to keep waiting for the user to go quiet. */
const BOOT_STREAM_WARM_MAX_WAIT_MS = 45_000
/** Quiet window a background warms needs the user to have been idle for. */
const WARM_QUIET_MS = 8_000

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
  const debug = process.env.TSF_WARMUP_DEBUG === '1'
  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn()
      if (debug) console.log(`[warmup] ${name}: ok`)
    } catch (e) {
      if (debug) console.log(`[warmup] ${name}: failed: ${e}`)
    }
  }

  // Cheap prerequisites first — they are fast and the stream warm depends on
  // the yt-dlp probe. Never let either delay the two heavy warms below.
  await run('yt-dlp', warmYtDlp)
  await run('ai-config', warmAiConfig)

  // The two heavy warms run TOGETHER on purpose. Sequential order cost the
  // stream warm 3-4s of dead time behind the home feed, and the stream warm is
  // the one the user actually feels ("the phone loads music faster"). The
  // provider chain self-limits its own subprocess concurrency, so running
  // these in parallel does not stampede the machine — and because resolveStream
  // de-duplicates in-flight work, a tap that lands mid-warm still joins the
  // resolve already running instead of starting a second one.
  await Promise.allSettled([
    run('home-feed', warmHomeFeed),
    run('recent-streams', warmRecentTracks),
  ])
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
 * THE STREAMING-LATENCY LEVER: warm the resolver for the track the user most
 * recently played — which is exactly what Quick Picks serves first — so the
 * first tap after launch is as fast as the always-warm server the phone talks
 * to. Opt-out via TSF_NO_STREAM_WARM=1.
 *
 * IT YIELDS TO THE USER (the "Mac takes 5-10 s per song" fix). Warming at boot
 * used to be unconditional and three tracks wide, and each warm track spawns
 * its own yt-dlp subprocess (≤2 at a time, ≤25 s each). On a cold desktop
 * launch that spent the whole first half-minute holding the provider slots —
 * so every tap in that window queued behind a track the user had not asked
 * for. That is the exact shape of the reported symptom: "at the very start the
 * songs don't load, and after a while they start loading".
 *
 * Now the boot warm waits out a grace period, then requires a genuinely quiet
 * window (no user-initiated resolve in the last 8 s), warms ONE track, and
 * abandons the whole attempt if the user is still listening. The client's own
 * prefetch + Deep Warm already cover a user who is actively playing.
 */
async function warmRecentTracks(): Promise<void> {
  if (process.env.TSF_NO_STREAM_WARM === '1') return
  const { db } = await import('@/lib/db')
  const { warmStreams, waitForQuiet, userActiveWithin } = await import('@/lib/ytm/stream')

  // 1. Never in the first 10 s: the shell's health poll, the first screen and
  //    the user's first tap all live there, and they outrank a speculative
  //    full-length upgrade.
  await new Promise((r) => setTimeout(r, BOOT_STREAM_WARM_GRACE_MS))

  // 2. Then wait for a real quiet window, bounded. `waitForQuiet` returns false
  //    the moment the deadline passes while the user is still active.
  const quiet = await waitForQuiet(WARM_QUIET_MS, BOOT_STREAM_WARM_MAX_WAIT_MS)
  if (!quiet || userActiveWithin(WARM_QUIET_MS)) {
    if (process.env.TSF_WARMUP_DEBUG === '1') {
      console.log('[warmup] recent-streams: stood down — user is playing')
    }
    return
  }

  const rows = await db.historyItem.findMany({
    orderBy: { playedAt: 'desc' },
    take: 10,
    include: { track: true },
  })

  // 3. ONE track. The user's own prefetch warms the rest as they listen; this
  //    exists only so the very first tap on a fresh launch is warm.
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
    break
  }
  if (ids.length === 0) return

  await warmStreams(ids, meta, { quietMs: WARM_QUIET_MS })
}
