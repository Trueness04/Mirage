import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAdapter } from '@/lib/providers/base'
import '@/lib/providers'
import { loadSessionContext } from '@/lib/providers/session-loader'
import { requireAdmin } from '@/lib/auth/admin'
import { publicSession } from '@/lib/auth/sanitize'
import {
  enqueueToolJob,
  pickOnlineDeviceId,
  waitForToolJob,
} from '@/lib/tools/local'
import {
  applyDetectedModels,
  importModelsForProvider,
  type ImportModelsResult,
} from '@/lib/providers/model-import'
import { sessionStatusAfterValidate } from '@/lib/providers/session-status'

export async function GET(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const sessions = await db.providerSession.findMany({
    orderBy: { createdAt: 'desc' },
    include: { provider: { select: { key: true, displayName: true, websiteUrl: true } } },
  })
  return NextResponse.json({
    sessions: sessions.map((s) => publicSession(s as unknown as Record<string, unknown>)),
  })
}

export async function DELETE(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  await db.providerSession.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}

/** POST /api/sessions?action=test&id=...  -> validate session */
export async function POST(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const url = new URL(req.url)
  const action = url.searchParams.get('action') || 'test'
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  if (action === 'test' || action === 'test_via_extension') {
    const loaded = await loadSessionContext(id)
    if (!loaded) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    if (action === 'test_via_extension') {
      const session = await db.providerSession.findUnique({ where: { id } })
      const deviceId = await pickOnlineDeviceId(session?.deviceId)
      if (!deviceId) {
        // Fall through to server-side validate
      } else {
        const jobId = await enqueueToolJob({
          deviceId,
          toolName: 'mirage_test_provider',
          arguments: {
            providerKey: loaded.providerKey,
            sessionId: id,
          },
        })
        const waited = await waitForToolJob(jobId, 45_000)
        if (waited.ok) {
          const result = (waited.result || {}) as {
            valid?: boolean
            reason?: string
            detectedModels?: string[]
          }
          const next = sessionStatusAfterValidate({
            valid: !!result.valid,
            reason: result.reason,
            cookieCount: loaded.ctx.cookies?.length || 0,
            hasAccessToken: Boolean(loaded.ctx.accessToken),
          })
          await db.providerSession.update({
            where: { id },
            data: {
              status: next.status,
              errorMessage: next.errorMessage,
            },
          })
          let modelsImport: ImportModelsResult | null = null
          if (next.status === 'active') {
            if (result.detectedModels?.length) {
              await applyDetectedModels(
                loaded.ctx.providerId,
                result.detectedModels,
              )
            }
            modelsImport = await importModelsForProvider(loaded.providerKey)
          }
          return NextResponse.json({
            result: {
              valid: next.status === 'active',
              reason: result.reason,
              detectedModels: result.detectedModels,
            },
            modelsImport,
            via: 'extension',
          })
        }
        // Extension timed out — fall back to server validate below
      }
    }

    const adapter = getAdapter(loaded.providerKey)
    if (!adapter) {
      return NextResponse.json({ error: 'Adapter not found' }, { status: 500 })
    }
    const result = await adapter.validate(loaded.ctx)
    const next = sessionStatusAfterValidate({
      valid: result.valid,
      reason: result.reason,
      cookieCount: loaded.ctx.cookies?.length || 0,
      hasAccessToken: Boolean(loaded.ctx.accessToken),
    })
    await db.providerSession.update({
      where: { id },
      data: {
        status: next.status,
        errorMessage: next.errorMessage,
      },
    })
    let modelsImport: ImportModelsResult | null = null
    if (next.status === 'active') {
      if (result.detectedModels?.length) {
        await applyDetectedModels(loaded.ctx.providerId, result.detectedModels)
      }
      modelsImport = await importModelsForProvider(loaded.providerKey)
    }
    return NextResponse.json({ result, modelsImport, via: 'server' })
  }

  if (action === 'refresh') {
    const loaded = await loadSessionContext(id)
    if (!loaded) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    const adapter = getAdapter(loaded.providerKey)
    if (!adapter) {
      return NextResponse.json({ error: 'Adapter not found' }, { status: 500 })
    }
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
        result: { ok: true },
        session: publicSession(updated as unknown as Record<string, unknown>),
      })
    }
    await db.providerSession.update({
      where: { id },
      data: { status: 'error', errorMessage: r.error || 'refresh failed' },
    })
    return NextResponse.json({ result: r }, { status: 500 })
  }

  if (action === 'update') {
    const body = await req.json().catch(() => ({} as Record<string, unknown>))
    const update: Record<string, unknown> = {}
    if (typeof body.label === 'string') update.label = body.label
    if (typeof body.status === 'string') update.status = body.status
    if (typeof body.priority === 'number') update.priority = body.priority
    const updated = await db.providerSession.update({ where: { id }, data: update })
    return NextResponse.json({
      session: publicSession(updated as unknown as Record<string, unknown>),
    })
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
}
