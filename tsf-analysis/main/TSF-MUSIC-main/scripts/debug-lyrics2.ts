const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const ctx = { context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' } } }
const lres = await fetch(`https://music.youtube.com/youtubei/v1/browse?key=${KEY}&prettyPrint=false`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  body: JSON.stringify({ ...ctx, browseId: 'MPLYt_rnEqQVfTfcH' }),
})
const lj: any = await lres.json()
console.log(JSON.stringify(lj, null, 1).slice(0, 3000))
