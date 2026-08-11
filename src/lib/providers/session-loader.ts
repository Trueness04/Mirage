/**
 * Session helpers — load a ProviderSession + its Provider + cookies into
 * an AdapterSessionContext that adapters expect.
 */

import { db } from '@/lib/db'
import type { AdapterSessionContext, CookieJarEntry } from '@/lib/providers/base'

export async function loadSessionContext(
  sessionId: string,
): Promise<{ ctx: AdapterSessionContext; providerKey: string } | null> {
  const session = await db.providerSession.findUnique({
    where: { id: sessionId },
    include: { provider: true },
  })
  if (!session) return null

  const cookies: CookieJarEntry[] = safeParseCookies(session.cookies)

  return {
    ctx: {
      id: session.id,
      providerId: session.providerId,
      providerKey: session.provider.key,
      cookies,
      accessToken: session.accessToken ?? undefined,
      refreshToken: session.refreshToken ?? undefined,
      expiresAt: session.expiresAt ?? undefined,
      refreshExpiresAt: session.refreshExpiresAt ?? undefined,
      deviceId: session.deviceId ?? undefined,
    },
    providerKey: session.provider.key,
  }
}

export function safeParseCookies(cookiesJson: string): CookieJarEntry[] {
  try {
    const arr = JSON.parse(cookiesJson)
    if (!Array.isArray(arr)) return []
    return arr as CookieJarEntry[]
  } catch {
    return []
  }
}
