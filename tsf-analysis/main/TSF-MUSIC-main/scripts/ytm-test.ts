import { search as ytmSearch } from '@/lib/ytm'
import { filterSafeTracks } from '@/lib/safety'
for (const q of ['epic workout bangers hits', 'Adele Someone Like You', 'heartbreak rain songs', 'Dil Diyan Gallan Atif Aslam']) {
  try {
    const r = await ytmSearch(q, 'songs')
    const all = (r.tracks || []).length
    const safe = filterSafeTracks((r.tracks || []).slice(0, 3))
    console.log(`"${q}" → raw=${all} safe=${safe.length} first="${safe[0]?.title ?? 'none'}" by ${safe[0]?.artistName ?? ''}`)
  } catch (e: any) {
    console.log(`"${q}" → THROW: ${e?.message}`)
  }
}
