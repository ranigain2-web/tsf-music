// Replicates ytdlp.ts spawn exactly to capture in-app-style stderr.
import { spawn } from 'node:child_process'

const vid = process.argv[2] || 'dC9QIUKviJU' // Blank Space videoId from search
const bin = '/home/z/.venv/bin/yt-dlp'
const args = [
  '--ignore-config', '--no-warnings', '--no-playlist', '--no-progress',
  '--socket-timeout', '8',
  '-f', 'bestaudio[protocol^=http][ext=m4a]/bestaudio[protocol^=http]/bestaudio',
  '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416',
  '-J',
  `https://www.youtube.com/watch?v=${vid}`,
]
const t0 = Date.now()
const child = spawn(bin, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PATH: `${process.env.PATH || ''}:/home/z/.deno/bin` },
})
let out = '', err = ''
child.stdout.on('data', (d) => (out += String(d)))
child.stderr.on('data', (d) => (err += String(d)))
child.on('close', (code) => {
  console.log(`exit=${code} in ${Date.now() - t0}ms | stdout=${out.length}B stderr=${err.length}B`)
  console.log('--- stderr tail ---')
  console.log(err.split('\n').slice(-12).join('\n'))
  if (out.length) {
    try {
      const j = JSON.parse(out)
      const a = (j.formats || []).filter((f) => f.url && f.vcodec === 'none')
      console.log('audio fmts with url:', a.length, '| first:', a[0]?.format_id, a[0]?.ext, a[0]?.tbr)
    } catch (e) { console.log('JSON parse fail:', String(e).slice(0, 80)) }
  }
})
