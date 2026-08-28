import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/onboarding
 *   → { complete: boolean, name?: string, bio?: string, artists: SelectedArtist[], genres: string[] }
 *
 * POST /api/onboarding
 *   body: { action: 'save', name?, bio?, artists?, genres? }   // partial save
 *   body: { action: 'complete' }                                 // mark complete
 *   body: { action: 'reset' }                                   // wipe onboarding data
 */

export interface SelectedArtist {
  id: string // browseId
  name: string
  thumbnail?: string
}

export interface OnboardingProfile {
  complete: boolean
  name?: string
  bio?: string
  artists: SelectedArtist[]
  genres: string[]
}

export async function readProfile(): Promise<OnboardingProfile> {
  const rows = await db.setting.findMany({
    where: { key: { in: ['onboarding.complete', 'profile.name', 'profile.bio', 'profile.artists', 'profile.genres'] } },
  })
  const map: Record<string, string> = {}
  for (const r of rows) map[r.key] = r.value

  let artists: SelectedArtist[] = []
  try { artists = JSON.parse(map['profile.artists'] || '[]') } catch {}
  let genres: string[] = []
  try { genres = JSON.parse(map['profile.genres'] || '[]') } catch {}

  return {
    complete: map['onboarding.complete'] === 'true',
    name: map['profile.name'] || undefined,
    bio: map['profile.bio'] || undefined,
    artists,
    genres,
  }
}

export async function GET() {
  const profile = await readProfile()
  return NextResponse.json(profile)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { action } = body as { action: string }

  if (action === 'reset') {
    await db.setting.deleteMany({
      where: { key: { in: ['onboarding.complete', 'profile.name', 'profile.bio', 'profile.artists', 'profile.genres'] } },
    })
    return NextResponse.json({ ok: true, profile: await readProfile() })
  }

  if (action === 'save') {
    const updates: { key: string; value: string }[] = []
    if (typeof body.name === 'string') updates.push({ key: 'profile.name', value: body.name.trim().slice(0, 80) })
    if (typeof body.bio === 'string')  updates.push({ key: 'profile.bio',  value: body.bio.trim().slice(0, 600) })
    if (Array.isArray(body.artists))   updates.push({ key: 'profile.artists', value: JSON.stringify(body.artists.slice(0, 60)) })
    if (Array.isArray(body.genres))     updates.push({ key: 'profile.genres',  value: JSON.stringify(body.genres.slice(0, 30)) })
    for (const u of updates) {
      await db.setting.upsert({ where: { key: u.key }, update: { value: u.value }, create: u })
    }
    return NextResponse.json({ ok: true, profile: await readProfile() })
  }

  if (action === 'complete') {
    await db.setting.upsert({
      where: { key: 'onboarding.complete' },
      update: { value: 'true' },
      create: { key: 'onboarding.complete', value: 'true' },
    })
    return NextResponse.json({ ok: true, profile: await readProfile() })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
