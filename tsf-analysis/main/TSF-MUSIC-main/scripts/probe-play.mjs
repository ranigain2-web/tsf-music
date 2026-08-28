import { chromium, devices } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('CON', m.text().slice(0,150)); });
await page.goto('http://localhost:3222', { waitUntil: 'networkidle', timeout: 60000 });
await page.evaluate(async () => {
    try {
      await fetch('/api/onboarding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'complete' }) });
    } catch {}
  });
  await page.goto('http://localhost:3222', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.locator('nav[aria-label="Main navigation"] button[aria-label="Search"]').tap();
await page.waitForTimeout(1500);
await page.locator('input:visible').first().fill('bohemian rhapsody queen');
await page.locator('input:visible').first().press('Enter');
await page.waitForTimeout(5000);
const row = page.locator('div.group.grid').first();
console.log('row count:', await page.locator('div.group.grid').count());
await row.tap();
await page.waitForTimeout(9000);
const st = await page.evaluate(() => {
  const a = document.querySelector('audio');
  const player = document.querySelector('[aria-label="Player"]');
  return {
    audioSrc: a ? a.src.slice(-90) : 'NO AUDIO EL',
    duration: a?.duration, paused: a?.paused, readyState: a?.readyState,
    playerVisible: !!player, playerHTML: player ? player.innerHTML.slice(0, 120) : '',
    nowPlayingOpen: !!document.querySelector('[aria-label="Now playing"]'),
  };
});
console.log(JSON.stringify(st, null, 1));
await page.screenshot({ path: '/home/z/my-project/scripts/mobile-shots/06-after-tap.png' });
await browser.close();
