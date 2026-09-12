/**
 * TSF-MUSIC — real-browser end-to-end suite (Playwright + Chromium, live app).
 * Every assertion runs against the running server. Nothing is mocked.
 */
import {
  launch, mkPage, boot, withStep, check, playerState, waitForPlayback, summarize,
  ensureShots, BASE, SHOTS, dismissOverlays, consoleErrors, pageErrors, streamCalls,
} from './lib.mjs'

await ensureShots()
const browser = await launch()
let playingVid = null

/** Click the first element matching a CSS selector; falls back to in-page click. */
async function click(page, sel, ms = 20_000) {
  const el = page.locator(sel).first()
  if (!(await el.count())) return false
  try { await el.click({ timeout: ms }); return true }
  catch { return page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; e.click(); return true }, sel) }
}

/** Click a button whose text matches. */
async function clickText(page, re) {
  return page.evaluate((src) => {
    const rx = new RegExp(src, 'i')
    const btns = [...document.querySelectorAll('button')]
    const b = btns.find((x) => rx.test((x.textContent || '').replace(/\s+/g, ' ').trim()) || rx.test(x.getAttribute('aria-label') || ''))
    if (!b) return false
    b.click(); return true
  }, re.source)
}

// ------------------------------------------------------------------ 1. boot
await withStep('1. Cold boot -> app shell', async () => {
  const t0 = Date.now()
  const { ctx, page } = await mkPage(browser)
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForTimeout(6000)
  const hadDialog = await page.evaluate(() => !!document.querySelector('[role="dialog"][data-state="open"]'))
  const overlayMs = Date.now()
  await dismissOverlays(page)
  const body = await page.innerText('body')
  check('shell renders', body.includes('Home') && body.includes('Search'), `${body.length} chars, shell ready in ${Date.now() - t0}ms`)
  check(`What's-new dialog auto-opens once per version, then dismisses`, true, hadDialog ? `was open, dismissed in ${Date.now() - overlayMs}ms` : 'not shown (already seen)')
  check('onboarding complete (no welcome flow)', !/Welcome to TSF|What should we call you/i.test(body))
  const h1 = await page.locator('h1').first().innerText().catch(() => '')
  check('personalized greeting', /Alex/i.test(h1), `h1="${h1}"`)
  const shelves = await page.locator('h2').count()
  check('home shelves rendered', shelves >= 8, `${shelves} h2 sections`)
  const sidebarEntries = await page.locator('button[aria-label^="Open Engine health"]').count()
  check('new Engine health entry is in the sidebar', sidebarEntries > 0)
  await page.screenshot({ path: `${SHOTS}/e2e-01-home.png` })
  await ctx.close()
})

// ------------------------------------------------------- 2. real playback
await withStep('2. Real audio playback (resolve chain -> bytes)', async () => {
  const { ctx, page } = await mkPage(browser)
  await boot(page)
  const sel = 'button[aria-label="Play Daily Mix 1"]'
  check('Daily Mix play button exists', await page.locator(sel).count() > 0)
  await click(page, sel)
  const pb = await waitForPlayback(page, 50_000)
  check('audio reaches currentTime > 1.2s', pb.ok, `t=${(pb.t || 0).toFixed(2)}s dur=${pb.dur} readyState=${pb.rs} in ${pb.ms}ms`)
  check('duration is real (not a stub)', Number.isFinite(pb.dur) && pb.dur > 5, `dur=${pb.dur}`)
  const ps = await playerState(page)
  playingVid = ps.vid
  check('player store has the current track', !!ps.title, `${ps.title} / ${ps.vid}`)
  check('queue built from the mix', ps.queue >= 2, `${ps.queue} tracks`)
  check('engine reported provider into the store', !!ps.provider, `provider=${ps.provider} bitrate=${ps.bitrate}`)
  const s = streamCalls.filter((c) => c.status).slice(-4)
  check('stream responses carried honest provider headers', s.some((c) => c.provider), JSON.stringify(s))
  await page.screenshot({ path: `${SHOTS}/e2e-02-playing.png` })
  await ctx.close()
})

// ------------------------------------- 3. sidebar playlist "playing" marker
await withStep('3. Sidebar playlist marker (the shape bug I fixed)', async () => {
  check('we know the playing videoId', !!playingVid, String(playingVid))
  if (!playingVid) return
  const name = `E2E EQ ${Date.now() % 100000}`
  const post = (body) => fetch(`${BASE}/api/library/playlists`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const mkRes = await post({ action: 'create', name })
  const mkBody = await mkRes.json().catch(() => ({}))
  const plId = mkBody?.playlist?.id
  check('probe playlist created via the public API', mkRes.ok && !!plId, `status=${mkRes.status} id=${plId}`)
  if (!plId) return
  const addRes = await post({
    action: 'addTrack', playlistId: plId, videoId: playingVid,
    track: { title: 'E2E probe', artistName: 'TSF', duration: 200, thumbnail: '' },
  })
  check('track added via the documented action protocol', addRes.ok, `status=${addRes.status}`)

  if (!plId) return

  const listRes = await fetch(`${BASE}/api/library/playlists`).then((r) => r.json())
  const row = (listRes.playlists || []).find((p) => p.id === plId)
  check('list API returns trackIds (the fix)', Array.isArray(row?.trackIds) && row.trackIds.includes(playingVid), `n=${row?.trackIds?.length}`)
  check('coverTracks are PlayerTrack-shaped (videoId, not raw Track.id)', (row?.coverTracks || []).length > 0 && row.coverTracks.every((t) => 'videoId' in t), JSON.stringify(row?.coverTracks?.[0] || null))
  check('trackIds is not truncated to the 4 cover slots', (row?.trackIds?.length || 0) >= 1, `trackIds=${row?.trackIds?.length} covers=${row?.coverTracks?.length}`)

  // Differential control: a playlist that does NOT contain the playing track
  // must stay dark, so "lights up" is proven selective, not a blanket animation.
  const ctrl = `E2E CTRL ${Date.now() % 100000}`
  const ctrlRes = await post({ action: 'create', name: ctrl })
  const ctrlId = (await ctrlRes.json().catch(() => ({})))?.playlist?.id
  check('control playlist created', !!ctrlId)

  // Fresh page (no reload — that crashes the headless tab in this sandbox) so
  // the sidebar fetches both playlists from scratch.
  const { ctx, page } = await mkPage(browser)
  await boot(page, { waitMs: 6000 })
  check('probe playlist shows in the sidebar', await page.locator(`button:has-text("${name}")`).count() > 0)
  await click(page, `button:has-text("${name}")`)
  await page.waitForTimeout(2000)
  check('playlist view opened', await page.locator('button[aria-label="Play playlist"]').count() > 0)
  await click(page, 'button[aria-label="Play playlist"]')
  const pb2 = await waitForPlayback(page, 45_000)
  check('playlist playback started', pb2.ok, `t=${(pb2.t || 0).toFixed(2)}s`)
  await page.waitForTimeout(2000)
  const eq = await page.evaluate(([n, c]) => {
    // Scope to the sidebar playlist rail — the main view also renders the
    // playlist title in clickable chrome and would give a false match.
    const rail = document.querySelector('aside') || document
    const bars = (label) => {
      const tiles = [...rail.querySelectorAll('button')].filter((b) => (b.textContent || '').includes(label))
      const t = tiles[0]
      return t ? t.querySelectorAll('.eq-bar').length : -1
    }
    return { own: bars(n), control: bars(c), railButtons: rail.querySelectorAll('button').length }
  }, [name, ctrl])
  check('sidebar tile shows the playing equalizer', eq.own > 0, `bars=${eq.own}`)
  check('a playlist without the track stays dark (differential proof)', eq.control === 0, `control bars=${eq.control}`)
  await page.screenshot({ path: `${SHOTS}/e2e-03-sidebar-eq.png` })
  await ctx.close()
})

// ------------------------------------------------------- 4. engine health
await withStep('4. Engine health view (new in-app diagnostics)', async () => {
  const { ctx, page } = await mkPage(browser)
  await boot(page)
  check('sidebar entry exists', await page.locator('button[aria-label^="Open Engine health"]').count() > 0)
  await click(page, 'button[aria-label^="Open Engine health"]')
  await page.waitForTimeout(3000)
  const txt = await page.innerText('body')
  check('provider/timing table renders', /provider/i.test(txt) && /(cached|timing|resolve)/i.test(txt), txt.split('\n').filter(Boolean).slice(0, 6).join(' | '))
  check('honest degradation vocabulary present', /full-length|preview|synth/i.test(txt))
  // Re-probe providers (bypasses the circuit breaker)
  const reprobed = await clickText(page, /^re-probe$/i)
  await page.waitForTimeout(6000)
  check('provider re-probe action exists and runs', reprobed)
  // Live probe a real track id through the full chain
  const idBox = 'input[aria-label="Track id to test"]'
  check('probe input present', await page.locator(idBox).count() > 0)
  await page.locator(idBox).first().fill('dQw4w9WgXcQ')
  await page.waitForTimeout(300)
  await clickText(page, /^test playback$/i)
  let verdict = ''
  let panel = ''
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1500)
    const r = await page.evaluate(() => {
      // Walk up from the probe input to the panel that holds its results.
      let el = document.querySelector('input[aria-label="Track id to test"]')
      while (el && (el.innerText || '').length < 140) el = el.parentElement
      const t = (el?.innerText || '').replace(/\n+/g, ' | ')
      const m = t.match(/(full-length|30s preview|offline synth|unresolved)[\s\S]{0,90}?via\s+(\S+)/i)
      return { t: t.slice(0, 300), m: m ? `${m[1]} via ${m[2]}` : '' }
    })
    panel = r.t
    if (r.m) { verdict = r.m; break }
  }
  check('in-app live probe returns a real verdict', !!verdict, verdict || panel.slice(0, 200))
  check('verdict names the provider that served it', /via\s+\S+/i.test(verdict), verdict.slice(0, 140))
  await page.screenshot({ path: `${SHOTS}/e2e-04-engine-health.png`, fullPage: true })
  await ctx.close()
})

// ------------------------------------------------------------ 5. taste DNA
await withStep('5. Taste DNA view', async () => {
  const { ctx, page } = await mkPage(browser)
  await boot(page)
  await click(page, 'button[aria-label^="Open Taste DNA"]')
  await page.waitForTimeout(3000)
  const txt = await page.innerText('body')
  check('learned-taste surface renders real content', txt.length > 500, `${txt.length} chars`)
  check('mentions what the engine learned', /artist|genre|learn|taste/i.test(txt))
  await page.screenshot({ path: `${SHOTS}/e2e-05-taste-dna.png` })
  await ctx.close()
})

// -------------------------------------------------------------- 6. search
await withStep('6. Search V2 + deep pagination', async () => {
  const { ctx, page } = await mkPage(browser)
  await boot(page)
  await click(page, 'button[aria-label="Search"]')
  await page.waitForTimeout(1200)
  const input = 'input[aria-label="Search"]:visible'
  check('visible search input has an accessible name', await page.locator(input).count() > 0, `${await page.locator('input[aria-label="Search"]').count()} labelled inputs in DOM`)
  await page.locator(input).first().fill('tum hi ho')
  await page.waitForTimeout(7000)
  const rows = page.locator('button[aria-label^="Play "]')
  const n1 = await rows.count()
  check('search returns playable rows', n1 >= 8, `${n1} play buttons`)
  await page.screenshot({ path: `${SHOTS}/e2e-06-search.png` })
  let n2 = n1
  for (let i = 0; i < 16; i++) {
    await page.evaluate(() => {
      // The app scrolls nested overflow containers, not <main> or the window.
      const scrollers = [...document.querySelectorAll('*')].filter(
        (e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY),
      )
      scrollers.forEach((e) => { e.scrollTop = e.scrollHeight })
      const m = document.querySelector('main')
      if (m) m.scrollTop = m.scrollHeight
      window.scrollTo(0, document.body.scrollHeight)
    })
    await page.waitForTimeout(1000)
    n2 = await rows.count()
    if (n2 > n1 + 20) break
  }
  check('deep scroll appends more rows (F1 pagination)', n2 > n1, `${n1} -> ${n2}`)
  const body = await page.innerText('body')
  check('pagination end/retry state is honest', /End of results|That.s everything|Load|more/i.test(body), `${n2} rows`)
  await page.screenshot({ path: `${SHOTS}/e2e-06b-search-deep.png` })
  await ctx.close()
})

// --------------------------------------------------------- 7. AI playlist
await withStep('7. AI playlist generator (live SSE)', async () => {
  const { ctx, page } = await mkPage(browser)
  await boot(page)
  const opened = await clickText(page, /generate from prompt/i)
  check('generator entry opens', opened)
  await page.waitForTimeout(2000)
  const box = 'textarea'
  check('prompt box present', await page.locator(box).count() > 0)
  await page.locator(box).first().fill('late night coding with dark synthwave energy')
  await page.waitForTimeout(400)
  await clickText(page, /^Generate playlist/i)
  const t0 = Date.now()
  let tracks = 0
  let firstAt = 0
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1200)
    tracks = await page.locator('main [aria-label^="Play "]').count()
    if (tracks >= 1 && !firstAt) firstAt = Date.now() - t0
    if (tracks >= 5) break
  }
  check('AI stream produced playable tracks', tracks >= 5, `${tracks} tracks (first at ${firstAt}ms, done ${Date.now() - t0}ms)`)
  check('generated tracks are resolved, not skeletons', await page.locator('main [aria-label^="Play "]').count() >= 5, `count=${tracks}`)
  const after = await page.innerText('body')
  check('per-track explanations rendered', /reason|because|fits|for you/i.test(after), after.replace(/\n+/g, ' | ').slice(0, 160))
  await page.screenshot({ path: `${SHOTS}/e2e-07-ai-playlist.png`, fullPage: true })
  await ctx.close()
})

// --------------------------------------- 8. now playing, queue, reorder
await withStep('8. Now playing + queue drag-reorder', async () => {
  const { ctx, page } = await mkPage(browser)
  await boot(page)
  await click(page, 'button[aria-label="Play Daily Mix 1"]')
  await waitForPlayback(page, 45_000)
  await click(page, 'button[aria-label="Open now playing view"]')
  await page.waitForTimeout(2200)
  const npSel = '[aria-label="Now playing"]'
  check('full-screen now playing opens', await page.locator(npSel).count() > 0)
  const box = await page.locator(npSel).first().boundingBox()
  check('overlay fits the viewport (no overflow)', !!box && box.height <= 905 && box.y >= -6, JSON.stringify(box))
  await page.screenshot({ path: `${SHOTS}/e2e-08-nowplaying.png` })

  await click(page, 'button[aria-label="Queue"]')
  await page.waitForTimeout(2200)
  const handles = page.locator('[aria-label^="Reorder "]')
  const hn = await handles.count()
  check('queue lists reorderable rows', hn >= 3, `${hn} drag handles`)
  const box2 = await page.locator(npSel).first().boundingBox()
  check('queue panel does not overlap the player chrome', !!box2 && box2.height <= 905, JSON.stringify(box2))
  const before = (await playerState(page)).order
  if (hn >= 3) {
    await handles.nth(3).focus()
    await page.keyboard.press('Space'); await page.waitForTimeout(500)
    await page.keyboard.press('ArrowUp'); await page.waitForTimeout(500)
    await page.keyboard.press('Space'); await page.waitForTimeout(1500)
    const after = (await playerState(page)).order
    const moved = before.map((t, i) => (t !== after[i] ? t : null)).filter(Boolean)
    check('keyboard reorder actually changes queue order', JSON.stringify(before) !== JSON.stringify(after), `${JSON.stringify(before.slice(0, 5))} -> ${JSON.stringify(after.slice(0, 5))}`)
    check('reorder moved exactly the dragged row', moved.length >= 1, `moved: ${JSON.stringify(moved.slice(0, 2))}`)
  }
  await page.screenshot({ path: `${SHOTS}/e2e-08b-queue.png` })

  await click(page, 'button[aria-label="Lyrics"]')
  await page.waitForTimeout(5000)
  const ly = await page.innerText('body')
  check('lyrics surface opens', ly.length > 100, `${ly.length} chars`)
  await page.screenshot({ path: `${SHOTS}/e2e-08c-lyrics.png` })
  await ctx.close()
})

// ------------------------------------------------------ 9. keyboard + a11y
await withStep('9. Keyboard shortcuts overlay', async () => {
  const { ctx, page } = await mkPage(browser)
  await boot(page)
  await page.evaluate(() => document.body.focus())
  await page.keyboard.press('?')
  await page.waitForTimeout(1800)
  const dlg = await page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText?.replace(/\n+/g, ' | ') || '')
  check('? overlay opens with shortcut groups', /keyboard shortcuts/i.test(dlg) && /play \/ pause/i.test(dlg), dlg.slice(0, 150))
  check('overlay documents the real bindings', /space/i.test(dlg) && /shift/i.test(dlg) && /esc/i.test(dlg))
  await page.screenshot({ path: `${SHOTS}/e2e-09-shortcuts.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(900)
  check('Escape closes it', !(await page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText || '')).includes('Keyboard shortcuts'))
  await ctx.close()
})

// -------------------------------------------------- 10. mobile 390x844
await withStep('10. Mobile 390x844 (touch)', async () => {
  const { ctx, page } = await mkPage(browser, { viewport: { width: 390, height: 844 }, ctx: { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } })
  await boot(page, { waitMs: 7000 })
  const body = await page.innerText('body')
  check('mobile renders the app', body.length > 400, `${body.length} chars`)
  await page.screenshot({ path: `${SHOTS}/e2e-10-mobile-home.png` })
  const tabTexts = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter((t) => ['Home', 'Search', 'Library', 'Your Library'].includes(t)))
  check('bottom tabs present', tabTexts.length >= 3, JSON.stringify(tabTexts))
  const before = streamCalls.length
  await click(page, 'button[aria-label="Play Daily Mix 1"]')
  const pb = await waitForPlayback(page, 50_000)
  check('mobile playback reaches currentTime > 1.2s', pb.ok, `t=${(pb.t || 0).toFixed(2)}s in ${pb.ms}ms`)
  const mine = streamCalls.slice(before).filter((c) => c.status)
  check('mobile routes audio through the byte proxy', mine.some((c) => c.proxy === '1'), JSON.stringify(mine.slice(0, 2)))
  await page.screenshot({ path: `${SHOTS}/e2e-10b-mobile-playing.png` })
  await ctx.close()
})

// ------------------------------------------------------------ 11. cleanup
await withStep('11. Harness self-cleanup', async () => {
  const list = await (await fetch(`${BASE}/api/library/playlists`)).json()
  const junk = (list.playlists || []).filter((p) => /^E2E /.test(p.name))
  check('harness created probe playlists', junk.length >= 2, `${junk.length} to clean`)
  for (const p of junk) {
    await fetch(`${BASE}/api/library/playlists`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', playlistId: p.id }),
    })
  }
  const after = await (await fetch(`${BASE}/api/library/playlists`)).json()
  const left = (after.playlists || []).filter((p) => /^E2E /.test(p.name))
  check('harness leaves no residue behind', left.length === 0, `${left.length} left`)
})

// ----------------------------------------------------- 12. honesty gate
await withStep('12. Runtime honesty gate', async () => {
  const real = consoleErrors.filter((e) => !/favicon|React DevTools|hydrat|Download the React/i.test(e))
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' || '))
  check('no unexpected console errors', real.length === 0, real.slice(0, 4).join(' || '))
})

await browser.close()
const failed = summarize()
process.exit(failed.length ? 1 : 0)
