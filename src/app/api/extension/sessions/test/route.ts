import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeeded } from '@/lib/providers/seed'
import { ensureSchedulerStarted } from '@/lib/scheduler/token-refresh'
import { getAdapter, type CookieJarEntry } from '@/lib/providers/base'
import { syncRuntimeAdaptersFromDb } from '@/lib/providers/runtime'
import {
  isDeviceAuthOk,
  requireExtensionDevice,
} from '@/lib/auth/extension'
import { publicSession } from '@/lib/auth/sanitize'
import { clearCaptureRequest } from '@/lib/extension/providers'
import {
  applyDetectedModels,
  importModelsForProvider,
  type ImportModelsResult,
} from '@/lib/providers/model-import'
import { sessionStatusAfterValidate } from '@/lib/providers/session-status'
import '@/lib/providers'

/**
 * POST /api/extension/sessions/test
 * Extension-driven credential validation (+ optional upsert).
 */
export async function POST(req: Request) {
  await ensureSeeded()
  await syncRuntimeAdaptersFromDb()
  ensureSchedulerStarted()

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const auth = await requireExtensionDevice(req, body)
  if (!isDeviceAuthOk(auth)) return auth

  const providerKey = String(body.providerKey || '').trim()
  if (!providerKey) {
    return NextResponse.json({ error: 'providerKey is required' }, { status: 400 })
  }

  const provider = await db.provider.findUnique({ where: { key: providerKey } })
  if (!provider) {
    return NextResponse.json({ error: `Unknown provider: ${providerKey}` }, { status: 404 })
  }

  const cookies: CookieJarEntry[] = Array.isArray(body.cookies) ? body.cookies : []
  const accessToken =
    typeof body.accessToken === 'string' ? body.accessToken.trim() || undefined : undefined
  const refreshToken =
    typeof body.refreshToken === 'string'
      ? body.refreshToken.trim() || undefined
      : undefined

  const adapter = getAdapter(provider.key)
  if (!adapter) {
    return NextResponse.json({ error: 'Adapter not found' }, { status: 500 })
  }

  const validation = await adapter.validate({
    providerId: provider.id,
    providerKey: provider.key,
    cookies,
    accessToken,
    refreshToken,
  })

  let session: Awaited<ReturnType<typeof db.providerSession.create>> | null = null
  const upsert = body.upsert !== false
  if (upsert && (cookies.length > 0 || accessToken)) {
    const deviceId = auth.device.deviceId
    const existing = await db.providerSession.findFirst({
      where: { providerId: provider.id, deviceId },
    })
    const now = new Date()
    const next = sessionStatusAfterValidate({
      valid: validation.valid,
      reason: validation.reason,
      cookieCount: cookies.length,
      hasAccessToken: Boolean(accessToken || existing?.accessToken),
    })
    const data = {
      cookies: JSON.stringify(cookies),
      accessToken: accessToken || existing?.accessToken || null,
      refreshToken: refreshToken || existing?.refreshToken || null,
      deviceId,
      browser: String(body.browser || 'chrome').slice(0, 32),
      lastRefreshAt: now,
      lastPingAt: now,
      status: next.status,
      errorMessage: next.errorMessage,
    }
    if (existing) {
      session = await db.providerSession.update({
        where: { id: existing.id },
        data,
      })
    } else {
      const siblings = await db.providerSession.count({
        where: { providerId: provider.id },
      })
      session = await db.providerSession.create({
        data: {
          providerId: provider.id,
          label: `${provider.displayName} · test`,
          priority: siblings === 0 ? 0 : 1,
          ...data,
        },
      })
    }
    if (next.status === 'active') await clearCaptureRequest(providerKey)
  }

  // Pull live catalog whenever the jar stayed active (incl. soft warnings).
  let modelsImport: ImportModelsResult | null = null
  const keptActive = session?.status === 'active'
  if (keptActive) {
    if (validation.detectedModels?.length) {
      await applyDetectedModels(provider.id, validation.detectedModels)
    }
    modelsImport = await importModelsForProvider(provider.key)
  }

  return NextResponse.json({
    valid: keptActive,
    reason: validation.reason,
    detectedModels: validation.detectedModels,
    modelsImport,
    session: session
      ? publicSession(session as unknown as Record<string, unknown>)
      : null,
  })
}
