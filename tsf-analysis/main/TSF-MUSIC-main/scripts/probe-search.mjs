import { chromium, devices } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.goto('http://localhost:3222', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
// tap search tab
const tab = page.locator('nav[aria-label="Main navigation"] button[aria-label="Search"]');
console.log('search tab count:', await tab.count());
await tab.tap();
await page.waitForTimeout(3000);
// what inputs exist?
const inputs = await page.locator('input').all();
console.log('inputs:', inputs.length);
for (const i of inputs) {
  console.log(' input:', await i.getAttribute('placeholder'), 'visible:', await i.isVisible().catch(()=>false));
}
await page.screenshot({ path: '/home/z/my-project/scripts/mobile-shots/probe-search.png' });
await browser.close();
