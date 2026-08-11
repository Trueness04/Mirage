import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeeded } from '@/lib/providers/seed'
import { ensureSchedulerStarted } from '@/lib/scheduler/token-refresh'
import { requireAdmin } from '@/lib/auth/admin'
import { publicSession } from '@/lib/auth/sanitize'
import { isChatCapableProvider } from '@/lib/providers/chat-ready'

export async function GET(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  await ensureSeeded()
  ensureSchedulerStarted()

  const [providers, sessions, keys, devices, recentLogs] = await Promise.all([
    db.provider.findMany({
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
        },
        models: true,
      },
      orderBy: { key: 'asc' },
    }),
    db.providerSession.findMany({
      select: {
        id: true,
        label: true,
        status: true,
        browser: true,
        priority: true,
        deviceId: true,
        lastRefreshAt: true,
        lastPingAt: true,
        expiresAt: true,
        requestCount: true,
        errorMessage: true,
        providerId: true,
        cookies: true,
        accessToken: true,
        refreshToken: true,
        provider: { select: { key: true, displayName: true } },
      },
      orderBy: { lastRefreshAt: 'desc' },
    }),
    db.apiKey.findMany({
      select: {
        id: true,
        keyPrefix: true,
        label: true,
        sessionIds: true,
        rateLimitRpm: true,
        enabled: true,
        createdAt: true,
      },
    }),
    db.extensionDevice.findMany({
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        deviceId: true,
        displayName: true,
        browser: true,
        version: true,
        lastSeenAt: true,
        enabled: true,
        // never return secretHash
      },
    }),
    db.requestLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { apiKey: { select: { keyPrefix: true, label: true } } },
    }),
  ])

  const activeSessions = sessions.filter((s) => s.status === 'active').length
  const expiredSessions = sessions.filter((s) => s.status === 'expired').length
  const errorSessions = sessions.filter((s) => s.status === 'error').length
  const totalRequests = await db.requestLog.count()

  const onlineSince = new Date(Date.now() - 90_000)
  const onlineDevices = devices.filter(
    (d) => d.enabled && d.lastSeenAt && d.lastSeenAt >= onlineSince,
  ).length

  const providerStats = providers.map((p) => {
    const provSessions = sessions.filter((s) => s.providerId === p.id)
    const active = provSessions.filter((s) => s.status === 'active')
    const enabledModels = p.models.filter((m) => m.enabled)
    const modelCount = enabledModels.length
    const hasBearer = active.some((s) => Boolean(s.accessToken?.trim()))
    let modelsHint: string | null = null
    if (active.length > 0 && modelCount === 0) {
      if (p.key === 'arena') {
        modelsHint =
          'Click Import — Arena models come from HTML (initialModels), not OpenAI /models. Chat needs arena-auth-prod-v1 after login.'
      } else if (p.key === 'dola') {
        modelsHint =
          'Click Import — syncs dola-speed / dola-pro. Chat needs sessionid + s_v_web_id from dola.com/chat.'
      } else if (p.key === 'gemini') {
        modelsHint =
          'Click Import — syncs Gemini web models. Needs __Secure-1PSID (+ PSIDTS) from gemini.google.com.'
      } else if (p.key === 'qwen') {
        modelsHint =
          'Click Import — live fetch from chat.qwen.ai/api/v2/models (fallback: Tongyi Free-API list).'
      } else if (p.key === 'hooshemasnoei-com' || /hoosh/i.test(p.key)) {
        modelsHint =
          'Site has no public /models (API often 502). Log into the panel, send one chat, Retry capture for real auth/localStorage — analytics cookies alone are not enough.'
      } else if (p.adapterKind === 'openai_compat' || p.apiBaseUrl?.trim()) {
        modelsHint = hasBearer
          ? 'Import failed: apiBaseUrl /models must return JSON (not the website HTML).'
          : 'No API token in capture — open the site logged-in, use chat once, then Retry capture.'
      } else if (!isChatCapableProvider(p)) {
        modelsHint =
          'No OpenAI /models on this site. Use Import after a dedicated adapter exists, or set an OpenAI-compatible API Base URL + token.'
      }
    }
    return {
      key: p.key,
      displayName: p.displayName,
      websiteUrl: p.websiteUrl,
      enabled: p.enabled,
      adapterKind: p.adapterKind,
      apiBaseUrl: p.apiBaseUrl,
      sessionCount: provSessions.length,
      activeSessions: active.length,
      models: modelCount,
      // Cap list for UI (HF-sized catalogs freeze Playground selects).
      // Keep real keys including DeepSeek's live "default" (Instant).
      modelsList: enabledModels.slice(0, 80).map((m) => ({
        modelKey: m.modelKey,
        displayName: m.displayName,
      })),
      captureRequestedAt: p.captureRequestedAt
        ? p.captureRequestedAt.toISOString()
        : null,
      waitingForExtension: Boolean(
        p.captureRequestedAt && active.length === 0,
      ),
      missingWebsiteUrl: !p.websiteUrl,
      chatCapable: isChatCapableProvider(p),
      modelsHint,
      hasAuthToken: hasBearer,
    }
  })

  const safeSessions = sessions
    .slice()
    .sort((a, b) => {
      if (a.providerId !== b.providerId) return 0
      return (a.priority ?? 0) - (b.priority ?? 0)
    })
    .slice(0, 100)
    .map((s) => publicSession(s as unknown as Record<string, unknown>))

  return NextResponse.json({
    stats: {
      providers: providers.length,
      activeSessions,
      expiredSessions,
      errorSessions,
      apiKeys: keys.length,
      devices: devices.length,
      onlineDevices,
      totalRequests,
    },
    providers: providerStats,
    sessions: safeSessions,
    devices,
    apiKeys: keys,
    recentLogs,
  })
}
