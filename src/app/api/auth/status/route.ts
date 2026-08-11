import { NextResponse } from 'next/server'
import { extractAdminToken, getAdminSecret, requireAdmin } from '@/lib/auth/admin'

/** GET /api/auth/status — whether the current request is authorized as admin */
export async function GET(req: Request) {
  const secretConfigured = Boolean(getAdminSecret())
  const denied = requireAdmin(req)
  return NextResponse.json({
    ok: !denied,
    secretConfigured,
    hasToken: Boolean(extractAdminToken(req)),
  })
}
