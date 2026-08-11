/**
 * Dashboard / admin API authentication.
 * Set MIRAGE_ADMIN_SECRET in .env. Clients send it as:
 *   Authorization: Bearer <secret>
 *   or cookie mirage_admin=<secret> (set via POST /api/auth/login)
 */

import { createHash, timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'

export const ADMIN_COOKIE = 'mirage_admin'

export function getAdminSecret(): string {
  return (process.env.MIRAGE_ADMIN_SECRET || '').trim()
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function extractAdminToken(req: Request): string | null {
  const auth = req.headers.get('authorization') || ''
  const bearer = auth.replace(/^Bearer\s+/i, '').trim()
  if (bearer) return bearer

  const header = req.headers.get('x-mirage-admin')?.trim()
  if (header) return header

  const cookie = req.headers.get('cookie') || ''
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([^;]+)`))
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1])
    } catch {
      return match[1]
    }
  }
  return null
}

/**
 * Returns null when authorized, otherwise a NextResponse to return.
 */
export function requireAdmin(req: Request): NextResponse | null {
  const secret = getAdminSecret()
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        {
          error:
            'MIRAGE_ADMIN_SECRET is not set. Configure it in the environment to protect the dashboard.',
        },
        { status: 503 },
      )
    }
    // Development without secret: only allow loopback hosts
    const host = (req.headers.get('host') || '').split(':')[0]
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
      return null
    }
    return NextResponse.json(
      { error: 'Set MIRAGE_ADMIN_SECRET or access via localhost in development' },
      { status: 401 },
    )
  }

  const token = extractAdminToken(req)
  if (!token || !safeEqual(token, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
