/**
 * Shared helpers for the browser end-to-end suite.
 *
 * Setup (one time, outside package.json so the app never ships a test dep):
 *   npx playwright install chromium
 *
 * Run (with the app already serving — `bun run dev` or a production build):
 *   node scripts/e2e-browser/index.mjs
 *
 * Env overrides:
 *   TSF_BASE    app origin              (default http://127.0.0.1:3000)
 *   TSF_SHOTS   screenshot output dir   (default ./qa-shots)
 *   TSF_CHROME  explicit Chromium path  (default: whatever Playwright installed)
 */
import { chromium } from 'playwright'

export const EXE = process.env.TSF_CHROME || ''
export const BASE = process.env.TSF_BASE || 'http://127.0.0.1:3000'
export const SHOTS = process.env.TSF_SHOTS || './qa-shots'

export const results = []
let STEP = 'setup'
export const step = (s) => { STEP = s; console.log(`\n### ${s}`) }
export const check = (name, ok, detail = '') => {
  results.push({ step: STEP, name, ok: !!ok, detail: String(detail).slice(0, 400) })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Run a step in isolation: a thrown error becomes a FAIL, never an abort. */
export async function withStep(name, fn) {
  step(name)
  try { await fn() } catch (e) {
    check(`${name} (step crashed)`, false, String(e).split('\n')[0].slice(0, 200))
  }
}

export const consoleErrors = []
export const pageErrors = []
export const streamCalls = []

export async function launch() {
  const opts = {
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  }
  if (EXE) opts.executablePath = EXE
  return chromium.launch(opts)
}

/** Create the screenshot directory once — the suite writes a lot of them. */
export async function ensureShots() {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(SHOTS, { recursive: true })
}

export async function mkPage(browser, opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1440, height: 900 },
    ...(opts.ctx || {}),
  })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${m.text()}`.slice(0, 220)) })
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 220)))
  page.on('request', (r) => {
    const u = r.url()
    if (u.includes('/api/stream')) {
      const q = new URL(u).searchParams
      streamCalls.push({ id: q.get('id'), fresh: q.get('fresh'), proxy: q.get('proxy') })
    }
  })
  page.on('response', (r) => {
    const u = r.url()
    if (u.includes('/api/stream')) {
      for (let i = streamCalls.length - 1; i >= 0; i--) {
        if (streamCalls[i].id === new URL(u).searchParams.get('id') && !streamCalls[i].status) {
          streamCalls[i].status = r.status()
          streamCalls[i].provider = r.headers()['x-stream-provider']
          streamCalls[i].bitrate = r.headers()['x-stream-bitrate']
          break
        }
      }
    }
  })
  return { ctx, page }
}

/** The "What's new" dialog auto-opens on a fresh profile; dismiss it like a user would. */
export async function boot(page, { waitMs = 5000 } = {}) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForTimeout(waitMs)
  await dismissOverlays(page)
  return page
}

export async function dismissOverlays(page) {
  for (let i = 0; i < 4; i++) {
    const open = await page.evaluate(() => !!document.querySelector('[role="dialog"][data-state="open"], [data-slot="dialog-overlay"][data-state="open"]'))
    if (!open) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    const stillOpen = await page.evaluate(() => !!document.querySelector('[role="dialog"][data-state="open"]'))
    if (stillOpen) {
      const closed = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('[role="dialog"] button')]
        const c = btns.find((b) => /^(close|got it|dismiss|ok)$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim())) || btns[btns.length - 1]
        if (c) { c.click(); return true }
        return false
      })
      if (!closed) return
      await page.waitForTimeout(600)
    }
  }
}

export const audioState = (page) => page.evaluate(() => {
  const a = document.querySelector('audio')
  return a ? { src: a.src, paused: a.paused, t: a.currentTime, dur: a.duration, rs: a.readyState } : null
})

export const playerState = (page) => page.evaluate(() => {
  try {
    const s = window.__player.getState()
    const cur = s.queue[s.queueIndex]
    return {
      playing: s.isPlaying,
      title: cur?.title,
      vid: cur?.videoId,
      queue: s.queue?.length ?? 0,
      idx: s.queueIndex,
      provider: s.streamProvider,
      bitrate: s.streamBitrate,
      order: (s.queue || []).map((t) => t.title),
    }
  } catch (e) { return { err: String(e).slice(0, 140) } }
})

export async function waitForPlayback(page, budgetMs = 45_000) {
  const t0 = Date.now()
  let best = { t: 0, dur: 0 }
  while (Date.now() - t0 < budgetMs) {
    const a = await audioState(page)
    if (a) {
      if ((a.t || 0) > best.t) best = { t: a.t, dur: a.dur, src: a.src, rs: a.rs }
      if (a.t > 1.2) return { ok: true, ms: Date.now() - t0, ...a }
    }
    await page.waitForTimeout(1000)
  }
  return { ok: false, ms: Date.now() - t0, ...best }
}

/** Click by CSS/attribute, ignoring aria-hidden sibling filtering that role locators apply. */
export const q = (page, sel) => page.locator(sel).first()
export async function clickIf(page, sel, ms = 30_000) {
  const el = page.locator(sel).first()
  if (!(await el.count())) return false
  await el.click({ timeout: ms })
  return true
}

export function summarize() {
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  console.log('\n' + '='.repeat(72))
  console.log(`BROWSER E2E: ${passed}/${results.length} passed`)
  if (failed.length) {
    console.log('\nFAILURES:')
    for (const f of failed) console.log(`  x [${f.step}] ${f.name} — ${f.detail}`)
  }
  console.log('='.repeat(72))
  return failed
}
