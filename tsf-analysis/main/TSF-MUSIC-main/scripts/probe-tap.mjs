import { chromium, devices } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.goto('http://localhost:3222', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(1500);
await page.locator('nav[aria-label="Main navigation"] button[aria-label="Search"]').tap();
await page.waitForTimeout(1500);
await page.locator('input:visible').first().fill('bohemian rhapsody queen');
await page.locator('input:visible').first().press('Enter');
await page.waitForTimeout(5000);
// dump search state
const state = await page.evaluate(async () => {
  const r = await fetch('/api/ytm/search?q=bohemian+rhapsody+queen&type=songs').then(x => x.json()).catch(e => ({ err: String(e) }));
  const groups = [...document.querySelectorAll('.group')].slice(0, 6).map(g => g.className.split(' ').slice(0,3).join(' ') + ' :: ' + (g.textContent || '').slice(0, 40));
  const hoverNone = window.matchMedia('(hover: none)').matches;
  return { apiFirst: r?.tracks?.[0]?.title ?? JSON.stringify(r).slice(0, 200), groups, hoverNone };
});
console.log(JSON.stringify(state, null, 1));
await browser.close();
