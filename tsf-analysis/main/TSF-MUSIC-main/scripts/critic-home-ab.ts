/**
 * Blind A/B critic: our home vs the real Spotify home (desktop + mobile).
 * Labels stripped, order randomized, harsh binary verdict + biggest gap.
 * Uses the VLM via z-ai-web-dev-sdk (fresh context = no builder bias).
 */
import ZAI from 'z-ai-web-dev-sdk'
import fs from 'fs'

const zai = await ZAI.create()

function b64(p: string): string {
  return `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`
}

async function judge(oursPath: string, barPath: string, label: string) {
  // randomize order to kill position bias
  const oursFirst = Math.random() < 0.5
  const imgs = oursFirst ? [oursPath, barPath] : [barPath, oursPath]
  const oursLabel = oursFirst ? 'A' : 'B'
  const barLabel = oursFirst ? 'B' : 'A'

  const res = await zai.chat.completions.createVision({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `You are a harsh design critic. Below are two music-streaming app home screens: Screen A and Screen B (order randomized). Compare them as products: layout quality, visual hierarchy, spacing rhythm, typography, color system, component polish (cards, rows, sidebar/nav), and overall "would a designer ship this?" feel.

Answer in EXACTLY this format:
WINNER: A or B
MARGIN: decisive | clear | narrow
GAPS: the 3 biggest weaknesses of the WEAKER screen (one line each)
NOTES: one line on what the stronger screen does best`,
          },
          { type: 'image_url', image_url: { url: b64(imgs[0]) } },
          { type: 'image_url', image_url: { url: b64(imgs[1]) } },
        ],
      },
    ],
    thinking: { type: 'disabled' },
  })

  const text = res.choices[0]?.message?.content ?? ''
  const winner = /WINNER:\s*([AB])/i.exec(text)?.[1]?.toUpperCase()
  const margin = /MARGIN:\s*(decisive|clear|narrow)/i.exec(text)?.[1]?.toLowerCase()

  console.log(`\n===== ${label} =====`)
  console.log(`(ours=${oursLabel}, spotify=${barLabel})`)
  console.log(text.trim())

  const oursWon = winner === oursLabel
  return { label, oursWon, margin: margin ?? 'unknown', raw: text.trim() }
}

const results = [
  await judge('/home/z/my-project/download/phase2-shots/01-home-desktop.png', '/home/z/my-project/download/bar/spotify-home-desktop.png', 'HOME DESKTOP'),
  await judge('/home/z/my-project/download/phase2-shots/07-home-mobile.png', '/home/z/my-project/download/bar/spotify-home-mobile.png', 'HOME MOBILE'),
]

const verdict = {
  runAt: new Date().toISOString(),
  rounds: results.map(({ label, oursWon, margin }) => ({ label, oursWon, margin })),
  allOurs: results.every((r) => r.oursWon),
  raw: results.map((r) => ({ label: r.label, raw: r.raw })),
}
fs.writeFileSync('/home/z/my-project/download/phase2-shots/critic-home.json', JSON.stringify(verdict, null, 2))
console.log('\nSUMMARY:', results.map((r) => `${r.label}: ${r.oursWon ? 'OURS WINS' : 'SPOTIFY WINS'} (${r.margin})`).join(' | '))
