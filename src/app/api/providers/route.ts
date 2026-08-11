import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeeded } from '@/lib/providers/seed'
import { ensureSchedulerStarted } from '@/lib/scheduler/token-refresh'
import { probePlatform } from '@/lib/providers/probe'
import {
  ensureRuntimeAdapter,
  normalizeProviderKey,
} from '@/lib/providers/runtime'
import { requireAdmin } from '@/lib/auth/admin'
import {
  normalizeWebsiteUrl,
  notifyDevicesToCapture,
  websiteUrlFromProviderKey,
} from '@/lib/extension/notify-capture'
import '@/lib/providers'

export async function GET(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  await ensureSeeded()
  const providers = await db.provider.findMany({
    orderBy: { key: 'asc' },
    include: {
      sessions: {
        select: {
          id: true,
          label: true,
          status: true,
          browser: true,
          priority: true,
          deviceId: true,
          lastRefreshAt: true,
          expiresAt: true,
          lastPingAt: true,
          requestCount: true,
          errorMessage: true,
        },
        orderBy: [{ priority: 'asc' }, { lastRefreshAt: 'desc' }],
      },
      models: { where: { enabled: true } },
    },
  })
  return NextResponse.json({ providers })
}

/**
 * POST /api/providers
 * Body: {
 *   action?: "probe" | "create"   (default create)
 *   key?, displayName, websiteUrl, apiBaseUrl?,
 *   models?: string[] | {modelKey, displayName}[],
 *   adapterKind?: "cookie" | "openai_compat"
 * }
 */
export async function POST(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  await ensureSeeded()
  ensureSchedulerStarted()

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const action = String(body.action || 'create')

  if (action === 'recapture' || action === 'connect') {
    const key = String(body.key || '').trim()
    if (!key) {
      return NextResponse.json({ error: 'key is required' }, { status: 400 })
    }
    let provider = await db.provider.findUnique({ where: { key } })
    if (!provider) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
    }
    let websiteUrl =
      normalizeWebsiteUrl(provider.websiteUrl) ||
      normalizeWebsiteUrl(String(body.websiteUrl || '')) ||
      websiteUrlFromProviderKey(provider.key)
    if (!websiteUrl) {
      return NextResponse.json(
        {
          error:
            'Provider has no websiteUrl. Pass websiteUrl in the connect request.',
        },
        { status: 400 },
      )
    }
    if (websiteUrl !== provider.websiteUrl) {
      provider = await db.provider.update({
        where: { key },
        data: { websiteUrl, captureRequestedAt: new Date() },
      })
    } else {
      await db.provider.update({
        where: { key },
        data: { captureRequestedAt: new Date() },
      })
    }
    const notified = await notifyDevicesToCapture({
      providerKey: provider.key,
      websiteUrl,
    })
    return NextResponse.json({
      ok: true,
      loginUrl: websiteUrl,
      websiteUrl,
      ...notified,
      message:
        notified.online > 0
          ? `Extension will open ${websiteUrl} and wait for your login (up to ~4 min), then send the session back.`
          : notified.notified > 0
            ? `Queued connect for ${notified.notified} extension(s). Open Mirage extension / reload it, then sign in at ${websiteUrl}.`
            : `No extension registered. Install Mirage extension, then Connect again.`,
    })
  }

  const websiteUrl = normalizeWebsiteUrl(String(body.websiteUrl || ''))
  if (!websiteUrl) {
    return NextResponse.json(
      {
        error:
          'websiteUrl is required (e.g. https://hooshemasnoei.com or hooshemasnoei.com)',
      },
      { status: 400 },
    )
  }

  const apiBaseUrl = body.apiBaseUrl
    ? String(body.apiBaseUrl).trim().replace(/\/+$/, '')
    : undefined

  if (action === 'probe') {
    const probe = await probePlatform({ websiteUrl, apiBaseUrl })
    return NextResponse.json({ probe })
  }

  // ── create ────────────────────────────────────────────────────────
  const displayName =
    String(body.displayName || '').trim() ||
    (() => {
      try {
        return new URL(websiteUrl).hostname.replace(/^www\./, '')
      } catch {
        return 'Custom Platform'
      }
    })()

  let key: string
  try {
    key = normalizeProviderKey(
      String(body.key || '').trim() ||
        new URL(websiteUrl).hostname.replace(/^www\./, ''),
    )
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }

  const existing = await db.provider.findUnique({ where: { key } })
  if (existing) {
    return NextResponse.json(
      { error: `Provider key "${key}" already exists` },
      { status: 409 },
    )
  }

  const probe = await probePlatform({ websiteUrl, apiBaseUrl })
  if (!probe.ok) {
    return NextResponse.json(
      {
        error: probe.error || 'Probe failed',
        probe,
      },
      { status: 400 },
    )
  }

  const resolvedApiBase = apiBaseUrl || probe.suggestedApiBaseUrl || null
  const adapterKind =
    String(body.adapterKind || '') === 'cookie'
      ? 'cookie'
      : resolvedApiBase || probe.openaiCompat
        ? 'openai_compat'
        : 'cookie'

  const modelInputs = normalizeModels(body.models, probe.detectedModels, displayName)

  const provider = await db.provider.create({
    data: {
      key,
      displayName,
      websiteUrl,
      apiBaseUrl: resolvedApiBase,
      adapterKind,
      authType: adapterKind === 'openai_compat' ? 'bearer' : 'cookie',
      refreshTtlSec: 24 * 60 * 60,
      sessionTtlSec: 30 * 24 * 60 * 60,
      pingIntervalSec: 60 * 60,
      enabled: true,
      captureRequestedAt: new Date(),
      models: {
        create: modelInputs.map((m, i) => ({
          modelKey: m.modelKey,
          displayName: m.displayName,
          upstreamName: m.modelKey,
          contextWindow: 128000,
          supportsStream: true,
          isDefault: i === 0,
        })),
      },
    },
    include: { models: true },
  })

  ensureRuntimeAdapter({
    key: provider.key,
    displayName: provider.displayName,
    websiteUrl: provider.websiteUrl,
    adapterKind: provider.adapterKind,
    apiBaseUrl: provider.apiBaseUrl,
    models: provider.models,
  })

  // Tell extension immediately: refresh catalog + open OAuth capture.
  const notified = await notifyDevicesToCapture({
    providerKey: provider.key,
    websiteUrl: provider.websiteUrl,
  })
  const loginUrl = provider.websiteUrl
  return NextResponse.json({
    ok: true,
    provider,
    probe,
    loginUrl,
    devicesNotified: notified.notified,
    online: notified.online,
    message:
      notified.online > 0
        ? `Platform added. Extension refreshed and will open OAuth at ${loginUrl} — sign in there.`
        : notified.notified > 0
          ? `Platform added. Queued sync/capture for ${notified.notified} extension(s). Reload Mirage extension if offline.`
          : `Platform added. No extension registered — install Mirage extension, then Connect OAuth.`,
  })
}

export async function PATCH(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const id = String(body.id || '')
  const key = body.key ? String(body.key) : ''
  if (!id && !key) {
    return NextResponse.json({ error: 'id or key is required' }, { status: 400 })
  }

  const update: Record<string, unknown> = {}
  if (typeof body.enabled === 'boolean') update.enabled = body.enabled
  if (typeof body.displayName === 'string') update.displayName = body.displayName
  if (typeof body.websiteUrl === 'string') {
    const url = normalizeWebsiteUrl(body.websiteUrl)
    if (url) update.websiteUrl = url
  }
  if (typeof body.pingIntervalSec === 'number') update.pingIntervalSec = body.pingIntervalSec
  if (typeof body.refreshTtlSec === 'number') update.refreshTtlSec = body.refreshTtlSec
  if (typeof body.sessionTtlSec === 'number') update.sessionTtlSec = body.sessionTtlSec
  if (typeof body.apiBaseUrl === 'string') {
    update.apiBaseUrl = body.apiBaseUrl.trim().replace(/\/+$/, '') || null
  }
  if (typeof body.adapterKind === 'string') update.adapterKind = body.adapterKind
  if (typeof body.priority === 'number') {
    // not on provider
  }

  if (body.action === 'clearSessions') {
    const where = id ? { id } : { key }
    const existing = await db.provider.findUnique({ where })
    if (!existing) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
    }
    const deleted = await db.providerSession.deleteMany({
      where: { providerId: existing.id },
    })
    return NextResponse.json({
      ok: true,
      clearedSessions: deleted.count,
      provider: existing.key,
    })
  }

  if (body.action === 'clearRemoteChats') {
    const providerKey = key || ''
    if (!providerKey) {
      return NextResponse.json(
        { error: 'key is required for clearRemoteChats' },
        { status: 400 },
      )
    }
    const { clearRemoteChatsForProvider } = await import(
      '@/lib/providers/clear-remote'
    )
    const result = await clearRemoteChatsForProvider(providerKey, {
      mirageOnly: body.mirageOnly !== false,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
    })
    return NextResponse.json(result, { status: result.ok ? 200 : 400 })
  }

  const where = id ? { id } : { key }
  const updated = await db.provider.update({ where, data: update })

  if (updated.adapterKind !== 'builtin') {
    const models = await db.providerModel.findMany({
      where: { providerId: updated.id, enabled: true },
    })
    ensureRuntimeAdapter({
      key: updated.key,
      displayName: updated.displayName,
      websiteUrl: updated.websiteUrl,
      adapterKind: updated.adapterKind,
      apiBaseUrl: updated.apiBaseUrl,
      models,
    })
  }

  return NextResponse.json({ provider: updated })
}

/**
 * DELETE /api/providers?all=1 — wipe every provider including builtins.
 * DELETE /api/providers?id=… or ?key=… — delete one provider.
 * Optional: ?restoreDefaults=1 with POST action handled elsewhere.
 */
export async function DELETE(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const url = new URL(req.url)
  const wipeAll = url.searchParams.get('all') === '1'
  const restore = url.searchParams.get('restoreDefaults') === '1'
  const id = url.searchParams.get('id') || ''
  const key = url.searchParams.get('key') || ''

  if (restore) {
    const { restoreBuiltinProviders } = await import('@/lib/providers/seed')
    await restoreBuiltinProviders()
    return NextResponse.json({ ok: true, restored: true })
  }

  if (wipeAll) {
    const { wipeAllProviders } = await import('@/lib/providers/seed')
    await wipeAllProviders()
    return NextResponse.json({ ok: true, wiped: true })
  }

  if (!id && !key) {
    return NextResponse.json(
      { error: 'Pass all=1, or id / key of a provider to delete' },
      { status: 400 },
    )
  }

  const where = id ? { id } : { key }
  const existing = await db.provider.findUnique({ where })
  if (!existing) {
    return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  }
  await db.providerSession.deleteMany({ where: { providerId: existing.id } })
  await db.providerModel.deleteMany({ where: { providerId: existing.id } })
  await db.provider.delete({ where: { id: existing.id } })
  const { rememberDeletedBuiltin } = await import('@/lib/providers/seed')
  await rememberDeletedBuiltin(existing.key)
  return NextResponse.json({ ok: true, deleted: existing.key })
}

function normalizeModels(
  raw: unknown,
  detected: string[],
  displayName: string,
): Array<{ modelKey: string; displayName: string }> {
  const out: Array<{ modelKey: string; displayName: string }> = []
  if (Array.isArray(raw) && raw.length > 0) {
    for (const item of raw) {
      if (typeof item === 'string' && item.trim()) {
        const modelKey = item.trim()
        out.push({ modelKey, displayName: modelKey })
      } else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        const modelKey = String(o.modelKey || o.id || '').trim()
        if (!modelKey) continue
        out.push({
          modelKey,
          displayName: String(o.displayName || modelKey),
        })
      }
    }
  }
  if (out.length === 0 && detected.length > 0) {
    for (const id of detected) {
      if (!id || id === 'default') continue
      out.push({ modelKey: id, displayName: id })
    }
  }
  // No fake "default" row — models are imported from the live /models API
  // after the extension captures a session.
  return out
}
