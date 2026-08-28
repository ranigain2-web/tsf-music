import asyncio
from playwright.async_api import async_playwright

BASE = "http://localhost:3000"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await (await browser.new_context(viewport={"width": 1280, "height": 800})).new_page()
        await page.goto(BASE, wait_until="networkidle", timeout=60000)
        await page.screenshot(path="/tmp/ui-debug-1.png")

        # what nav elements exist?
        info = await page.evaluate("""() => {
            const btns = [...document.querySelectorAll('button')].slice(0, 25).map(b => (b.textContent || '').trim().slice(0, 20)).filter(Boolean)
            const inputs = [...document.querySelectorAll('input')].map(i => ({type: i.type, placeholder: i.placeholder, visible: i.offsetParent !== null}))
            const links = [...document.querySelectorAll('a')].slice(0, 10).map(a => (a.textContent || '').trim().slice(0, 20)).filter(Boolean)
            return { bodyText: document.body.innerText.slice(0, 400), btns, inputs, links }
        }""")
        import json
        print(json.dumps(info, indent=1)[:2000])
        await browser.close()

asyncio.run(main())
