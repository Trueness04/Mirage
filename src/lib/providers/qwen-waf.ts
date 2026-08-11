/**
 * Qwen Alibaba WAF (baxia) bridge — asks the Mirage extension to warm a
 * real chat.qwen.ai tab so ssxmod_* anti-bot cookies and bx-* risk-control
 * headers are minted, then re-captures them into the ProviderSession.
 *
 * Without bx-ua / bx-umidtoken, /api/v2/chat/completions returns an empty
 * SSE stream (content: null) even when the JWT and create-chat succeed.
 */

import {
  enqueueToolJob,
  pickOnlineDeviceId,
  waitForToolJob,
} from '@/lib/tools/local'
import { db } from '@/lib/db'
import type { CookieJarEntry } from './base'

export const MIRAGE_BX_UA = '__mirage_bx_ua'
export const MIRAGE_BX_UMID = '__mirage_bx_umidtoken'
export const MIRAGE_BX_V = '__mirage_bx_v'
export const MIRAGE_BX_VERSION = '__mirage_version'
export const MIRAGE_BX_USER_AGENT = '__mirage_user_agent'
export const MIRAGE_X_AP = '__mirage_x_ap'

export function hasQwenAntiBotCookies(cookies: CookieJarEntry[]): boolean {
  const names = new Set(cookies.map((c) => c.name.toLowerCase()))
  return (
    names.has('ssxmod_itna') ||
    names.has('ssxmod_itna2') ||
    names.has('bx-umidtoken') ||
    [...names].some((n) => n.startsWith('ssxmod_'))
  )
}

export function hasQwenBxHeaders(cookies: CookieJarEntry[]): boolean {
  const ua = cookies.find((c) => c.name === MIRAGE_BX_UA)?.value
  const umid = cookies.find((c) => c.name === MIRAGE_BX_UMID)?.value
  return Boolean(ua && umid && ua.length > 8 && umid.length > 8)
}

function mergeCookieJars(
  existing: CookieJarEntry[],
  incoming: CookieJarEntry[],
): CookieJarEntry[] {
  const map = new Map<string, CookieJarEntry>()
  for (const c of existing) {
    map.set(`${c.name.toLowerCase()}@${(c.domain || '').toLowerCase()}`, c)
  }
  for (const c of incoming) {
    if (!c?.name || c.value == null) continue
    map.set(`${c.name.toLowerCase()}@${(c.domain || '').toLowerCase()}`, c)
  }
  return Array.from(map.values())
}

function bxEntriesFromWarmupResult(
  result: Record<string, unknown> | null,
): CookieJarEntry[] {
  const bx = result?.bxHeaders as Record<string, string> | null | undefined
  if (!bx?.bx_ua || !bx?.bx_umidtoken) return []
  const domain = '.qwen.ai'
  const mk = (name: string, value: string | undefined): CookieJarEntry | null =>
    value
      ? {
          name,
          value: String(value),
          domain,
          path: '/',
          secure: true,
          sameSite: 'Lax',
        }
      : null
  return [
    mk(MIRAGE_BX_UA, bx.bx_ua),
    mk(MIRAGE_BX_UMID, bx.bx_umidtoken),
    mk(MIRAGE_BX_V, bx.bx_v || '2.5.36'),
    mk(MIRAGE_BX_VERSION, bx.version),
    mk(MIRAGE_BX_USER_AGENT, bx.user_agent),
    mk(MIRAGE_X_AP, bx.x_ap),
  ].filter(Boolean) as CookieJarEntry[]
}

/**
 * If the session lacks baxia cookies / bx-* headers, ask the extension to
 * warm chat.qwen.ai in the user's browser and return an updated cookie jar.
 */
export async function ensureQwenWafCookies(opts: {
  sessionId: string
  deviceId?: string | null
  cookies: CookieJarEntry[]
  force?: boolean
}): Promise<CookieJarEntry[]> {
  // Completions run viaBrowser (live BaXia injects bx-*). Warm when ssxmod_* missing.
  if (!opts.force && hasQwenAntiBotCookies(opts.cookies)) {
    return opts.cookies
  }

  const deviceId = await pickOnlineDeviceId(opts.deviceId)
  if (!deviceId) {
    throw new Error(
      'Qwen WAF needs an online Mirage extension (v1.5.7+). Keep Chrome open with ' +
        'https://chat.qwen.ai logged in, send one chat in the tab, then retry.',
    )
  }

  const jobId = await enqueueToolJob({
    deviceId,
    toolName: 'mirage_qwen_warmup',
    arguments: { providerKey: 'qwen' },
  })
  const waited = await waitForToolJob(jobId, 55_000, 300)
  if (!waited.ok) {
    const err = waited.error || 'extension tool failed'
    if (/Unknown tool:\s*mirage_qwen_warmup/i.test(err)) {
      throw new Error(
        `Unknown tool: mirage_qwen_warmup — reload Mirage extension from public/extension (need v1.5.7+); Chrome → Extensions → Mirage → Reload`,
      )
    }
    // Service worker without a browser window — do not hard-fail chat.
    if (/No current window/i.test(err)) {
      console.warn('[qwen-waf] warmup skipped:', err)
      return opts.cookies
    }
    throw new Error(err)
  }

  const result = waited.result as Record<string, unknown> | null
  const harvested = Array.isArray(result?.cookies)
    ? (result!.cookies as CookieJarEntry[])
    : []
  let cookies = mergeCookieJars(opts.cookies, harvested)
  cookies = mergeCookieJars(cookies, bxEntriesFromWarmupResult(result))

  if (!hasQwenAntiBotCookies(cookies)) {
    throw new Error(
      'Qwen still missing ssxmod_* WAF cookies after warmup. ' +
        'In the chat.qwen.ai tab, send one message manually, then click Capture again.',
    )
  }

  // bx-* are preferred for Node create-chat; completions use viaBrowser (live BaXia).
  // Don't hard-fail if webRequest missed them — MAIN-world fetch still injects.
  if (!hasQwenBxHeaders(cookies)) {
    console.warn(
      '[qwen-waf] warmup finished without bx-ua/bx-umidtoken; completions will rely on viaBrowser MAIN-world BaXia',
    )
  }

  try {
    await db.providerSession.update({
      where: { id: opts.sessionId },
      data: {
        cookies: JSON.stringify(cookies),
        lastPingAt: new Date(),
        status: 'active',
        errorMessage: null,
      },
    })
  } catch {
    // still return cookies for this request
  }

  return cookies
}
