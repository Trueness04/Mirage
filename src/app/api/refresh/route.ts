import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAdapter } from '@/lib/providers/base'
import '@/lib/providers'
import { loadSessionContext } from '@/lib/providers/session-loader'
import { ensureSchedulerStarted } from '@/lib/scheduler/token-refresh'
import { requireAdmin } from '@/lib/auth/admin'
import { publicSession } from '@/lib/auth/sanitize'

/**
 * POST /api/refresh?id=<sessionId>
 */
export async function POST(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  ensureSchedulerStarted()
  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const loaded = await loadSessionContext(id)
  if (!loaded) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  const adapter = getAdapter(loaded.providerKey)
  if (!adapter) return NextResponse.json({ error: 'Adapter not found' }, { status: 500 })

  await db.providerSession.update({
    where: { id },
    data: { status: 'refreshing' },
  })

  const r = await adapter.refresh(loaded.ctx)
  if (r.ok) {
    const updated = await db.providerSession.update({
      where: { id },
      data: {
        status: 'active',
        accessToken: r.accessToken ?? loaded.ctx.accessToken ?? null,
        refreshToken: r.refreshToken ?? loaded.ctx.refreshToken ?? null,
        cookies: r.cookies ? JSON.stringify(r.cookies) : undefined,
        expiresAt: r.expiresAt ?? null,
        refreshExpiresAt: r.refreshExpiresAt ?? null,
        lastRefreshAt: new Date(),
        lastPingAt: new Date(),
        errorMessage: null,
      },
    })
    return NextResponse.json({
      ok: true,
      session: publicSession(updated as unknown as Record<string, unknown>),
    })
  }

  // Cookie-jar providers (Arena, etc.): keep the session usable — catalog/HTML
  // scrape failures must not 500 the Refresh button.
  const cookieCount = loaded.ctx.cookies?.length || 0
  const softKeep =
    cookieCount > 0 &&
    (loaded.providerKey === 'arena' ||
      loaded.providerKey === 'gemini' ||
      loaded.providerKey === 'dola' ||
      loaded.providerKey === 'claude')

  if (softKeep) {
    const updated = await db.providerSession.update({
      where: { id },
      data: {
        status: 'active',
        lastRefreshAt: new Date(),
        lastPingAt: new Date(),
        errorMessage: (r.error || 'refresh warning').slice(0, 300),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    })
    return NextResponse.json({
      ok: true,
      warning: r.error,
      session: publicSession(updated as unknown as Record<string, unknown>),
    })
  }

  await db.providerSession.update({
    where: { id },
    data: { status: 'error', errorMessage: r.error || 'refresh failed' },
  })
  return NextResponse.json({ ok: false, error: r.error }, { status: 500 })
}
