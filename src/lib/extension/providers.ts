import { db } from '@/lib/db'
import {
  normalizeWebsiteUrl,
  websiteUrlFromProviderKey,
} from '@/lib/extension/notify-capture'

export const EXTENSION_PROVIDER_SELECT = {
  key: true,
  displayName: true,
  websiteUrl: true,
  apiBaseUrl: true,
  adapterKind: true,
  refreshEndpoint: true,
  refreshTtlSec: true,
  sessionTtlSec: true,
  pingIntervalSec: true,
  enabled: true,
  captureRequestedAt: true,
} as const

export async function listExtensionProviders() {
  const providers = await db.provider.findMany({
    where: { enabled: true },
    select: EXTENSION_PROVIDER_SELECT,
    orderBy: { key: 'asc' },
  })

  // Repair rows that were saved without a websiteUrl (blocks cookie capture)
  for (const p of providers) {
    if (normalizeWebsiteUrl(p.websiteUrl)) continue
    const fixed = websiteUrlFromProviderKey(p.key)
    if (!fixed) continue
    await db.provider.update({
      where: { key: p.key },
      data: { websiteUrl: fixed },
    })
    p.websiteUrl = fixed
  }

  return providers
}

export async function extensionFallbackHint() {
  const sessionCounts = await db.providerSession.groupBy({
    by: ['providerId'],
    _count: { id: true },
  })
  const providerIdToCount = new Map(
    sessionCounts.map((s) => [s.providerId, s._count.id]),
  )
  const allProviders = await db.provider.findMany({
    where: { enabled: true },
    select: { id: true, key: true },
  })
  return allProviders.map((p) => ({
    key: p.key,
    sessionSlots: providerIdToCount.get(p.id) || 0,
    needsFallback: (providerIdToCount.get(p.id) || 0) < 2,
  }))
}

/** Clear captureRequestedAt after a successful capture for this provider. */
export async function clearCaptureRequest(providerKey: string) {
  await db.provider.updateMany({
    where: { key: providerKey, captureRequestedAt: { not: null } },
    data: { captureRequestedAt: null },
  })
}
