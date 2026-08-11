/**
 * Self-Healing Probe Scheduler
 * --------------------------------------------------------------------
 * Periodically checks providers with tripped circuit breakers.
 * Runs active ping/canary requests to verify if upstream services have recovered.
 */

import { db } from '@/lib/db'
import { getAdapter } from '@/lib/providers/base'
import { getAllAdapterBreakers } from '@/lib/providers/provider-wrapper'
import { loadSessionContext } from '@/lib/providers/session-loader'

const SELF_HEAL_INTERVAL_MS = 60 * 1000 // Check every 60 seconds

const globalHeal = globalThis as unknown as {
  __mirageSelfHealTimer?: NodeJS.Timeout | null
}

export function startSelfHealing() {
  if (globalHeal.__mirageSelfHealTimer) return

  globalHeal.__mirageSelfHealTimer = setInterval(() => {
    healingTick().catch((e) => {
      console.error('[self-healing] tick failed:', e)
    })
  }, SELF_HEAL_INTERVAL_MS)

  // Run initial tick asynchronously
  healingTick().catch(() => {})
}

async function healingTick() {
  const breakers = getAllAdapterBreakers()

  for (const [providerKey, breaker] of breakers.entries()) {
    // Only probe providers that have recorded failures
    if (breaker.getFailCount() === 0) continue

    // If breaker can already attempt (half-open or recovered), let normal traffic test it
    if (breaker.canAttempt()) continue

    try {
      // Find provider record in DB
      const provider = await db.provider.findUnique({
        where: { key: providerKey },
      })
      if (!provider || !provider.enabled) continue

      // Find best active/error session with auth material
      const session = await db.providerSession.findFirst({
        where: {
          providerId: provider.id,
          status: { in: ['active', 'error'] },
        },
        orderBy: [{ priority: 'asc' }, { lastRefreshAt: 'desc' }],
      })
      if (!session) continue

      const loaded = await loadSessionContext(session.id)
      if (!loaded?.ctx) continue

      const adapter = getAdapter(providerKey)
      if (!adapter) continue

      console.log(`[self-healing] probing down provider: ${providerKey}`)
      const res = await adapter.ping(loaded.ctx)

      if (res.ok) {
        breaker.forceReset()
        console.log(`[self-healing] provider ${providerKey} recovered successfully! Circuit breaker reset.`)

        // Update session status back to active if it was marked as error
        if (session.status === 'error') {
          await db.providerSession.update({
            where: { id: session.id },
            data: { status: 'active', errorMessage: null },
          })
        }
      }
    } catch (e) {
      console.warn(`[self-healing] probe for ${providerKey} failed:`, (e as Error).message)
    }
  }
}
