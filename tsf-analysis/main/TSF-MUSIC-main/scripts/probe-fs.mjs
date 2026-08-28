import { chromium, devices } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.goto('http://localhost:3222', { waitUntil: 'networkidle', timeout: 60000 });
await page.evaluate(async () => {
    try {
      await fetch('/api/onboarding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'complete' }) });
    } catch {}
  });
  await page.goto('http://localhost:3222', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.locator('nav[aria-label="Main navigation"] button[aria-label="Search"]').tap();
await page.waitForTimeout(1200);
await page.locator('input:visible').first().fill('despacito luis fonsi');
await page.locator('input:visible').first().press('Enter');
await page.waitForTimeout(4500);
await page.locator('div.group.grid').first().tap();
await page.waitForTimeout(6000);
// open fullscreen: tap mini-player artwork
await page.locator('[aria-label="Player"] img').first().tap();
await page.waitForTimeout(2500);
console.log('fullscreen open:', await page.locator('[aria-label="Now playing"]').isVisible().catch(() => false));
await page.screenshot({ path: '/home/z/my-project/scripts/mobile-shots/07-fullscreen-open.png' });

// measure overflow: is anything wider than 390?
const overflow = await page.evaluate(() => {
  const bad = [];
  document.querySelectorAll('[aria-label="Now playing"] *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.right > 391 || r.left < -1) bad.push(`${el.tagName}.${(el.className+'').split(' ')[0]} right=${Math.round(r.right)} left=${Math.round(r.left)}`);
  });
  return bad.slice(0, 8);
});
console.log('overflow elements:', overflow.length ? overflow : 'NONE ✓');

// swipe down from top bar to dismiss
const bar = await page.locator('[aria-label="Now playing"] .relative.flex.items-center.justify-between').first();
const bb = await bar.boundingBox();
if (bb) {
  await page.mouse.move(bb.x + bb.width / 2, bb.y + 20);
  await page.mouse.down();
  for (let y = 0; y <= 300; y += 30) {
    await page.mouse.move(bb.x + bb.width / 2, bb.y + 20 + y, { steps: 2 });
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}
await page.waitForTimeout(1200);
console.log('after swipe, fullscreen still open:', await page.locator('[aria-label="Now playing"]').isVisible().catch(() => false));
await page.screenshot({ path: '/home/z/my-project/scripts/mobile-shots/08-after-swipe.png' });
await browser.close();
