import { NextRequest } from 'next/server'
import { lyrics } from '@/lib/ytm'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const p = new URL(req.url).searchParams
  const videoId = p.get('id') || ''
  if (!videoId) return Response.json({ error: 'missing id' }, { status: 400 })
  return Response.json(await lyrics(videoId, p.get('title') || undefined, p.get('artist') || undefined, p.get('album') || undefined, Number(p.get('duration')) || undefined))
}
