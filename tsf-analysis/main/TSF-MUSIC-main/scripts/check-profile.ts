import { readProfile } from '@/app/api/onboarding/route'
const p = await readProfile()
console.log('complete:', p.complete, '| artists:', p.artists.length, p.artists.slice(0, 3).map(a => a.name), '| genres:', p.genres)
