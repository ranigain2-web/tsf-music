import { NextRequest } from 'next/server'
import { radio } from '@/lib/ytm'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const p = new URL(req.url).searchParams
  const videoId = p.get('id') || ''
  const playlistId = p.get('playlist') || undefined
  if (!videoId) return Response.json({ error: 'missing id' }, { status: 400 })
  return Response.json(await radio(videoId, playlistId))
}
