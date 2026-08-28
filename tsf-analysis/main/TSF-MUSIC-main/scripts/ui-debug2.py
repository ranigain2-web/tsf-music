import asyncio, json
from playwright.async_api import async_playwright

BASE = "http://localhost:3000"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await (await browser.new_context(viewport={"width": 1280, "height": 800})).new_page()
        await page.goto(BASE, wait_until="networkidle", timeout=60000)

        # click sidebar Search
        await page.locator("nav button:has-text('Search')").first.click(timeout=10000)
        await page.wait_for_timeout(1000)

        inp = page.locator("input").first
        await inp.click()
        await inp.fill("Kesariya")
        await inp.press("Enter")
        await page.wait_for_timeout(3500)

        state = await page.evaluate("""() => {
            const rows = [...document.querySelectorAll('[class*="card-play-btn"]')].length
            const text = document.body.innerText.slice(0, 600)
            const audio = document.querySelector('audio')
            return { playBtns: rows, text, audioSrc: audio ? audio.src.slice(0, 90) : null }
        }""")
        print(json.dumps(state, indent=1))
        await page.screenshot(path="/tmp/ui-debug-search.png")

        # try clicking the FIRST play button anywhere
        btns = page.locator("[class*='card-play-btn']")
        n = await btns.count()
        print(f"play buttons found: {n}")
        if n:
            await btns.first.click(force=True)
            await page.wait_for_timeout(6000)
            state2 = await page.evaluate("""() => {
                const audio = document.querySelector('audio')
                return audio ? { src: audio.src.slice(0, 90), paused: audio.paused, readyState: audio.readyState, currentTime: audio.currentTime, duration: audio.duration } : null
            }""")
            print("after play click:", json.dumps(state2))
        await browser.close()

asyncio.run(main())
