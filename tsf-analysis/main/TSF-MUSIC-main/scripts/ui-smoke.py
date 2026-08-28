"""TSF UI smoke test — post Musify integration.
Verifies: app boots, library playback-settings tab, track play + sponsorblock fetch.
"""
import asyncio, json
from playwright.async_api import async_playwright

BASE = "http://localhost:3000"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1280, "height": 800})
        page = await ctx.new_page()

        console_errors = []
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

        # 1. app boots
        await page.goto(BASE, wait_until="networkidle", timeout=60000)
        title = await page.title()
        print(f"[1] app booted: title={title!r}")

        # 2. Library view → Playback tab
        try:
            lib_btn = page.locator("text=Your Library").first
            await lib_btn.click(timeout=10000)
        except Exception as e:
            # mobile nav or sidebar variant
            await page.locator("[aria-label*='Library'], text=Library").first.click(timeout=10000)
        await page.wait_for_timeout(1000)
        pb_tab = page.locator("button:has-text('Playback')").first
        await pb_tab.click(timeout=10000)
        await page.wait_for_timeout(500)
        skip_label = await page.locator("text=Skip non-music segments").count()
        print(f"[2] Playback settings tab: skip-toggle visible = {skip_label > 0}")

        # toggle it off and on
        switch = page.locator("[role='switch'][aria-label='Skip non-music segments']").first
        await switch.click()
        state_off = await switch.get_attribute("aria-checked")
        await switch.click()
        state_on = await switch.get_attribute("aria-checked")
        print(f"[3] toggle: off={state_off} → on={state_on}")

        # 3. search & play a track, watch for sponsorblock network call
        sb_requests = []
        page.on("request", lambda r: sb_requests.append(r.url) if "/api/sponsorblock" in r.url else None)

        # sidebar has a Search button (desktop layout)
        search_btn = page.locator("nav button:has-text('Search'), aside button:has-text('Search')").first
        try:
            await search_btn.click(timeout=8000)
        except Exception:
            await page.locator("text=Search").nth(1).click(timeout=8000)
        await page.wait_for_timeout(800)
        sinput = page.locator("input[placeholder*='listen'], input").first
        await sinput.click()
        await sinput.fill("Kesariya", timeout=10000)
        await sinput.press("Enter")
        await page.wait_for_timeout(3000)

        # desktop track rows play on double-click
        track_row = page.locator("text=Kesariya").first
        await track_row.dblclick(timeout=10000)
        await page.wait_for_timeout(7000)

        sb_hits = [u for u in sb_requests if "sponsorblock" in u]
        print(f"[4] sponsorblock requests fired during play: {len(sb_hits)} {'✓' if sb_hits else '(none — track may be cached/seeded)'}")
        if sb_hits: print(f"    e.g. {sb_hits[0][:100]}")

        # 4. audio state
        audio_state = await page.evaluate("""() => {
            const a = document.querySelector('audio')
            if (!a) return { exists: false }
            return { exists: true, src: a.src.slice(0, 80), paused: a.paused, readyState: a.readyState, duration: a.duration, currentTime: a.currentTime }
        }""")
        print(f"[5] audio element: {json.dumps(audio_state)}")

        errs = [e for e in console_errors if "favicon" not in e][:5]
        print(f"[6] console errors: {len(errs)}")
        for e in errs: print(f"    {e[:120]}")

        await page.screenshot(path="/home/z/my-project/download/ui-smoke-playback-tab.png", full_page=False)
        await browser.close()

asyncio.run(main())
