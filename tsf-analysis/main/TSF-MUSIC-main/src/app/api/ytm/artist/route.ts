import { NextRequest } from 'next/server'
import { artist } from '@/lib/ytm'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id') || ''
  if (!id) return Response.json({ error: 'missing id' }, { status: 400 })
  return Response.json(await artist(id))
}
