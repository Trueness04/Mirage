/**
 * Z.AI captcha bridge — solves FRONTEND_CAPTCHA_REQUIRED via the Mirage
 * extension running on a real chat.z.ai tab (Aliyun traceless captcha).
 */

import {
  enqueueToolJob,
  pickOnlineDeviceId,
  waitForToolJob,
} from '@/lib/tools/local'
import { db } from '@/lib/db'
import type { CookieJarEntry } from './base'
import { findCookie } from './base'

export const ZAI_CAPTCHA_COOKIE = 'mirage_captcha_verify_param'
export const ZAI_CAPTCHA_TS_COOKIE = 'mirage_captcha_ts'

/** Tokens are short-lived; refresh slightly before the ~45s upstream TTL. */
const CAPTCHA_MAX_AGE_MS = 35_000

export function readStoredZaiCaptcha(
  cookies: CookieJarEntry[],
): { param: string; ageMs: number } | null {
  const param = findCookie(cookies, ZAI_CAPTCHA_COOKIE)?.value?.trim()
  if (!param) return null
  const tsRaw = findCookie(cookies, ZAI_CAPTCHA_TS_COOKIE)?.value
  const ts = Number(tsRaw || 0)
  const ageMs = ts > 0 ? Date.now() - ts : Number.POSITIVE_INFINITY
  return { param, ageMs }
}

export function upsertZaiCaptchaCookies(
  cookies: CookieJarEntry[],
  param: string,
): CookieJarEntry[] {
  const filtered = cookies.filter(
    (c) =>
      c.name !== ZAI_CAPTCHA_COOKIE &&
      c.name !== ZAI_CAPTCHA_TS_COOKIE &&
      !c.name.startsWith('mirage_captcha'),
  )
  filtered.push({
    name: ZAI_CAPTCHA_COOKIE,
    value: param,
    domain: 'chat.z.ai',
    path: '/',
    secure: true,
    sameSite: 'Lax',
  })
  filtered.push({
    name: ZAI_CAPTCHA_TS_COOKIE,
    value: String(Date.now()),
    domain: 'chat.z.ai',
    path: '/',
    secure: true,
    sameSite: 'Lax',
  })
  return filtered
}

export function stripMirageCookies(cookies: CookieJarEntry[]): CookieJarEntry[] {
  return cookies.filter((c) => !c.name.toLowerCase().startsWith('mirage_'))
}

/**
 * Return a fresh captcha_verify_param, preferring a recent stored value,
 * otherwise asking the online Mirage extension to solve Aliyun captcha
 * inside the user's chat.z.ai tab.
 */
export async function ensureZaiCaptcha(opts: {
  sessionId: string
  deviceId?: string | null
  cookies: CookieJarEntry[]
  force?: boolean
}): Promise<{ param: string; cookies: CookieJarEntry[] }> {
  const stored = readStoredZaiCaptcha(opts.cookies)
  if (
    !opts.force &&
    stored &&
    stored.ageMs < CAPTCHA_MAX_AGE_MS &&
    stored.param.length > 8
  ) {
    return { param: stored.param, cookies: opts.cookies }
  }

  const deviceId = await pickOnlineDeviceId(opts.deviceId)
  if (!deviceId) {
    throw new Error(
      'Z.AI captcha needs an online Mirage extension. Keep Chrome open with ' +
        'the extension installed and a chat.z.ai tab (logged in), then retry.',
    )
  }

  const jobId = await enqueueToolJob({
    deviceId,
    toolName: 'mirage_zai_captcha',
    arguments: { providerKey: 'zai' },
  })
  const waited = await waitForToolJob(jobId, 55_000, 300)
  if (!waited.ok) {
    const err = waited.error || 'extension tool failed'
    if (/Unknown tool:\s*mirage_zai_captcha/i.test(err)) {
      throw new Error(
        `Unknown tool: mirage_zai_captcha — reload Mirage extension from public/extension (need v1.5.6+); Chrome → Extensions → Mirage → Reload`,
      )
    }
    if (/No current window/i.test(err)) {
      throw new Error(
        'Z.AI captcha: No current window — keep a normal Chrome window open with chat.z.ai, reload Mirage extension 1.5.6+, retry',
      )
    }
    throw new Error(err)
  }

  const result = waited.result as Record<string, unknown> | null
  const param =
    (typeof result?.captcha_verify_param === 'string' &&
      result.captcha_verify_param) ||
    (typeof result?.param === 'string' && result.param) ||
    ''
  if (!param || param.length < 8) {
    throw new Error(
      'Extension returned an empty captcha token. Reload chat.z.ai and try again.',
    )
  }

  const cookies = upsertZaiCaptchaCookies(opts.cookies, param)
  try {
    await db.providerSession.update({
      where: { id: opts.sessionId },
      data: { cookies: JSON.stringify(cookies), lastPingAt: new Date() },
    })
  } catch {
    // non-fatal — still use the param for this request
  }

  return { param, cookies }
}
