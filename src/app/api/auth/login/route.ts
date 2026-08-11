import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { ADMIN_COOKIE, getAdminSecret } from '@/lib/auth/admin'

function equal(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** POST /api/auth/login — body: { secret } → sets httpOnly cookie */
export async function POST(req: Request) {
  const secret = getAdminSecret()
  if (!secret) {
    return NextResponse.json(
      {
        error:
          'MIRAGE_ADMIN_SECRET is not configured. Add it to .env to enable dashboard login.',
      },
      { status: 503 },
    )
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const provided = String(body.secret || body.password || '').trim()
  if (!provided || !equal(provided, secret)) {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 401 })
  }

  const res = NextResponse.json({ ok: true })
  res.cookies.set(ADMIN_COOKIE, secret, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return res
}
