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
} from '@/lib/providers/model-import'
import { sessionStatusAfterValidate } from '@/lib/providers/session-status'
import {
  hasProviderAuthMaterial,
  isAuthDowngrade,
  mergeCookieJars,
  parseCookieJar,
} from '@/lib/providers/cookie-jar'
import '@/lib/providers'

/**
 * Extension POSTs captured cookies + tokens for a specific provider.
 * Requires deviceId + deviceSecret. Upserts by (providerId + deviceId).
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
  if (!provider.enabled) {
    return NextResponse.json({ error: `Provider ${providerKey} is disabled` }, { status: 403 })
  }

  const deviceId = auth.device.deviceId
  const cookies: CookieJarEntry[] = Array.isArray(body.cookies) ? body.cookies : []
  const browser = normalizeBrowser(body.browser || auth.device)
  // Capture real browser User-Agent (extension sends it in body, fallback to HTTP header)
  const userAgent: string | null =
    (typeof body.userAgent === 'string' && body.userAgent.trim()) ||
    req.headers.get('user-agent') ||
    null
  const label =
    body.label != null && String(body.label).trim()
      ? String(body.label).trim()
      : `${provider.displayName} · ${browser}`

  const siblingSessions = await db.providerSession.findMany({
    where: { providerId: provider.id },
    select: { id: true, deviceId: true, priority: true },
  })

  const existingRow = siblingSessions.find((s) => s.deviceId === deviceId)
  const existingFull = existingRow
    ? await db.providerSession.findUnique({ where: { id: existingRow.id } })
    : null

  let priority = 0
  if (existingFull) {
    priority = existingFull.priority ?? 0
  } else {
    const otherDevices = new Set(
      siblingSessions.map((s) => s.deviceId).filter(Boolean) as string[],
    )
    priority = otherDevices.size === 0 ? 0 : 1
  }

  const fromBodyAccess = trimToken(body.accessToken)
  const fromBodyRefresh = trimToken(body.refreshToken)
  const fromCookiesAccess = findCookieValue(cookies, [
    'access_token',
    'accessToken',
    'userToken',
    'token',
    'sessionKey',
    'tongyi_sso_ticket',
    'login_aliyunid_ticket',
    'login_aliyunid_sso',
  ])
  const fromCookiesRefresh = findCookieValue(cookies, [
    'refresh_token',
    'refreshToken',
  ])

  const existingCookies = parseCookieJar(existingFull?.cookies)
  const incomingAccess = fromBodyAccess || fromCookiesAccess || null
  const incomingRefresh = fromBodyRefresh || fromCookiesRefresh || null

  // Never let analytics-only re-harvest wipe a good auth jar.
  if (
    existingFull &&
    isAuthDowngrade({
      providerKey: provider.key,
      existingCookies,
      incomingCookies: cookies,
      existingAccess: existingFull.accessToken,
      existingRefresh: existingFull.refreshToken,
      incomingAccess,
      incomingRefresh,
    })
  ) {
    return NextResponse.json({
      skipped: true,
      reason: 'auth_downgrade',
      session: publicSession(existingFull as unknown as Record<string, unknown>),
      message:
        'Ignored capture that would overwrite auth cookies with a weaker jar.',
    })
  }

  const mergedCookies = existingFull
    ? mergeCookieJars(existingCookies, cookies)
    : cookies

  const now = new Date()
  const expiresAt = provider.refreshTtlSec
    ? new Date(now.getTime() + provider.refreshTtlSec * 1000)
    : null
  const refreshExpiresAt = provider.sessionTtlSec
    ? new Date(now.getTime() + provider.sessionTtlSec * 1000)
    : null

  const data = {
    cookies: JSON.stringify(mergedCookies),
    accessToken:
      incomingAccess || existingFull?.accessToken || null,
    refreshToken:
      incomingRefresh || existingFull?.refreshToken || null,
    deviceId,
    browser,
    userAgent: userAgent || existingFull?.userAgent || null,
    priority,
    label,
    expiresAt,
    refreshExpiresAt,
    lastRefreshAt: now,
    lastPingAt: now,
    status: 'active' as 'active' | 'error',
    errorMessage: null as string | null,
  }

  // Qwen dual-mode:
  //  - tongyi_* cookies → Chinese HTTP/2 dialog API
  //  - chat.qwen.ai JWT / token cookie → International v2 viaBrowser
  if (provider.key === 'qwen' || /chat\.qwen\.ai/i.test(provider.websiteUrl || '')) {
    const ticket = findCookieValue(mergedCookies, [
      'tongyi_sso_ticket',
      'login_aliyunid_ticket',
      'login_aliyunid_sso',
    ])
    const tokenCookie = findCookieValue(mergedCookies, ['token'])
    if (ticket) {
      data.accessToken = ticket
    } else if (tokenCookie && tokenCookie.length > 8) {
      data.accessToken = tokenCookie
    } else if (data.accessToken && data.accessToken.length > 8) {
      // Keep JWT (intl) or opaque ticket pasted as accessToken.
    } else {
      data.accessToken = null
      data.status = 'error'
      data.errorMessage =
        'Qwen missing auth. Chinese: log in at https://tongyi.aliyun.com/qianwen (tongyi_sso_ticket). ' +
        'International: log in at https://chat.qwen.ai (token / JWT), keep tab open, Capture again.'
    }
  }

  // Arena / Claude / etc: refuse to mark active without real auth material.
  if (
    !hasProviderAuthMaterial(
      provider.key,
      mergedCookies,
      data.accessToken,
      data.refreshToken,
    )
  ) {
    data.status = 'error'
    data.errorMessage =
      data.errorMessage ||
      `${provider.displayName} capture missing auth cookies/tokens. Open the OAuth login link from the web app, sign in, then Connect again.`
  }

  // Kimi: promote refresh_token → access_token before validate/chat.
  const adapterEarly = getAdapter(provider.key)
  if (
    provider.key === 'kimi' &&
    adapterEarly &&
    !data.accessToken &&
    data.refreshToken
  ) {
    const refreshed = await adapterEarly.refresh({
      providerId: provider.id,
      providerKey: provider.key,
      cookies,
      accessToken: undefined,
      refreshToken: data.refreshToken,
    })
    if (refreshed.ok && refreshed.accessToken) {
      data.accessToken = refreshed.accessToken
      data.refreshToken = refreshed.refreshToken || data.refreshToken
      if (refreshed.cookies) {
        data.cookies = JSON.stringify(refreshed.cookies)
      }
      if (refreshed.expiresAt) data.expiresAt = refreshed.expiresAt
      if (refreshed.refreshExpiresAt) {
        data.refreshExpiresAt = refreshed.refreshExpiresAt
      }
    }
  }

  let session
  if (existingFull) {
    session = await db.providerSession.update({
      where: { id: existingFull.id },
      data,
    })
  } else {
    session = await db.providerSession.create({
      data: {
        providerId: provider.id,
        ...data,
      },
    })
  }

  await db.extensionDevice.updateMany({
    where: { deviceId },
    data: { browser, lastSeenAt: now },
  })

  let validation: { valid: boolean; reason?: string; detectedModels?: string[] } | null =
    null
  let modelsImport: Awaited<ReturnType<typeof importModelsForProvider>> | null =
    null
  const adapter = adapterEarly || getAdapter(provider.key)
  if (adapter) {
    const jarCookies: CookieJarEntry[] = (() => {
      try {
        return JSON.parse(data.cookies) as CookieJarEntry[]
      } catch {
        return cookies
      }
    })()
    validation = await adapter.validate({
      providerId: provider.id,
      providerKey: provider.key,
      cookies: jarCookies,
      accessToken: data.accessToken || undefined,
      refreshToken: data.refreshToken || undefined,
    })
    const next = sessionStatusAfterValidate({
      valid: validation.valid,
      reason: validation.reason,
      cookieCount: jarCookies.length,
      hasAccessToken: Boolean(data.accessToken),
    })
    session = await db.providerSession.update({
      where: { id: session.id },
      data: {
        status: next.status,
        errorMessage: next.errorMessage,
      },
    })

    // Import whenever the jar was kept active (including soft warnings).
    if (next.status === 'active') {
      if (validation.detectedModels?.length) {
        await applyDetectedModels(provider.id, validation.detectedModels)
      }
      modelsImport = await importModelsForProvider(provider.key)
    }
  }

  if (!validation || session.status === 'active') {
    await clearCaptureRequest(provider.key)
  }

  return NextResponse.json({
    session: publicSession(session as unknown as Record<string, unknown>),
    role: priority === 0 ? 'primary' : 'fallback',
    validation,
    modelsImport,
  })
}

function normalizeBrowser(v: unknown): string {
  if (v && typeof v === 'object' && 'browser' in v) {
    return normalizeBrowser((v as { browser?: string }).browser)
  }
  const s = String(v || '')
    .toLowerCase()
    .trim()
  if (s.includes('edg')) return 'edge'
  if (s.includes('firefox') || s.includes('fx')) return 'firefox'
  if (s.includes('chrome') || s.includes('chromium')) return 'chrome'
  if (s) return s.slice(0, 32)
  return 'chrome'
}

function trimToken(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t || t === 'null' || t === 'undefined') return null
  // DeepSeek (and similar) store localStorage as {"value":"...","__version":"0"}
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { value?: unknown }
      if (typeof j.value === 'string' && j.value.trim()) {
        return j.value.trim().replace(/^Bearer\s+/i, '')
      }
    } catch {
      // keep raw string
    }
  }
  return t.replace(/^Bearer\s+/i, '')
}

function findCookieValue(
  cookies: CookieJarEntry[],
  names: string[],
): string | null {
  const lower = new Set(names.map((n) => n.toLowerCase()))
  for (const c of cookies) {
    if (lower.has(c.name.toLowerCase()) && c.value?.trim()) {
      return trimToken(c.value)
    }
  }
  return null
}

function isJwtLike(value: string): boolean {
  const parts = value.replace(/^Bearer\s+/i, '').trim().split('.')
  return parts.length === 3 && parts.every((p) => p.length > 4)
}
