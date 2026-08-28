import { NextRequest } from 'next/server'
import { appendEvents, getSessionContext } from '@/lib/mindbeat/ledger'
import type { LedgerEventIn } from '@/lib/mindbeat/types'

export const dynamic = 'force-dynamic'

/**
 * MINDBEAT L1 ledger — the ONLY write path for client events.
 *
 * POST { events: LedgerEventIn[] } → { ok, inserted }
 *   Batched, serialized, deduped by event id. Invalid rows are dropped
 *   (bad type / missing sessionId / unparseable ts).
 *
 * GET → the CURRENT session context for the Decision Engine:
 *   { sessionId, daypart, dayKind, sessionListens[≤12], vibeInputs }
 *   This is the only read path surfaces are allowed to use.
 */

const MAX_BATCH = 500

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { events?: LedgerEventIn[] } | null
  const events = body?.events
  if (!Array.isArray(events) || events.length === 0) {
    return Response.json({ error: 'missing events' }, { status: 400 })
  }
  try {
    const { inserted } = await appendEvents(events.slice(0, MAX_BATCH))
    return Response.json({ ok: true, inserted })
  } catch (e) {
    return Response.json({ error: 'ledger write failed', detail: String(e).slice(0, 200) }, { status: 500 })
  }
}

export async function GET() {
  try {
    const ctx = await getSessionContext()
    return Response.json(ctx)
  } catch (e) {
    return Response.json({ error: 'session context unavailable', detail: String(e).slice(0, 200) }, { status: 500 })
  }
}
