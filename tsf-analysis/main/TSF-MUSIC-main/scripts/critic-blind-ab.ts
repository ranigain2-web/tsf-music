/**
 * Gauntlet-loop blind A/B critic
 *
 * Compares TSF Music onboarding screens (ours) vs Spotify bar screenshots.
 * Uses z-ai-web-dev-sdk vision API.
 *
 * For each pair, sends both images to the model with labels STRIPPED
 * (just "Image A" and "Image B" in random order) and asks the critic to
 * pick which is better along Spotify-likeness dimensions and name the
 * single biggest remaining gap.
 *
 * Writes JSON verdicts to /home/z/my-project/download/critic-verdict.json
 */
import ZAI from 'z-ai-web-dev-sdk'
import fs from 'fs'
import path from 'path'

const OURS_DIR = '/home/z/my-project/download/ours'
const BAR_DIR = '/home/z/my-project/download/bar'
const OUT = '/home/z/my-project/download/critic-verdict.json'

// Pair: (our-screenshot, bar-screenshot, dimension being judged)
const PAIRS: { name: string; ours: string; bar: string; what: string }[] = [
  {
    name: 'Welcome-screen-likeness',
    ours: 'onboarding-1-welcome.png',
    bar:  'spotify-home-desktop.png',
    what: 'first-impression / hero / typography / brand-color usage. The bar image is the official Spotify US homepage; ours is our app\'s onboarding Welcome screen. Judge which one FEELS more like a premium music streaming brand on first sight.',
  },
  {
    name: 'Artists-picker-likeness',
    ours: 'onboarding-4-artists-empty.png',
    bar:  'spotify-web-player-landing-desktop.png',
    what: 'multi-select artist picker UI: card grid + sticky search bar + sticky footer counter + green accent. The bar image is the Spotify web player landing (only public Spotify screen with comparable dark grid + green accents). Judge which one looks more like a real Spotify-grade UI.',
  },
  {
    name: 'Artists-with-search',
    ours: 'onboarding-5-artists-search.png',
    bar:  'spotify-web-player-landing-desktop.png',
    what: 'live-search behavior in a dark artist-grid picker. Bar is the closest comparable Spotify screen. Judge which one\'s search UX feels more like Spotify.',
  },
  {
    name: 'Selected-with-counter',
    ours: 'onboarding-6-artists-selected.png',
    bar:  'spotify-web-player-landing-desktop.png',
    what: 'multi-select with selected-count sticky footer (Spotify-style "X of 3 selected" + green primary Next button). Bar is the closest comparable Spotify screen. Judge which one is closer to Spotify\'s actual signup artist-picker pattern.',
  },
  {
    name: 'Home-with-Made-For-You',
    ours: 'onboarding-10-home-mixes.png',
    bar:  'spotify-web-player-landing-desktop.png',
    what: '"Made For [Name]" shelves with Daily Mixes (square cards + play button + subtitle from favorite artists). Bar is Spotify\'s web player landing. Judge which one feels more like a real Spotify home.',
  },
]

function img(pathStr: string) {
  const buf = fs.readFileSync(pathStr)
  return `data:image/png;base64,${buf.toString('base64')}`
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

async function main() {
  const zai = await ZAI.create()
  const verdicts: any[] = []

  for (const p of PAIRS) {
    const oursPath = path.join(OURS_DIR, p.ours)
    const barPath  = path.join(BAR_DIR,  p.bar)
    if (!fs.existsSync(oursPath) || !fs.existsSync(barPath)) {
      console.log(`SKIP ${p.name}: missing screenshot`)
      continue
    }

    // Randomize A/B labels
    const oursFirst = Math.random() < 0.5
    const images = oursFirst
      ? [{ label: 'A', path: oursPath, isOurs: true }, { label: 'B', path: barPath, isOurs: false }]
      : [{ label: 'A', path: barPath,  isOurs: false }, { label: 'B', path: oursPath, isOurs: true }]
    // Note: do not echo isOurs to the model

    const content: any[] = [
      {
        type: 'text',
        text: `You are a HARSH visual-design critic. Two screenshots follow, labeled A and B. You don't know which is which.

Task: Pick which one is BETTER as a Spotify-grade music streaming UI, judged specifically on: ${p.what}

Rules:
- Be harsh. Praise is not useful.
- Pick exactly one: "A" or "B". No ties.
- Name the single biggest remaining gap in the loser.
- Respond in this exact JSON shape only:
  {"winner":"A"|"B","runner_up_gap":"<one short sentence>","why":"<one short sentence>"}`,
      },
      { type: 'image_url', image_url: { url: img(images[0].path) } },
      { type: 'image_url', image_url: { url: img(images[1].path) } },
    ]

    try {
      const resp = await zai.chat.completions.createVision({
        messages: [{ role: 'user', content }],
        thinking: { type: 'disabled' },
      })
      const raw = resp.choices[0]?.message?.content || ''
      let parsed: any = null
      try { parsed = JSON.parse(raw) } catch {
        // best-effort: extract {...} block
        const m = raw.match(/\{[\s\S]*\}/)
        if (m) { try { parsed = JSON.parse(m[0]) } catch {} }
      }
      const winnerLabel = parsed?.winner
      const oursWon = images.find((x) => x.label === winnerLabel)?.isOurs ?? null

      verdicts.push({
        name: p.name,
        ours_first: oursFirst,
        ours_won: oursWon,
        critic_response: parsed || { raw },
      })
      console.log(`${p.name}: ${oursWon === true ? 'OURS WINS ✅' : oursWon === false ? 'OURS LOSES ❌' : 'AMBIGUOUS ?'}\n   gap: ${parsed?.runner_up_gap || parsed?.why || ''}\n`)
    } catch (e) {
      console.log(`${p.name}: ERROR ${(e as Error).message.slice(0, 200)}`)
      verdicts.push({ name: p.name, error: (e as Error).message })
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(verdicts, null, 2))
  console.log(`\nVerdicts written to ${OUT}`)
  const wins = verdicts.filter((v) => v.ours_won === true).length
  const losses = verdicts.filter((v) => v.ours_won === false).length
  console.log(`Summary: ours wins ${wins}/${verdicts.length}, loses ${losses}/${verdicts.length}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
