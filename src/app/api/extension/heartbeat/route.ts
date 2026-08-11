import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeeded } from '@/lib/providers/seed'
import { ensureSchedulerStarted } from '@/lib/scheduler/token-refresh'
import {
  isDeviceAuthOk,
  requireExtensionDevice,
} from '@/lib/auth/extension'
import {
  extensionFallbackHint,
  listExtensionProviders,
} from '@/lib/extension/providers'
import { listPendingToolJobs, markToolJobRunning } from '@/lib/tools/local'

/**
 * Heartbeat. Body: { deviceId, deviceSecret, sessions: [...], capabilities?: string[] }
 * Returns providers + pending local tool jobs so the extension stays in sync.
 */
export async function POST(req: Request) {
  await ensureSeeded()
  ensureSchedulerStarted()

  const body = await req.json().catch(() => ({} as Record<string, unknown>))

  const deviceId = String(body.deviceId || '').trim()
  if (!deviceId) {
    return NextResponse.json({ error: 'deviceId is required' }, { status: 400 })
  }

  const existing = await db.extensionDevice.findUnique({ where: { deviceId } })
  if (!existing) {
    await db.extensionDevice.upsert({
      where: { deviceId },
      update: { lastSeenAt: new Date() },
      create: {
        deviceId,
        displayName: 'Mirage (pending register)',
        lastSeenAt: new Date(),
        enabled: true,
      },
    })
    return NextResponse.json(
      {
        ok: false,
        error: 'Device not registered. Call /api/extension/register first.',
      },
      { status: 401 },
    )
  }

  const auth = await requireExtensionDevice(req, body)
  if (!isDeviceAuthOk(auth)) return auth

  const version =
    typeof body.version === 'string' ? body.version.trim().slice(0, 32) : ''
  await db.extensionDevice.update({
    where: { deviceId },
    data: {
      lastSeenAt: new Date(),
      ...(version ? { version } : {}),
    },
  })

  const sessions = Array.isArray(body.sessions) ? body.sessions : []
  let updated = 0
  for (const s of sessions) {
    const sessionId = String((s as Record<string, unknown>).sessionId || '')
    if (!sessionId) continue
    const cookies = (s as Record<string, unknown>).cookies
    const data: { lastPingAt: Date; cookies?: string } = {
      lastPingAt: new Date(),
    }
    if (Array.isArray(cookies) && cookies.length > 0) {
      data.cookies = JSON.stringify(cookies)
    }
    const result = await db.providerSession.updateMany({
      where: { id: sessionId, deviceId },
      data,
    })
    updated += result.count
  }

  const providers = await listExtensionProviders()
  const fallbackHint = await extensionFallbackHint()

  // Drop stale OAuth flags / tool jobs that pile up and thrash the extension.
  const captureStaleBefore = new Date(Date.now() - 10 * 60_000)
  await db.provider.updateMany({
    where: { captureRequestedAt: { lt: captureStaleBefore } },
    data: { captureRequestedAt: null },
  })
  // Orphaned running jobs: give browser_fetch longer (streams); short tools 90s.
  const shortStale = new Date(Date.now() - 90_000)
  const longStale = new Date(Date.now() - 3 * 60_000)
  const running = await db.extensionToolJob.findMany({
    where: {
      deviceId,
      status: 'running',
      createdAt: { lt: shortStale },
    },
    select: { id: true, toolName: true, createdAt: true },
  })
  for (const job of running) {
    const isLong =
      job.toolName === 'mirage_browser_fetch' ||
      job.toolName === 'mirage_capture_provider'
    if (isLong && job.createdAt > longStale) continue
    await db.extensionToolJob.update({
      where: { id: job.id },
      data: { status: 'pending', error: null, completedAt: null },
    })
  }
  const jobStaleBefore = new Date(Date.now() - 5 * 60_000)
  await db.extensionToolJob.updateMany({
    where: {
      deviceId,
      status: { in: ['pending', 'running'] },
      createdAt: { lt: jobStaleBefore },
    },
    data: {
      status: 'error',
      error: 'stale_timeout',
      completedAt: new Date(),
    },
  })

  // Prefer chat tools over OAuth/sync so Claude/Arena/Kimi stay responsive.
  const pendingRaw = await listPendingToolJobs(deviceId, 8)
  const rank = (name: string) => {
    if (name === 'mirage_browser_fetch') return 0
    if (name === 'mirage_zai_captcha') return 1
    if (name === 'mirage_test_provider') return 2
    if (name === 'mirage_sync_providers') return 3
    if (name === 'mirage_capture_provider') return 4
    return 5
  }
  const pending = pendingRaw
    .slice()
    .sort(
      (a, b) =>
        rank(a.toolName) - rank(b.toolName) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    )
    .slice(0, 3)
  const pendingTools: Array<{
    id: string
    toolName: string
    arguments: unknown
  }> = []
  for (const job of pending) {
    await markToolJobRunning(job.id)
    let args: unknown = {}
    try {
      args = JSON.parse(job.arguments || '{}')
    } catch {
      args = {}
    }
    pendingTools.push({
      id: job.id,
      toolName: job.toolName,
      arguments: args,
    })
  }

  return NextResponse.json({
    ok: true,
    ts: Date.now(),
    updated,
    providers,
    fallbackHint,
    pendingTools,
    capabilities: ['tools', 'capture', 'test'],
  })
}
