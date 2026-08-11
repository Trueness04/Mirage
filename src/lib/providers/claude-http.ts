/**
 * Claude.ai HTTP — Node fetch often hits Cloudflare; fall back to the
 * Mirage extension (`mirage_browser_fetch`) which runs in a real Chrome
 * tab (same approach OmniRoute needs TLS spoofing for).
 */

import {
  enqueueToolJob,
  pickOnlineDeviceId,
  waitForToolJob,
} from '@/lib/tools/local'

export function isCloudflareChallenge(status: number, body: string): boolean {
  if (status === 403 || status === 503) {
    if (
      /Just a moment|cf-browser-verification|challenge-platform|_cf_chl|Attention Required/i.test(
        body,
      )
    ) {
      return true
    }
    if (/<!DOCTYPE html>/i.test(body) && /cloudflare/i.test(body)) return true
  }
  return /Just a moment\.\.\./i.test(body)
}

export type ClaudeHttpResult = {
  status: number
  ok: boolean
  body: string
  contentType?: string
}

const CF_HELP =
  'Claude Cloudflare challenge — open https://claude.ai in Chrome, finish the CF check while logged in, keep that tab open, ensure Mirage extension is online (v1.5.4+), then retry.'

export async function claudeHttp(opts: {
  url: string
  method?: string
  headers: Record<string, string>
  body?: string
  deviceId?: string | null
  /** Prefer browser first (Claude CF usually blocks Node). */
  preferBrowser?: boolean
}): Promise<ClaudeHttpResult> {
  const method = (opts.method || 'GET').toUpperCase()
  const preferBrowser = opts.preferBrowser !== false

  if (preferBrowser) {
    const viaExt = await tryBrowserFetch(opts)
    if (viaExt) {
      if (viaExt.ok) return viaExt
      if (!isCloudflareChallenge(viaExt.status, viaExt.body)) return viaExt
      // Browser also challenged — Node will fail the same way; don't mask as create 403 HTML.
      throw new Error(CF_HELP)
    }
  }

  try {
    const resp = await fetch(opts.url, {
      method,
      headers: opts.headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : opts.body,
      signal: AbortSignal.timeout(30_000),
    })
    const body = await resp.text()
    const result: ClaudeHttpResult = {
      status: resp.status,
      ok: resp.ok,
      body,
      contentType: resp.headers.get('content-type') || undefined,
    }
    if (result.ok) return result
    if (!isCloudflareChallenge(result.status, result.body)) return result
    if (preferBrowser) {
      const viaExt = await tryBrowserFetch(opts)
      if (viaExt?.ok) return viaExt
      if (viaExt && !isCloudflareChallenge(viaExt.status, viaExt.body)) {
        return viaExt
      }
      throw new Error(CF_HELP)
    }
    return result
  } catch (e) {
    if (e instanceof Error && e.message.includes('Cloudflare')) throw e
    if (preferBrowser) {
      const viaExt = await tryBrowserFetch(opts)
      if (viaExt?.ok) return viaExt
      if (viaExt && !isCloudflareChallenge(viaExt.status, viaExt.body)) {
        return viaExt
      }
      throw new Error(CF_HELP)
    }
    throw e
  }
}

async function tryBrowserFetch(opts: {
  url: string
  method?: string
  headers: Record<string, string>
  body?: string
  deviceId?: string | null
}): Promise<ClaudeHttpResult | null> {
  const deviceId = await pickOnlineDeviceId(opts.deviceId)
  if (!deviceId) return null

  // Tab uses credentials:include — do NOT send Mirage jar Cookie (often missing
  // cf_clearance and can fight the browser's live CF cookies).
  const headers: Record<string, string> = { ...opts.headers }
  delete headers.Cookie
  delete headers.cookie

  const jobId = await enqueueToolJob({
    deviceId,
    toolName: 'mirage_browser_fetch',
    arguments: {
      url: opts.url,
      method: opts.method || 'GET',
      headers,
      body: opts.body,
    },
  })
  const waited = await waitForToolJob(jobId, 55_000, 300)
  if (!waited.ok) {
    if (/Unknown tool:\s*mirage_browser_fetch/i.test(waited.error || '')) {
      throw new Error(
        'Unknown tool: mirage_browser_fetch — reload Mirage extension from public/extension',
      )
    }
    return null
  }

  const r = waited.result as Record<string, unknown> | null
  if (!r || typeof r.status !== 'number') return null
  return {
    status: r.status,
    ok: Boolean(r.ok),
    body: String(r.body ?? ''),
    contentType:
      typeof r.contentType === 'string' ? r.contentType : undefined,
  }
}

/** Build a Fetch Response from extension browser_fetch result. */
export function responseFromClaudeHttp(r: ClaudeHttpResult): Response {
  return new Response(r.body, {
    status: r.status,
    headers: {
      'content-type':
        r.contentType ||
        (r.body.trimStart().startsWith('{')
          ? 'application/json'
          : 'text/event-stream'),
    },
  })
}
