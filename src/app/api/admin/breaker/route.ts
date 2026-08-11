import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/admin'
import {
  getAdapterBreaker,
  getAllAdapterBreakers,
} from '@/lib/providers/provider-wrapper'
import '@/lib/providers'

/**
 * GET /api/admin/breaker — status of all circuit breakers
 */
export async function GET(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const status: Record<
    string,
    { canAttempt: boolean; msUntilRetry: number; failCount: number }
  > = {}
  for (const [key, breaker] of getAllAdapterBreakers()) {
    status[key] = {
      canAttempt: breaker.canAttempt(),
      msUntilRetry: breaker.msUntilRetry(),
      failCount: breaker.getFailCount(),
    }
  }
  return NextResponse.json(status)
}

/**
 * POST /api/admin/breaker — force-reset a specific provider or all
 * Body: { "provider": "deepseek" } or { "provider": "all" }
 */
export async function POST(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const body = (await req.json().catch(() => ({}))) as {
    provider?: string
  }
  const target = (body.provider || '').trim().toLowerCase()

  if (!target) {
    return NextResponse.json(
      { error: 'Missing "provider" field (use a provider key or "all")' },
      { status: 400 },
    )
  }

  if (target === 'all') {
    let count = 0
    for (const [key, breaker] of getAllAdapterBreakers()) {
      breaker.forceReset()
      count++
      console.log(`[admin] breaker reset: ${key}`)
    }
    return NextResponse.json({
      ok: true,
      message: `Reset ${count} breaker(s)`,
    })
  }

  const breaker = getAdapterBreaker(target)
  if (!breaker) {
    return NextResponse.json(
      {
        error: `Provider "${target}" not found in breaker registry`,
        available: Array.from(getAllAdapterBreakers().keys()),
      },
      { status: 404 },
    )
  }

  breaker.forceReset()
  console.log(`[admin] breaker reset: ${target}`)
  return NextResponse.json({
    ok: true,
    message: `${target} breaker reset`,
  })
}
