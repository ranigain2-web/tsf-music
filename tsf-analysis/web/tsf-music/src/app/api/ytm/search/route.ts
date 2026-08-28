import { NextRequest } from 'next/server'
import { search } from '@/lib/ytm'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams.get('q') || ''
  const filter = new URL(req.url).searchParams.get('filter') as any
  const res = await search(q, filter)
  return Response.json(res)
}
