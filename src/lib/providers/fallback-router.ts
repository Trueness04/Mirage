/**
 * Fallback Router
 * --------------------------------------------------------------------
 * Finds healthy alternative providers when a primary provider fails completely
 * or has no active sessions available.
 */

import { db } from '@/lib/db'
import { getAdapterBreaker } from './provider-wrapper'

export interface FallbackCandidate {
  providerKey: string
  providerId: string
  modelKey: string
}

// Preference order for backup providers
const DEFAULT_FALLBACK_ORDER = [
  'deepseek',
  'qwen',
  'kimi',
  'claude',
  'zai',
  'dola',
  'gemini',
  'huggingchat',
]

/**
 * Returns a list of healthy alternative candidate providers to fallback to.
 */
export async function getFallbackCandidates(
  primaryProviderKey: string,
): Promise<FallbackCandidate[]> {
  const candidates: FallbackCandidate[] = []

  // Filter out primary provider
  const candidateKeys = DEFAULT_FALLBACK_ORDER.filter(
    (k) => k !== primaryProviderKey,
  )

  for (const key of candidateKeys) {
    // Check circuit breaker status first (skip if breaker open)
    const breaker = getAdapterBreaker(key)
    if (breaker && !breaker.canAttempt()) {
      continue
    }

    // Find provider in DB
    const provider = await db.provider.findUnique({
      where: { key },
      include: {
        models: { where: { enabled: true } },
        sessions: {
          where: { status: 'active' },
          take: 1,
        },
      },
    })

    if (!provider || !provider.enabled) continue
    if (provider.sessions.length === 0) continue

    // Find default model or first enabled model
    const model =
      provider.models.find((m) => m.isDefault) || provider.models[0]
    if (!model) continue

    candidates.push({
      providerKey: provider.key,
      providerId: provider.id,
      modelKey: model.modelKey,
    })
  }

  return candidates
}
