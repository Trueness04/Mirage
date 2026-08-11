/**
 * Cookie jar merge + auth downgrade guards for extension session upserts.
 */

import type { CookieJarEntry } from './base'

export function mergeCookieJars(
  existing: CookieJarEntry[],
  incoming: CookieJarEntry[],
): CookieJarEntry[] {
  const map = new Map<string, CookieJarEntry>()
  const keyOf = (c: CookieJarEntry) =>
    `${(c.name || '').toLowerCase()}|${(c.domain || '').toLowerCase()}|${c.path || '/'}`
  for (const c of existing) {
    if (c?.name) map.set(keyOf(c), c)
  }
  for (const c of incoming) {
    if (!c?.name) continue
    // Empty value should not wipe a good cookie unless explicitly removing.
    if (!String(c.value || '').trim()) continue
    map.set(keyOf(c), c)
  }
  return Array.from(map.values())
}

export function parseCookieJar(raw: string | null | undefined): CookieJarEntry[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? (parsed as CookieJarEntry[]) : []
  } catch {
    return []
  }
}

function hasNamedCookie(
  cookies: CookieJarEntry[],
  pred: (c: CookieJarEntry) => boolean,
): boolean {
  return cookies.some((c) => Boolean(c?.name) && pred(c))
}

/** True when jar has provider-specific chat auth (not analytics-only). */
export function hasProviderAuthMaterial(
  providerKey: string,
  cookies: CookieJarEntry[],
  accessToken?: string | null,
  refreshToken?: string | null,
): boolean {
  const token = Boolean(accessToken?.trim() || refreshToken?.trim())
  switch (providerKey) {
    case 'arena':
      return hasNamedCookie(
        cookies,
        (c) =>
          /arena-auth/i.test(c.name) ||
          (/^__session/i.test(c.name) &&
            /clerk|arena\.ai|accounts\.arena/i.test(c.domain || '')),
      )
    case 'claude':
      return (
        token ||
        hasNamedCookie(cookies, (c) => /sessionKey/i.test(c.name))
      )
    case 'qwen':
    case 'chat-qwen-ai':
    case 'qwen-international':
    case 'qwen-intl':
    case 'qwen-ai':
      return (
        token ||
        hasNamedCookie(cookies, (c) =>
          /tongyi_sso_ticket|login_aliyunid_ticket|login_aliyunid_sso|^token$/i.test(
            c.name,
          ),
        )
      )
    case 'kimi':
      return token
    case 'deepseek':
      return (
        token ||
        hasNamedCookie(cookies, (c) => /userToken|token/i.test(c.name))
      )
    case 'gemini':
      return hasNamedCookie(cookies, (c) =>
        /__Secure-1PSID|__Secure-1PSIDTS|SID/i.test(c.name),
      )
    case 'huggingface':
      return hasNamedCookie(cookies, (c) => /^hf-chat$/i.test(c.name))
    case 'zai':
      return (
        token ||
        hasNamedCookie(cookies, (c) => /token|session|auth/i.test(c.name))
      )
    case 'dola':
      return cookies.length > 2
    default:
      return token || cookies.length > 0
  }
}

/**
 * Reject overwrite when existing jar has auth and incoming lost it.
 * Returns true if the upsert should be skipped (keep existing).
 */
export function isAuthDowngrade(opts: {
  providerKey: string
  existingCookies: CookieJarEntry[]
  incomingCookies: CookieJarEntry[]
  existingAccess?: string | null
  existingRefresh?: string | null
  incomingAccess?: string | null
  incomingRefresh?: string | null
}): boolean {
  const had = hasProviderAuthMaterial(
    opts.providerKey,
    opts.existingCookies,
    opts.existingAccess,
    opts.existingRefresh,
  )
  if (!had) return false
  const has = hasProviderAuthMaterial(
    opts.providerKey,
    opts.incomingCookies,
    opts.incomingAccess,
    opts.incomingRefresh,
  )
  return !has
}
