/**
 * Token Refresh Scheduler
 * --------------------------------------------------------------------
 * Periodically refreshes bearer sessions on an interval (pingInterval /
 * refreshTtl) and when access tokens are near expiry.
 */

import { db } from '@/lib/db'
import { getAdapter } from '@/lib/providers/base'
import '@/lib/providers'
import { loadSessionContext } from '@/lib/providers/session-loader'

const TICK_MS = 60 * 1000
/** Refresh when fewer than this many seconds remain (or 10% of TTL). */
import { startSelfHealing } from './self-healing'

const REFRESH_SKEW_SEC = 60

const globalSched = globalThis as unknown as {
  __mirageRefreshTimer?: NodeJS.Timeout | null
}

export function ensureSchedulerStarted() {
  startSelfHealing()
  if (globalSched.__mirageRefreshTimer) return
  globalSched.__mirageRefreshTimer = setInterval(() => {
    tick().catch((e) => {
      console.error('[scheduler] tick failed:', e)
    })
  }, TICK_MS)
  tick().catch(() => {})
}

function skewMs(refreshTtlSec: number): number {
  const tenPercent = Math.floor(refreshTtlSec * 0.1) * 1000
  return Math.max(REFRESH_SKEW_SEC * 1000, tenPercent)
}

/** How often to proactively refresh (kimi/gemini default ping = 10m). */
function refreshIntervalMs(provider: {
  pingIntervalSec: number
  refreshTtlSec: number
}): number {
  const sec = Math.min(
    provider.pingIntervalSec || provider.refreshTtlSec || 900,
    provider.refreshTtlSec || provider.pingIntervalSec || 900,
  )
  return Math.max(60_000, sec * 1000)
}

async function tick() {
  const now = new Date()

  const sessions = await db.providerSession.findMany({
    where: {
      status: { in: ['active', 'refreshing', 'error'] },
    },
    include: { provider: true },
  })

  for (const session of sessions) {
    try {
      const provider = session.provider
      const ctx = (await loadSessionContext(session.id))?.ctx
      if (!ctx) continue
      const adapter = getAdapter(provider.key)
      if (!adapter) continue

      const accessExpiresAt = session.expiresAt
      const remainingMs = accessExpiresAt
        ? accessExpiresAt.getTime() - now.getTime()
        : -1

      const intervalMs = refreshIntervalMs(provider)
      const sinceRefreshMs = session.lastRefreshAt
        ? now.getTime() - session.lastRefreshAt.getTime()
        : Number.POSITIVE_INFINITY

      // Cookie-only holders: never force-refresh into error; ping is enough.
      const cookieOnly =
        provider.adapterKind === 'cookie' && !provider.apiBaseUrl

      // Proactive refresh every interval OR when near expiry / missing expiry.
      const dueByInterval = sinceRefreshMs >= intervalMs
      const dueByExpiry =
        !accessExpiresAt || remainingMs < skewMs(provider.refreshTtlSec)
      const needsRefresh = !cookieOnly && (dueByInterval || dueByExpiry)

      if (needsRefresh) {
        await db.providerSession.update({
          where: { id: session.id },
          data: { status: 'refreshing' },
        })
        const result = await adapter.refresh(ctx)
        if (result.ok) {
          await db.providerSession.update({
            where: { id: session.id },
            data: {
              status: 'active',
              accessToken: result.accessToken ?? session.accessToken,
              refreshToken: result.refreshToken ?? session.refreshToken,
              cookies: result.cookies
                ? JSON.stringify(result.cookies)
                : session.cookies,
              expiresAt:
                result.expiresAt ??
                new Date(now.getTime() + (provider.refreshTtlSec || 900) * 1000),
              refreshExpiresAt: result.refreshExpiresAt ?? null,
              lastRefreshAt: now,
              lastPingAt: now,
              errorMessage: null,
            },
          })
        } else {
          // Keep session usable if the access token still has life left.
          const stillFresh = remainingMs > 0
          await db.providerSession.update({
            where: { id: session.id },
            data: {
              status: stillFresh ? 'active' : 'error',
              errorMessage: result.error || 'refresh failed',
              // Still bump lastRefreshAt so we don't spin every minute on hard fails.
              lastRefreshAt: now,
              lastPingAt: now,
            },
          })
        }
        continue
      }

      const lastPing = session.lastPingAt
      const pingIntervalSec = provider.pingIntervalSec
      const needsPing =
        !lastPing ||
        now.getTime() - lastPing.getTime() >= pingIntervalSec * 1000

      if (needsPing || (cookieOnly && dueByExpiry) || session.status === 'error') {
        const result = await adapter.ping(ctx)
        if (result.ok) {
          await db.providerSession.update({
            where: { id: session.id },
            data: {
              lastPingAt: now,
              status: 'active',
              errorMessage: null,
              // Cookie holders: bump expiry so scheduler stops thrashing
              ...(cookieOnly
                ? { expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) }
                : {}),
            },
          })
        } else {
          await db.providerSession.update({
            where: { id: session.id },
            data: {
              lastPingAt: now,
              // Don't demote cookie holders / still-fresh tokens to error on ping
              ...(cookieOnly || remainingMs > 0
                ? { errorMessage: result.error || 'ping failed' }
                : {
                    status: 'error',
                    errorMessage: result.error || 'ping failed',
                  }),
            },
          })
        }
      }
    } catch (e) {
      console.error(`[scheduler] session ${session.id} tick error:`, e)
    }
  }
}
