import { db } from '../src/lib/db'
const r = await db.streamCache.findMany({ take: 10 })
console.log('streamCache count:', r.length)
console.log(JSON.stringify(r.map(x => ({ videoId: x.videoId, provider: x.provider, urlPrefix: (x.url||'').slice(0,80), expiresAt: x.expiresAt })), null, 2))
await db.$disconnect()
