import { NextResponse } from 'next/server'
import { ADMIN_COOKIE } from '@/lib/auth/admin'

/** POST /api/auth/logout — clears admin cookie */
export async function POST() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(ADMIN_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  })
  return res
}
