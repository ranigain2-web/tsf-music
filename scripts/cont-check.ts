/* Quick continuation-token probe (F1 debug) — run: bunx tsx scripts/cont-check.ts */
import { ytmFetch } from '../src/lib/ytm/innertube'
import { searchPage } from '../src/lib/ytm/index'
import { SEARCH_FILTERS } from '../src/lib/ytm/clients'

async function main() {
  for (const [label, body] of [
    ['unfiltered', { query: 'tum hi ho' }],
    ['videos', { query: 'tum hi ho', params: SEARCH_FILTERS.videos }],
  ] as const) {
    const res = await ytmFetch<any>('search', body as any, { noCache: true })
    const j = JSON.stringify(res?.continuationContents ?? null) ?? 'null'
    console.log(label, '→ continuationContents:', j.slice(0, 120))
  }
  const res = await ytmFetch<any>('search', { query: 'tum hi ho' }, { noCache: true })
  const walk = (o: any, path: string, depth = 0): void => {
    if (!o || typeof o !== 'object' || depth > 8) return
    for (const k of Object.keys(o)) {
      if (/continuation/i.test(k)) {
        const v = o[k]
        if (typeof v === 'string' && v.length > 10) console.log('FOUND:', path + '.' + k, '=', v.slice(0, 50))
        else if (Array.isArray(v)) console.log('FOUND-ARR:', path + '.' + k)
      }
      walk(o[k], path + '.' + k, depth + 1)
    }
  }
  walk(res, 'root')
  const p = await searchPage('tum hi ho', undefined)
  console.log('searchPage continuation:', p.continuation ? p.continuation.slice(0, 50) : 'NONE', '| tracks:', p.tracks.length)
}
main()
