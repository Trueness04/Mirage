/**
 * Generic Cookie / OpenAI-compatible Adapter
 * --------------------------------------------------------------------
 * Used for:
 *  1. Session holders (cookie keep-alive) before a full protocol exists
 *  2. OpenAI-compatible free web APIs (apiBaseUrl + bearer from capture)
 *
 * User-added platforms from the dashboard register through this factory.
 */

import {
  BROWSER_HEADERS,
  type AdapterModelSpec,
  type AdapterSessionContext,
  type ChatCompletionResponse,
  type ChatMessage,
  type CookieJarEntry,
  type OpenAIChatRequest,
  type ProviderAdapter,
  type RefreshResult,
  type SessionValidationResult,
  type StreamChunk,
  type UpstreamRequestSpec,
  cookieHeader,
  findCookie,
  registerAdapter,
} from './base'

export interface GenericAdapterConfig {
  key: string
  displayName: string
  websiteUrl: string
  refreshEndpoint?: string
  models: AdapterModelSpec[]
  /** Endpoint to hit for keep-alive / session validation */
  validationPath?: string
  /** cookie = session holder only; openai_compat = proxy /chat/completions */
  adapterKind?: 'cookie' | 'openai_compat'
  /** Base URL ending in /v1 (or similar) for OpenAI-compatible free APIs */
  apiBaseUrl?: string
}

export function createGenericAdapter(cfg: GenericAdapterConfig): ProviderAdapter {
  const validationUrl = cfg.validationPath
    ? new URL(cfg.validationPath, cfg.websiteUrl).href
    : cfg.websiteUrl
  const kind = cfg.adapterKind || (cfg.apiBaseUrl ? 'openai_compat' : 'cookie')
  const apiBase = (cfg.apiBaseUrl || '').replace(/\/+$/, '')

  const adapter: ProviderAdapter = {
    key: cfg.key,
    displayName: cfg.displayName,

    listModels() {
      // Live import only — ignore any seed list passed at adapter creation.
      return []
    },

    async buildUpstreamRequest(
      req: OpenAIChatRequest,
      session: AdapterSessionContext,
    ): Promise<UpstreamRequestSpec> {
      // Prefer explicit openai_compat; also allow chat when apiBaseUrl was
      // discovered via live /models import even if DB kind lagged as cookie.
      if (!apiBase) {
        throw new Error(
          `[${cfg.key}] Cookie session only — chat is not wired for this site. ` +
            'Capture login so Mirage can import models + API base, or add an ' +
            'OpenAI-compatible API Base URL (…/v1).',
        )
      }

      // chat.qwen.ai retired v1 /chat/completions (always 504 alibaba-ga).
      // Completions route swaps in the dedicated Qwen v2 adapter for these hosts.
      try {
        const host = new URL(cfg.websiteUrl).hostname.toLowerCase()
        const apiHost = new URL(apiBase).hostname.toLowerCase()
        if (
          host === 'chat.qwen.ai' ||
          apiHost === 'chat.qwen.ai' ||
          host.endsWith('.qwen.ai')
        ) {
          throw new Error(
            `[${cfg.key}] chat.qwen.ai v1 /chat/completions is dead (HTTP 504 alibaba-ga). ` +
              'Use Mirage Qwen v2: keep https://chat.qwen.ai logged in, Capture, then chat again ' +
              '(adapter auto-routes to /api/v2/chats/new + /api/v2/chat/completions).',
          )
        }
      } catch (e) {
        if (e instanceof Error && /504 alibaba-ga|v1 \/chat\/completions is dead/i.test(e.message)) {
          throw e
        }
      }

      const token = extractBearer(session)
      const cookieStr = cookieHeader(session.cookies)
      if (!token && !cookieStr) {
        throw new Error(
          `[${cfg.key}] No bearer token or cookies. Log in on ${cfg.websiteUrl} ` +
            'with the Mirage extension installed (Chrome and/or Edge).',
        )
      }

      const chatBase = rewriteCompatApiBase(cfg.key, apiBase)
      const headers: Record<string, string> = {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: cfg.websiteUrl,
        Referer: cfg.websiteUrl + '/',
      }
      if (cookieStr) headers.Cookie = cookieStr
      if (token) headers.Authorization = `Bearer ${token}`

      return {
        url: `${chatBase}/chat/completions`,
        method: 'POST',
        stream: req.stream ?? false,
        headers,
        body: {
          model: req.model,
          messages: req.messages,
          temperature: req.temperature,
          top_p: req.top_p,
          max_tokens: req.max_tokens,
          stream: req.stream ?? false,
          ...(Array.isArray(req.tools) && req.tools.length > 0
            ? { tools: req.tools }
            : {}),
          ...(req.tool_choice != null ? { tool_choice: req.tool_choice } : {}),
        },
      }
    },

    async parseUpstreamResponse(
      raw: Response,
      _session: AdapterSessionContext,
      model: string,
    ): Promise<ChatCompletionResponse> {
      if (!raw.ok) {
        const text = await raw.text()
        throw new Error(formatCompatUpstreamError(cfg.key, raw.status, text))
      }
      const j = await raw.json()
      return {
        id: j.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: j.created || Math.floor(Date.now() / 1000),
        model,
        choices: j.choices || [],
        usage: j.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      }
    },

    async *transformStream(
      upstreamStream: ReadableStream<Uint8Array>,
      _session: AdapterSessionContext,
      model: string,
    ): AsyncGenerator<StreamChunk, void, unknown> {
      const id = `chatcmpl-${Date.now()}`
      const created = Math.floor(Date.now() / 1000)
      const reader = upstreamStream.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const parts = buf.split('\n')
          buf = parts.pop() ?? ''
          for (const line of parts) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (data === '[DONE]') {
              yield {
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              }
              return
            }
            try {
              const j = JSON.parse(data)
              const delta: Partial<ChatMessage> = j.choices?.[0]?.delta ?? {}
              const finish = j.choices?.[0]?.finish_reason ?? null
              yield {
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta, finish_reason: finish }],
              }
            } catch {
              // skip
            }
          }
        }
        yield {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }
      } finally {
        reader.releaseLock()
      }
    },

    async refresh(session: AdapterSessionContext): Promise<RefreshResult> {
      try {
        if (kind === 'openai_compat' && apiBase) {
          const token = extractBearer(session)
          const headers: Record<string, string> = {
            ...BROWSER_HEADERS,
            Cookie: cookieHeader(session.cookies),
            Origin: cfg.websiteUrl,
            Referer: cfg.websiteUrl + '/',
            Accept: 'application/json',
          }
          if (token) headers.Authorization = `Bearer ${token}`
          const resp = await fetch(`${apiBase}/models`, {
            headers,
            redirect: 'manual',
          })
          // Many free gateways omit /models — treat 404 as soft-ok if we have a token
          if (resp.ok || (resp.status === 404 && token)) {
            return {
              ok: true,
              accessToken: token,
              cookies: session.cookies,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            }
          }
          if (resp.status >= 500) {
            return { ok: false, error: `Upstream ${resp.status}` }
          }
        }

        // Cookie holders: Google/etc often block datacenter IPs — keep jar alive.
        if (kind === 'cookie' && session.cookies.length > 0) {
          try {
            const resp = await fetch(validationUrl, {
              headers: {
                ...BROWSER_HEADERS,
                Cookie: cookieHeader(session.cookies),
                Origin: cfg.websiteUrl,
                Referer: cfg.websiteUrl + '/',
              },
              redirect: 'manual',
              signal:
                typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
                  ? AbortSignal.timeout(12_000)
                  : undefined,
            })
            const setCookie = resp.headers.getSetCookie?.() ?? []
            const merged = mergeCookies(session.cookies, setCookie)
            return {
              ok: true,
              cookies: merged,
              accessToken: session.accessToken,
              refreshToken: session.refreshToken,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            }
          } catch {
            return {
              ok: true,
              cookies: session.cookies,
              accessToken: session.accessToken,
              refreshToken: session.refreshToken,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            }
          }
        }

        const resp = await fetch(validationUrl, {
          headers: {
            ...BROWSER_HEADERS,
            Cookie: cookieHeader(session.cookies),
            Origin: cfg.websiteUrl,
            Referer: cfg.websiteUrl + '/',
          },
          redirect: 'manual',
        })
        if (resp.status >= 500) {
          return { ok: false, error: `Upstream ${resp.status}` }
        }
        const setCookie = resp.headers.getSetCookie?.() ?? []
        const merged = mergeCookies(session.cookies, setCookie)
        return {
          ok: true,
          cookies: merged,
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }
      } catch (e) {
        if (kind === 'cookie' && session.cookies.length > 0) {
          return {
            ok: true,
            cookies: session.cookies,
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          }
        }
        return { ok: false, error: (e as Error).message }
      }
    },

    async ping(session: AdapterSessionContext) {
      const r = await adapter.refresh(session)
      return { ok: r.ok, error: r.error }
    },

    async validate(session: AdapterSessionContext): Promise<SessionValidationResult> {
      try {
        if (kind === 'openai_compat' && apiBase) {
          const token = extractBearer(session)
          if (!token && session.cookies.length === 0) {
            return { valid: false, reason: 'No token or cookies captured' }
          }
          const headers: Record<string, string> = {
            ...BROWSER_HEADERS,
            Cookie: cookieHeader(session.cookies),
            Accept: 'application/json',
            Origin: cfg.websiteUrl,
            Referer: cfg.websiteUrl + '/',
          }
          if (token) headers.Authorization = `Bearer ${token}`
          const resp = await fetch(`${apiBase}/models`, { headers, redirect: 'manual' })
          if (resp.status === 401 || resp.status === 403) {
            return { valid: false, reason: `Unauthorized (${resp.status})` }
          }
          // Prefer a real OpenAI /models JSON list (never HTML SPA fallbacks).
          if (resp.ok) {
            const ct = resp.headers.get('content-type') || ''
            const text = await resp.text()
            const looksJson =
              ct.includes('application/json') ||
              text.trimStart().startsWith('{') ||
              text.trimStart().startsWith('[')
            if (looksJson) {
              try {
                const j = JSON.parse(text)
                const rows = (j.data || j.models || []) as Array<{
                  id?: string
                  name?: string
                  display_name?: string
                }>
                const ids = rows
                  .map((m) => m.id || m.name)
                  .filter((x): x is string => Boolean(x && x !== 'default'))
                if (ids.length) {
                  return { valid: true, detectedModels: ids }
                }
              } catch {
                // fall through
              }
            }
          }
          // 404 / HTML: session may still be usable for chat if completions work
          if (resp.status === 404 || resp.ok) {
            return { valid: true, detectedModels: [] }
          }
          return { valid: false, reason: `HTTP ${resp.status}` }
        }

        if (session.cookies.length === 0 && !extractBearer(session)) {
          return { valid: false, reason: 'No cookies or token captured' }
        }

        // Try live model catalogs on the website origin before cookie keep-alive.
        const token = extractBearer(session)
        const catalogHeaders: Record<string, string> = {
          ...BROWSER_HEADERS,
          Cookie: cookieHeader(session.cookies),
          Accept: 'application/json',
          Origin: cfg.websiteUrl,
          Referer: cfg.websiteUrl.replace(/\/?$/, '/'),
        }
        if (token) catalogHeaders.Authorization = `Bearer ${token}`
        const liveIds = await discoverCookieProviderModels(
          cfg.websiteUrl,
          catalogHeaders,
        )
        if (liveIds.length) {
          return { valid: true, detectedModels: liveIds }
        }

        try {
          const resp = await fetch(validationUrl, {
            headers: {
              ...BROWSER_HEADERS,
              Cookie: cookieHeader(session.cookies),
              Origin: cfg.websiteUrl,
              Referer: cfg.websiteUrl + '/',
            },
            redirect: 'manual',
          })
          if (resp.status === 401 || resp.status === 403) {
            // Cookie-only platforms: browser jar is authoritative; many sites
            // challenge datacenter IPs even with valid cookies.
            if (kind === 'cookie' && session.cookies.length > 0) {
              // Cookie keep-alive only — do not invent model ids.
              return { valid: true, detectedModels: [] }
            }
            return { valid: false, reason: `Unauthorized (${resp.status})` }
          }
          if (resp.status >= 500 && kind !== 'cookie') {
            return { valid: false, reason: `Upstream ${resp.status}` }
          }
          return { valid: true, detectedModels: [] }
        } catch (e) {
          if (kind === 'cookie' && session.cookies.length > 0) {
            return { valid: true, detectedModels: [] }
          }
          return { valid: false, reason: (e as Error).message }
        }
      } catch (e) {
        return { valid: false, reason: (e as Error).message }
      }
    },
  }

  registerAdapter(adapter)
  return adapter
}

/** Map website-discovered bases to hosts that actually serve /chat/completions. */
function rewriteCompatApiBase(providerKey: string, apiBase: string): string {
  const base = apiBase.replace(/\/+$/, '')
  try {
    const u = new URL(base)
    if (
      providerKey === 'venice' ||
      u.hostname === 'venice.ai' ||
      u.hostname === 'www.venice.ai'
    ) {
      // venice.ai/api/v1/models works; /chat/completions is 404 there.
      return 'https://api.venice.ai/api/v1'
    }
    if (
      providerKey === 'huggingface' &&
      (u.hostname === 'huggingface.co' || u.hostname === 'www.huggingface.co')
    ) {
      // huggingface.co/api is not the OpenAI chat host.
      return 'https://router.huggingface.co/v1'
    }
  } catch {
    // keep
  }
  return base
}

function formatCompatUpstreamError(
  providerKey: string,
  status: number,
  text: string,
): string {
  if (providerKey === 'venice' && (status === 401 || status === 402 || status === 403)) {
    return (
      'Venice chat requires a Venice API key (https://venice.ai → API Keys), ' +
      'not website login cookies. Set the key as the session access token / Bearer, ' +
      'with apiBaseUrl https://api.venice.ai/api/v1.'
    )
  }
  if (providerKey === 'venice' && status === 404) {
    return (
      'Venice website /api/v1/chat/completions does not exist. Mirage now routes to ' +
      'api.venice.ai — capture or paste a Venice API key and retry.'
    )
  }
  return `[${providerKey}] upstream ${status}: ${text.slice(0, 200)}`
}

function extractBearer(session: AdapterSessionContext): string | undefined {
  const direct = session.accessToken?.replace(/^Bearer\s+/i, '').trim()
  if (direct) return direct
  for (const name of ['token', 'access_token', 'userToken', 'Authorization', 'api_key']) {
    const c = findCookie(session.cookies, name)?.value?.trim()
    if (c) return c.replace(/^Bearer\s+/i, '')
  }
  return undefined
}

/** Probe common OpenAI-ish model list paths on the site origin. */
async function discoverCookieProviderModels(
  websiteUrl: string,
  headers: Record<string, string>,
): Promise<string[]> {
  let origin = ''
  try {
    origin = new URL(websiteUrl).origin
  } catch {
    return []
  }
  const paths = [
    '/api/models',
    '/chat/api/v2/models',
    '/chat/api/models',
    '/api/v1/models',
    '/v1/models',
    '/backend/v1/models',
    '/api/openai/v1/models',
    '/api/chat/models',
  ]
  for (const path of paths) {
    try {
      const resp = await fetch(`${origin}${path}`, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(12_000),
      })
      if (!resp.ok) continue
      const text = await resp.text()
      if (!text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) {
        continue
      }
      const j = JSON.parse(text) as Record<string, unknown>
      const rows = (j.data || j.models || j.result || j.items) as unknown
      if (!Array.isArray(rows) || !rows.length) continue
      const ids = rows
        .map((item) => {
          if (typeof item === 'string') return item.trim()
          if (!item || typeof item !== 'object') return ''
          const m = item as Record<string, unknown>
          return String(m.id || m.model || m.name || m.slug || '').trim()
        })
        .filter((id) => id && id !== 'default' && !/\.(jpe?g|png|gif|webp|svg)$/i.test(id))
      if (ids.length) return Array.from(new Set(ids))
    } catch {
      // next path
    }
  }
  return []
}

function mergeCookies(
  existing: CookieJarEntry[],
  setCookie: string[],
): CookieJarEntry[] {
  const merged = new Map<string, CookieJarEntry>()
  for (const c of existing) {
    merged.set(`${c.name}@${c.domain}`, {
      ...c,
      path: c.path || '/',
    })
  }
  for (const sc of setCookie) {
    const parts = sc.split(';')
    const [pair] = parts
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    let domain = ''
    for (const p of parts) {
      const t = p.trim().toLowerCase()
      if (t.startsWith('domain=')) domain = t.slice(7)
    }
    merged.set(`${name}@${domain}`, {
      name,
      value,
      domain: domain || '',
      path: '/',
    })
  }
  return Array.from(merged.values())
}
