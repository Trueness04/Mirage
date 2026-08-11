/**
 * Kimi (Moonshot) Adapter
 * --------------------------------------------------------------------
 * Website: https://www.kimi.com
 *
 * Auth flow:
 *  - access_token  -> used in `Authorization: Bearer ...`
 *  - refresh_token -> GET https://www.kimi.com/api/auth/token/refresh
 *                    with Authorization: Bearer <refresh_token>
 *  - Validate via GET https://www.kimi.com/api/user
 *
 * Chat (web reverse-engineered):
 *  1) POST https://www.kimi.com/api/chat  → { id }
 *  2) POST https://www.kimi.com/api/chat/{id}/completion/stream  (SSE)
 *     content arrives as event=cmpl, field text
 */

import {
  BROWSER_HEADERS,
  type AdapterModelSpec,
  type AdapterSessionContext,
  type ChatCompletionResponse,
  type ChatMessage,
  type ClearRemoteChatsResult,
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
import {
  clearStickyRemoteChat,
  getStickyRemoteChat,
  setStickyRemoteChat,
} from './remote-chat-sticky'

const KIMI_BASE = 'https://www.kimi.com'

/** Models accepted by www.kimi.com web chat (422 lists these exactly). */
const KIMI_WEB_ALLOWED = [
  'kimi',
  'k1',
  'k1.5',
  'k2',
  'k1.5-thinking',
] as const

type KimiWebModelId = (typeof KIMI_WEB_ALLOWED)[number]

/**
 * Map Mirage / OmniRoute / platform ids → kimi.com web `model` field.
 * OmniRoute used k2d6/k3; the consumer site still validates against the list above.
 */
export function resolveKimiUpstreamModel(raw: string): KimiWebModelId {
  const id = (raw.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw)
    .trim()
    .toLowerCase()
  if ((KIMI_WEB_ALLOWED as readonly string[]).includes(id)) {
    return id as KimiWebModelId
  }
  if (/thinking|reason/i.test(id)) return 'k1.5-thinking'
  if (/^k1\.5($|[^0-9])|^k1-5/.test(id)) return 'k1.5'
  if (/^k1($|[^0-9.])/.test(id)) return 'k1'
  if (/^kimi$/.test(id)) return 'kimi'
  // k2d6, k2.6, k3, kimi-k2.6, etc. → newest non-thinking web id
  return 'k2'
}

/** Catalog shown in Playground; upstreamName is what kimi.com accepts. */
export const KIMI_WEB_MODELS: AdapterModelSpec[] = [
  {
    modelKey: 'k2',
    displayName: 'K2',
    upstreamName: 'k2',
    contextWindow: 256_000,
    isDefault: true,
    supportsStream: true,
  },
  {
    modelKey: 'k1.5-thinking',
    displayName: 'K1.5 Thinking',
    upstreamName: 'k1.5-thinking',
    contextWindow: 256_000,
    supportsStream: true,
  },
  {
    modelKey: 'k1.5',
    displayName: 'K1.5',
    upstreamName: 'k1.5',
    contextWindow: 256_000,
    supportsStream: true,
  },
  {
    modelKey: 'k1',
    displayName: 'K1',
    upstreamName: 'k1',
    contextWindow: 128_000,
    supportsStream: true,
  },
  {
    modelKey: 'kimi',
    displayName: 'Kimi',
    upstreamName: 'kimi',
    contextWindow: 128_000,
    supportsStream: true,
  },
  // Aliases so old playground / client ids still resolve
  {
    modelKey: 'k2d6',
    displayName: 'K2.6 (web: k2)',
    upstreamName: 'k2',
    contextWindow: 256_000,
    supportsStream: true,
  },
  {
    modelKey: 'k2d6-thinking',
    displayName: 'K2.6 Thinking (web: k1.5-thinking)',
    upstreamName: 'k1.5-thinking',
    contextWindow: 256_000,
    supportsStream: true,
  },
  {
    modelKey: 'k3',
    displayName: 'K3 (web: k2)',
    upstreamName: 'k2',
    contextWindow: 256_000,
    supportsStream: true,
  },
]

export function getKimiWebCatalog(): AdapterModelSpec[] {
  return KIMI_WEB_MODELS.map((m) => ({ ...m }))
}

let cachedKimiModels: AdapterModelSpec[] | null = null
/** Current web refresh: GET with Authorization: Bearer <refresh_token> */
const KIMI_REFRESH = `${KIMI_BASE}/api/auth/token/refresh`
const KIMI_REFRESH_LEGACY = `${KIMI_BASE}/api/auth/refresh`
const KIMI_OAUTH_REFRESH = 'https://auth.kimi.com/api/oauth/token'
const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
const KIMI_CREATE_CHAT = `${KIMI_BASE}/api/chat`
const KIMI_USER = `${KIMI_BASE}/api/user`

function kimiCompletionUrl(chatId: string): string {
  return `${KIMI_BASE}/api/chat/${chatId}/completion/stream`
}

interface KimiUpstreamChunk {
  event?: string
  data?: string
}

export const kimiAdapter: ProviderAdapter = {
  key: 'kimi',
  displayName: 'Kimi (Moonshot)',

  listModels(): AdapterModelSpec[] {
    return cachedKimiModels?.length ? cachedKimiModels : getKimiWebCatalog()
  },

  async buildUpstreamRequest(
    req: OpenAIChatRequest,
    session: AdapterSessionContext,
  ): Promise<UpstreamRequestSpec> {
    const token = session.accessToken || extractAccessToken(session.cookies)
    if (!token) {
      throw new Error(
        'Kimi session has no access_token. The extension must capture Authorization ' +
          'header from kimi.com or run /api/auth/token/refresh first.',
      )
    }

    const authHeaders = {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Origin: KIMI_BASE,
      Referer: `${KIMI_BASE}/`,
      Accept: 'application/json, text/event-stream, */*',
      'X-Msh-Platform': 'web',
      'X-Msh-Device-Id': crypto.randomUUID(),
      'X-Msh-Session-Id': crypto.randomUUID().replace(/-/g, ''),
      Cookie: cookieHeader(session.cookies),
    }

    // Real chat id from POST /api/chat — reuse sticky Mirage chat to avoid
    // create-spam (empty "Mirage" rows + anti-bot triggers on probe traffic).
    // Real chat id from POST /api/chat — reuse sticky Mirage chat
    let kimiChatId = getStickyRemoteChat('kimi', session.id) || ''

    if (!kimiChatId) {
      const createResp = await fetch(KIMI_CREATE_CHAT, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          name: 'Mirage',
          is_example: false,
        }),
      })
      if (!createResp.ok) {
        const text = await createResp.text().catch(() => '')
        throw new Error(
          `Kimi create chat failed ${createResp.status}: ${text.slice(0, 200)}`,
        )
      }
      const created = await createResp.json()
      kimiChatId = String(created?.id || '')
      if (!kimiChatId) {
        throw new Error('Kimi create chat returned no id')
      }
      setStickyRemoteChat('kimi', session.id, kimiChatId)
    }

    // kimi.com allowlist only — OmniRoute ids (k2d6/k3) always 422.
    // Force a known-good id on the wire (resolve first, then clamp).
    const requested = String(req.model || 'k2')
    const resolved = resolveKimiUpstreamModel(requested)
    const upstreamModel =
      resolved === 'k1' ||
      resolved === 'k1.5' ||
      resolved === 'k2' ||
      resolved === 'k1.5-thinking' ||
      resolved === 'kimi'
        ? resolved
        : 'kimi'

    const body = {
      // NEVER send client modelKey — only allowlist literals.
      model: upstreamModel,
      messages: req.messages.map((m) => ({
        role:
          m.role === 'assistant'
            ? 'assistant'
            : m.role === 'system'
              ? 'system'
              : 'user',
        content:
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content
                  .map((p) => (p as { type: string; text?: string }).text || '')
                  .join('\n')
              : '',
      })),
      use_search: false,
      use_research: false,
      stream: true,
    }

    // Final freeze: JSON round-trip so nothing can mutate model after this.
    const frozenBody = JSON.parse(JSON.stringify(body)) as typeof body
    frozenBody.model = upstreamModel

    return {
      url: kimiCompletionUrl(kimiChatId),
      method: 'POST',
      stream: true,
      headers: {
        ...authHeaders,
        Referer: `${KIMI_BASE}/chat/${kimiChatId}`,
        'x-mirage-kimi-model': upstreamModel,
        'x-mirage-kimi-requested': requested.slice(0, 80),
      },
      body: frozenBody,
      remoteChatId: kimiChatId,
    }
  },

  async cleanupRemoteChat(session: AdapterSessionContext, remoteChatId: string) {
    clearStickyRemoteChat('kimi', session.id)
    await kimiDeleteChats(session, [remoteChatId])
  },

  async clearRemoteChats(
    session: AdapterSessionContext,
    opts = {},
  ): Promise<ClearRemoteChatsResult> {
    const mirageOnly = opts.mirageOnly !== false
    const limit = Math.min(500, Math.max(1, opts.limit ?? 200))
    const chats = await kimiListChats(session, limit)
    const targets = chats.filter((c) => {
      if (!c.id) return false
      if (!mirageOnly) return true
      return /mirage/i.test(c.name || '')
    })
    if (targets.length === 0) {
      return {
        ok: true,
        deleted: 0,
        listed: chats.length,
        mirageOnly,
        detail: mirageOnly
          ? 'No Mirage-named chats found on kimi.com'
          : 'No chats found on kimi.com',
      }
    }
    const ids = targets.map((c) => c.id)
    let deleted = 0
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50)
      const n = await kimiDeleteChats(session, batch)
      deleted += n
      await new Promise((r) => setTimeout(r, 200))
    }
    return {
      ok: true,
      deleted,
      listed: chats.length,
      mirageOnly,
      detail: `Deleted ${deleted} chat(s) on kimi.com`,
    }
  },

  async parseUpstreamResponse(
    raw: Response,
    _session: AdapterSessionContext,
    model: string,
  ): Promise<ChatCompletionResponse> {
    if (!raw.ok) {
      const text = await raw.text()
      throw new Error(`Kimi upstream error ${raw.status}: ${text.slice(0, 200)}`)
    }
    // Kimi always streams SSE even with stream=false in some deployments.
    // For non-stream, we collect all events.
    const text = await raw.text()
    const content = extractKimiContent(text)
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: estimateTokens(text, 0.3),
        completion_tokens: estimateTokens(content, 1),
        total_tokens: estimateTokens(text, 1),
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
    let sentRole = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        // Kimi sends SSE blocks separated by \n\n; each block has `event:` and `data:`
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const block of parts) {
          const evt = parseKimiSSEBlock(block)
          if (!evt) continue

          // Modern Kimi SSE puts the event name inside JSON (`event` field).
          try {
            const payload = JSON.parse(evt.data || '{}')
            const kind = payload.event || evt.event
            if (kind === 'cmpl') {
              const text = payload.text || ''
              if (!text) continue
              const delta: Partial<ChatMessage> = {}
              if (!sentRole) {
                delta.role = 'assistant'
                sentRole = true
              }
              delta.content = text
              yield {
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta, finish_reason: null }],
              }
            } else if (kind === 'done' || kind === 'all_done' || kind === 'end') {
              yield {
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              }
              return
            }
          } catch {
            // ignore malformed JSON
          }
        }
      }
      // Stream ended without explicit end event
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
    const refreshToken =
      session.refreshToken ||
      findCookie(session.cookies, 'refresh_token')?.value ||
      findCookie(session.cookies, 'refreshToken')?.value

    const errors: string[] = []

    if (refreshToken) {
      // 1) Current web refresh (GET + Bearer refresh_token)
      try {
        const resp = await fetch(KIMI_REFRESH, {
          method: 'GET',
          headers: {
            ...BROWSER_HEADERS,
            Authorization: `Bearer ${refreshToken}`,
            Origin: KIMI_BASE,
            Referer: `${KIMI_BASE}/`,
            Cookie: cookieHeader(session.cookies),
            Accept: 'application/json',
          },
        })
        if (resp.ok) {
          const data = await resp.json()
          const accessToken: string | undefined =
            data.access_token || data.accessToken || data.token
          if (accessToken) {
            const newRefresh: string =
              data.refresh_token || data.refreshToken || refreshToken
            const setCookie = resp.headers.getSetCookie?.() ?? []
            return {
              ok: true,
              accessToken,
              refreshToken: newRefresh,
              cookies: mergeSetCookie(session.cookies, setCookie),
              expiresAt: expiresFromJwt(accessToken, 30 * 60 * 1000),
              refreshExpiresAt: expiresFromJwt(
                newRefresh,
                30 * 24 * 60 * 60 * 1000,
              ),
            }
          }
        }
        errors.push(`token/refresh ${resp.status}`)
      } catch (e) {
        errors.push('token/refresh: ' + (e as Error).message)
      }

      // 2) Legacy POST /api/auth/refresh (older clients)
      try {
        const resp = await fetch(KIMI_REFRESH_LEGACY, {
          method: 'POST',
          headers: {
            ...BROWSER_HEADERS,
            'Content-Type': 'application/json',
            Authorization: `Bearer ${refreshToken}`,
            Origin: KIMI_BASE,
            Referer: `${KIMI_BASE}/`,
            Cookie: cookieHeader(session.cookies),
          },
        })
        if (resp.ok) {
          const data = await resp.json()
          const accessToken: string | undefined =
            data.access_token || data.accessToken || data.token
          if (accessToken) {
            const newRefresh: string =
              data.refresh_token || data.refreshToken || refreshToken
            const setCookie = resp.headers.getSetCookie?.() ?? []
            return {
              ok: true,
              accessToken,
              refreshToken: newRefresh,
              cookies: mergeSetCookie(session.cookies, setCookie),
              expiresAt: expiresFromJwt(accessToken, 30 * 60 * 1000),
              refreshExpiresAt: expiresFromJwt(
                newRefresh,
                30 * 24 * 60 * 60 * 1000,
              ),
            }
          }
        }
        errors.push(`legacy ${resp.status}`)
      } catch (e) {
        errors.push('legacy: ' + (e as Error).message)
      }

      // 3) OAuth refresh (Kimi Code tokens only)
      try {
        const body = new URLSearchParams({
          client_id: KIMI_OAUTH_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        })
        const resp = await fetch(KIMI_OAUTH_REFRESH, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body,
        })
        if (resp.ok) {
          const data = await resp.json()
          if (data.access_token) {
            const expiresIn = Number(data.expires_in) || 3600
            return {
              ok: true,
              accessToken: data.access_token,
              refreshToken: data.refresh_token || refreshToken,
              cookies: session.cookies,
              expiresAt: new Date(Date.now() + expiresIn * 1000),
              refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            }
          }
        }
        errors.push(`oauth ${resp.status}`)
      } catch (e) {
        errors.push('oauth: ' + (e as Error).message)
      }
    } else {
      errors.push('no refresh_token')
    }

    // 4) Soft keep-alive: if current access_token still works, don't kill the session
    const access =
      session.accessToken || extractAccessToken(session.cookies)
    if (access) {
      const v = await kimiAdapter.validate({
        ...session,
        accessToken: access,
      })
      if (v.valid) {
        return {
          ok: true,
          accessToken: access,
          refreshToken: refreshToken || session.refreshToken,
          cookies: session.cookies,
          expiresAt: expiresFromJwt(access, 10 * 60 * 1000),
          refreshExpiresAt: session.refreshExpiresAt,
        }
      }
      errors.push(v.reason || 'access invalid')
    }

    return {
      ok: false,
      error:
        errors.join('; ') ||
        'No refresh_token. Re-open www.kimi.com while logged in with the Mirage extension.',
    }
  },

  async ping(session: AdapterSessionContext) {
    // Prefer validate/soft keep-alive over forcing a broken refresh every ping.
    const access =
      session.accessToken || extractAccessToken(session.cookies)
    if (access) {
      const v = await kimiAdapter.validate({ ...session, accessToken: access })
      if (v.valid) return { ok: true }
    }
    const result = await kimiAdapter.refresh(session)
    return { ok: result.ok, error: result.error }
  },

  async validate(session: AdapterSessionContext): Promise<SessionValidationResult> {
    const token = session.accessToken || extractAccessToken(session.cookies)
    if (!token) {
      return { valid: false, reason: 'No access_token captured' }
    }
    try {
      const headers = {
        ...BROWSER_HEADERS,
        Authorization: `Bearer ${token}`,
        Cookie: cookieHeader(session.cookies),
        Origin: KIMI_BASE,
        Referer: `${KIMI_BASE}/`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Msh-Platform': 'web',
      }
      const resp = await fetch(KIMI_USER, { headers })
      if (resp.status === 401) return { valid: false, reason: 'Unauthorized (401)' }
      if (!resp.ok) return { valid: false, reason: `HTTP ${resp.status}` }
      const data = await resp.json().catch(() => null)
      if (!data?.id && !data?.email) {
        return { valid: false, reason: 'No user data' }
      }

      // Live discovery when endpoints work; else web allowlist catalog.
      const detected = await discoverKimiModels(headers)
      if (detected.length) {
        cachedKimiModels = detected.map((id) => {
          const upstream = resolveKimiUpstreamModel(id)
          return {
            modelKey: id,
            displayName: id,
            upstreamName: upstream,
            supportsStream: true,
            contextWindow: 256_000,
            isDefault: upstream === 'k2',
          }
        })
        return { valid: true, detectedModels: detected }
      }
      const catalog = getKimiWebCatalog()
      cachedKimiModels = catalog
      return {
        valid: true,
        detectedModels: catalog.map((m) => m.modelKey),
        reason: 'Using kimi.com web model allowlist (live /models empty)',
      }
    } catch (e) {
      return { valid: false, reason: (e as Error).message }
    }
  },
}

async function discoverKimiModels(
  headers: Record<string, string>,
): Promise<string[]> {
  const found = new Set<string>()

  const endpoints = [
    // OmniRoute / live SPA Connect-RPC catalog
    `${KIMI_BASE}/apiv2/kimi.gateway.config.v1.ConfigService/GetAvailableModels`,
    `${KIMI_BASE}/api/chat/models`,
    `${KIMI_BASE}/api/models`,
    `${KIMI_BASE}/api/chat/model/list`,
    `${KIMI_BASE}/api/user/models`,
  ]
  for (const url of endpoints) {
    try {
      const isConnect = url.includes('/apiv2/')
      const resp = await fetch(url, {
        method: isConnect ? 'POST' : 'GET',
        headers: {
          ...headers,
          Accept: 'application/json',
          ...(isConnect ? { 'Content-Type': 'application/json' } : {}),
        },
        body: isConnect ? '{}' : undefined,
        signal: AbortSignal.timeout(12_000),
      })
      if (!resp.ok) continue
      const text = await resp.text()
      if (!text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) {
        continue
      }
      collectKimiModelIds(JSON.parse(text), found)
    } catch {
      // next
    }
  }

  // Create-chat payload sometimes embeds available model ids
  try {
    const create = await fetch(KIMI_CREATE_CHAT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Mirage models', is_example: false }),
      signal: AbortSignal.timeout(12_000),
    })
    if (create.ok) {
      const j = await create.json()
      collectKimiModelIds(j, found)
    }
  } catch {
    // ignore
  }

  return Array.from(found).filter(Boolean).sort()
}

function collectKimiModelIds(node: unknown, out: Set<string>, depth = 0) {
  if (depth > 8 || node == null) return
  if (typeof node === 'string') {
    const s = node.trim()
    // Allow dots (k2d6, k2.5, k1.5) — only reject path-like ids.
    if (
      s.length >= 2 &&
      s.length < 80 &&
      /^(kimi|k2|k3|k1\.5|moonshot|okabe)/i.test(s) &&
      !/[\/\\]/.test(s)
    ) {
      // Skip agent swarm variants (need special protocol).
      if (/agent/i.test(s)) return
      out.add(s)
    }
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) collectKimiModelIds(item, out, depth + 1)
    return
  }
  if (typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  for (const [k, v] of Object.entries(obj)) {
    if (
      (k === 'id' ||
        k === 'key' ||
        k === 'model' ||
        k === 'model_id' ||
        k === 'modelId' ||
        k === 'name' ||
        k === 'slug' ||
        k === 'displayName') &&
      typeof v === 'string'
    ) {
      // Prefer machine key over display name when both present.
      if (k === 'displayName' && typeof obj.key === 'string') {
        collectKimiModelIds(obj.key, out, depth + 1)
      } else {
        collectKimiModelIds(v, out, depth + 1)
      }
    } else if (/model/i.test(k) || typeof v === 'object') {
      collectKimiModelIds(v, out, depth + 1)
    }
  }
}

function extractAccessToken(cookies: CookieJarEntry[]): string | undefined {
  return (
    findCookie(cookies, 'access_token')?.value ||
    findCookie(cookies, 'kimi_access_token')?.value
  )
}

function expiresFromJwt(token: string, fallbackMs: number): Date {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'),
    )
    if (typeof payload.exp === 'number') {
      return new Date(payload.exp * 1000)
    }
  } catch {
    // ignore
  }
  return new Date(Date.now() + fallbackMs)
}

function parseKimiSSEBlock(block: string): KimiUpstreamChunk | null {
  const lines = block.split('\n')
  let event = 'message'
  let data = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('event:')) event = trimmed.slice(6).trim()
    else if (trimmed.startsWith('data:')) data += trimmed.slice(5).trim()
  }
  if (!data) return null
  return { event, data }
}

function extractKimiContent(raw: string): string {
  // Kimi may return plain JSON or SSE; try to extract text safely.
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw)
      return (
        j.content ||
        j.choices?.[0]?.message?.content ||
        j.message?.content ||
        ''
      )
    } catch {
      return raw
    }
  }
  // SSE: only completion tokens (event=cmpl), field `text`
  let out = ''
  for (const block of raw.split('\n\n')) {
    const evt = parseKimiSSEBlock(block)
    if (!evt) continue
    try {
      const p = JSON.parse(evt.data || '{}')
      const kind = p.event || evt.event
      if (kind === 'cmpl' && typeof p.text === 'string') out += p.text
    } catch {
      // skip
    }
  }
  return out
}

function estimateTokens(text: string, factor: number): number {
  // rough estimate: ~4 chars per token
  return Math.max(1, Math.round((text.length / 4) * factor))
}

function mergeSetCookie(
  existing: CookieJarEntry[],
  setCookie: string[],
): CookieJarEntry[] {
  const merged = new Map<string, CookieJarEntry>()
  for (const c of existing) merged.set(`${c.name}@${c.domain}`, c)
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
    const key = `${name}@${domain}`
    merged.set(key, {
      name,
      value,
      domain: domain || '.kimi.com',
      path: '/',
    })
  }
  return Array.from(merged.values())
}

async function kimiAuthHeaders(
  session: AdapterSessionContext,
): Promise<Record<string, string>> {
  const token = session.accessToken || extractAccessToken(session.cookies)
  if (!token) throw new Error('Kimi session has no access_token')
  return {
    ...BROWSER_HEADERS,
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: KIMI_BASE,
    Referer: `${KIMI_BASE}/`,
    Accept: 'application/json',
    'Connect-Protocol-Version': '1',
    'X-Msh-Platform': 'web',
    Cookie: cookieHeader(session.cookies),
  }
}

async function kimiListChats(
  session: AdapterSessionContext,
  limit: number,
): Promise<Array<{ id: string; name?: string }>> {
  const headers = await kimiAuthHeaders(session)
  const out: Array<{ id: string; name?: string }> = []
  let pageToken = ''
  while (out.length < limit) {
    const resp = await fetch(
      `${KIMI_BASE}/apiv2/kimi.chat.v1.ChatService/ListChats`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: '',
          pageToken,
          pageSize: Math.min(50, limit - out.length),
        }),
        signal: AbortSignal.timeout(20_000),
      },
    )
    if (!resp.ok) {
      // Fallback: older list path
      const legacy = await fetch(`${KIMI_BASE}/api/chat/list`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(20_000),
      })
      if (!legacy.ok) {
        throw new Error(`Kimi list chats HTTP ${resp.status}`)
      }
      const lj = (await legacy.json().catch(() => ({}))) as {
        items?: Array<{ id?: string; name?: string }>
        chats?: Array<{ id?: string; name?: string }>
      }
      const items = lj.items || lj.chats || []
      for (const c of items) {
        if (c?.id) out.push({ id: String(c.id), name: c.name })
      }
      break
    }
    const data = (await resp.json()) as {
      chats?: Array<{ id?: string; name?: string }>
      nextPageToken?: string
    }
    const chats = data.chats || []
    for (const c of chats) {
      if (c?.id) out.push({ id: String(c.id), name: c.name })
    }
    pageToken = data.nextPageToken || ''
    if (!pageToken || chats.length === 0) break
  }
  return out.slice(0, limit)
}

async function kimiDeleteChats(
  session: AdapterSessionContext,
  chatIds: string[],
): Promise<number> {
  if (!chatIds.length) return 0
  const headers = await kimiAuthHeaders(session)
  const resp = await fetch(
    `${KIMI_BASE}/apiv2/kimi.chat.v1.ChatService/BatchDeleteChats`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatIds }),
      signal: AbortSignal.timeout(30_000),
    },
  )
  if (resp.ok) return chatIds.length
  // Per-chat fallback
  let deleted = 0
  for (const id of chatIds) {
    const r = await fetch(`${KIMI_BASE}/api/chat/${id}`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(15_000),
    })
    if (r.ok || r.status === 404) deleted += 1
  }
  return deleted
}

registerAdapter(kimiAdapter)
