import { db } from '@/lib/db'
const sig = 'UCDxKh1gFWeYsqePvgVzmPoQ,UCPC0L1d253x-KuMNwa05TpA,UCtJe0RYzgPddQXKtWduxz_w,UClYV6hHlupm_S_ObS1W-DYw'
const rows = await db.apiCache.findMany({ where: { key: { contains: 'release-radar' } } })
for (const r of rows) {
  const p = JSON.parse(r.payload)
  console.log('KEY:', r.key.slice(0, 80))
  console.log('cover:', (p.cover || 'NONE').slice(0, 70))
  const thumbs = (p.tracks || []).slice(0, 14).map((t: any) => (t.thumbnail || '').slice(30, 60))
  console.log('track thumbs (first 14):', JSON.stringify(thumbs))
}
