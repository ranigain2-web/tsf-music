/**
 * Mobile viewport verification — 390x844 (iPhone 14).
 * Screenshots: home, search, now-playing fullscreen, mini-player.
 */
import { chromium, devices } from 'playwright';

const BASE = 'http://localhost:3222';
const OUT = '/home/z/my-project/scripts/mobile-shots';

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    ...devices['iPhone 13'],
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 200)); });

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);

  // complete onboarding if present
  const isOnboarding = await page.locator('text=Let').first().isVisible().catch(() => false);
  console.log('onboarding visible:', isOnboarding);

  // try to fast-forward onboarding via API + reload
  await page.evaluate(async () => {
    try {
      await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', genres: ['pop'], artists: [], name: 'Test', bio: '' }),
      });
      await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete' }),
      });
    } catch {}
  });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/01-home-mobile.png` });

  // check bottom nav + mini player presence
  const nav = await page.locator('nav[aria-label="Main navigation"]').isVisible().catch(() => false);
  console.log('bottom nav visible:', nav);

  // tap search tab
  await page.locator('nav[aria-label="Main navigation"] button[aria-label="Search"]').tap().catch(e => console.log('search tap fail', e.message));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/02-search-mobile.png` });

  // search for a track and play it (single tap)
  await page.waitForTimeout(1500);
    const input = page.locator('input:visible').first();
  if (await input.isVisible().catch(() => false)) {
    await input.fill('bohemian rhapsody');
    await input.press('Enter');
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${OUT}/03-search-results-mobile.png` });

    // tap the first track row (tap-to-play)
    const row = page.locator('div.group.grid').first();
    await row.tap().catch(e => console.log('row tap fail', e.message));
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `${OUT}/04-miniplayer-mobile.png` });

    // mini-player: is there a progress line + play button?
    const player = await page.locator('[aria-label="Player"]').first().isVisible().catch(() => false);
    console.log('mini player visible:', player);

    // open full screen now playing by tapping the mini player text
    await page.locator('[aria-label="Player"] .text-\\\\[14px\\\\]').first().tap().catch(() => {});
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/05-fullscreen-mobile.png` });

    // audio state
    const audioState = await page.evaluate(() => {
      const a = document.querySelector('audio');
      if (!a) return { exists: false };
      return {
        exists: true, duration: a.duration, currentTime: a.currentTime,
        readyState: a.readyState, paused: a.paused, error: a.error ? a.error.code : null,
        src: a.src.slice(-80),
      };
    });
    console.log('audio state:', JSON.stringify(audioState));
  }

  console.log('errors:', errors.slice(0, 8));
  await browser.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
