/**
 * Z.AI Chat Adapter (v1.2)
 * --------------------------------------------------------------------
 * Website: https://chat.z.ai
 *
 * Auth (web UI, reverse-engineered):
 *  - JWT bearer in Authorization header (also sometimes in cookie `token`)
 *  - Session probe: GET https://chat.z.ai/api/v1/auths/
 *    (legacy /api/auth/session returns 404)
 *  - Chat: POST https://chat.z.ai/api/v2/chat/completions
 *    with Authorization: Bearer <jwt> + cookies
 *
 * Fallback SDK mode still available via /api/test/zai.
 */

import { createHmac } from 'node:crypto'
import { db } from '@/lib/db'
import {
  browserHeaders,
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
import {
  readStoredZaiCaptcha,
  stripMirageCookies,
  ZAI_CAPTCHA_COOKIE,
} from './zai-captcha'
import { notifyCaptchaRequired } from '@/lib/notify'

const ZAI = 'https://chat.z.ai'
const ZAI_CHAT = `${ZAI}/api/v2/chat/completions`
const ZAI_AUTHS = `${ZAI}/api/v1/auths/`
const ZAI_MODELS = `${ZAI}/api/models`

/** Matches current chat.z.ai SPA (avoids 426 "client version outdated"). */
const ZAI_FE_VERSION = 'prod-fe-1.1.69'

const ZAI_CAPTCHA_HINT =
  'Z.AI captcha rejected (FRONTEND_CAPTCHA_REQUIRED). Keep the Mirage extension ' +
  'online with a logged-in https://chat.z.ai tab open, then retry — Mirage will ' +
  'solve Aliyun captcha via the extension.'

let cachedModels: AdapterModelSpec[] | null = null

export const zaiAdapter: ProviderAdapter = {
  key: 'zai',
  displayName: 'Z.AI Chat',

  listModels(): AdapterModelSpec[] {
    // Live catalog only (from GET /api/models). Never a hardcoded fallback.
    return cachedModels ?? []
  },

  async buildUpstreamRequest(
    req: OpenAIChatRequest,
    session: AdapterSessionContext,
  ): Promise<UpstreamRequestSpec> {
    const upstreamCookies = stripMirageCookies(session.cookies)
    const cookieStr = cookieHeader(upstreamCookies)
    const token = extractZaiToken(session)
    if (!cookieStr && !token) {
      throw new Error(
        'Z.AI session has no cookies/token. Open chat.z.ai while logged in ' +
          'with the Mirage extension installed, then re-capture.',
      )
    }
    const captcha =
      readStoredZaiCaptcha(session.cookies)?.param ||
      findCookie(session.cookies, ZAI_CAPTCHA_COOKIE)?.value ||
      ''
    if (!captcha) {
      throw new Error(
        'Z.AI captcha token missing. Keep Mirage extension online with a ' +
          'chat.z.ai tab open — the server will request mirage_zai_captcha.',
      )
    }

    const upstreamModel = req.model.includes('/')
      ? req.model.slice(req.model.indexOf('/') + 1)
      : req.model
    const thinkingModel = /think|reason|r1/i.test(upstreamModel)
    // Thinking models burn completion budget on reasoning_content first.
    const maxTokens =
      req.max_tokens ?? (thinkingModel ? 16_384 : 4096)

    const chatId = crypto.randomUUID()
    const completionId = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    const mappedMessages = req.messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((p) => (p as { text?: string }).text || '').join('\n')
            : '',
    }))
    const lastUser =
      [...mappedMessages].reverse().find((m) => m.role === 'user')?.content || ''
    const body = {
      chat_id: chatId,
      id: completionId,
      model: upstreamModel,
      messages: mappedMessages,
      signature_prompt: String(lastUser).slice(0, 500),
      params: {},
      extra: {},
      features: {
        image_generation: false,
        web_search: false,
        auto_web_search: false,
        preview_mode: true,
        flags: [] as string[],
        enable_thinking: thinkingModel,
        reasoning_effort: thinkingModel ? 'max' : '',
      },
      current_user_message_id: messageId,
      current_user_message_parent_id: null as string | null,
      background_tasks: {
        title_generation: true,
        tags_generation: true,
      },
      captcha_verify_param: captcha,
      temperature: req.temperature ?? 0.7,
      top_p: req.top_p ?? 0.9,
      max_tokens: maxTokens,
      // Web UI always streams; non-stream clients collect via parseUpstreamResponse.
      stream: true,
    }

    const userId = extractUserIdFromJwt(token || '') || 'guest'
    const timestamp = String(Date.now())
    const requestId = crypto.randomUUID()
    const signature = computeZaiSignature(requestId, timestamp, userId)
    const sessionHeaders = browserHeaders(session)
    const qs = new URLSearchParams({
      timestamp,
      requestId,
      user_id: userId,
      version: '0.0.1',
      platform: 'web',
      token: token || '',
      user_agent: sessionHeaders['User-Agent'] || '',
      language: 'en-US',
      languages: 'en-US,en',
      timezone: 'UTC',
      cookie_enabled: 'true',
      current_url: `${ZAI}/c/${chatId}`,
      pathname: `/c/${chatId}`,
      host: 'chat.z.ai',
      hostname: 'chat.z.ai',
      protocol: 'https:',
      signature_timestamp: timestamp,
    })

    const headers: Record<string, string> = {
      ...sessionHeaders,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
      Origin: ZAI,
      Referer: `${ZAI}/c/${chatId}`,
      'X-FE-Version': ZAI_FE_VERSION,
      'X-Signature': signature,
      'X-Region': 'overseas',
    }
    if (cookieStr) headers.Cookie = cookieStr
    if (token) headers.Authorization = `Bearer ${token}`

    return {
      url: `${ZAI_CHAT}?${qs.toString()}`,
      method: 'POST',
      stream: true,
      headers,
      body,
    }
  },

  async parseUpstreamResponse(
    raw: Response,
    _session: AdapterSessionContext,
    model: string,
  ): Promise<ChatCompletionResponse> {
    if (!raw.ok) {
      const text = await raw.text()
      throw new Error(`Z.AI upstream error ${raw.status}: ${text.slice(0, 200)}`)
    }
    const ct = raw.headers.get('content-type') || ''
    if (ct.includes('text/event-stream') || ct.includes('text/plain')) {
      const text = await raw.text()
      const { content, reasoning } = collectZaiSse(text)
      const message: ChatMessage & { reasoning_content?: string } = {
        role: 'assistant',
        content: content || reasoning,
      }
      if (reasoning && content) message.reasoning_content = reasoning
      if (!message.content) {
        throw new Error(
          `Z.AI returned empty content. Raw: ${text.replace(/\s+/g, ' ').trim().slice(0, 280) || '(no body)'}`,
        )
      }
      return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: Math.max(1, Math.ceil(message.content.length / 4)),
          total_tokens: Math.max(1, Math.ceil(message.content.length / 4)),
        },
      }
    }

    const j = await raw.json()
    const choice = j.choices?.[0]
    const msg = (choice?.message || {}) as Record<string, unknown>
    let content = typeof msg.content === 'string' ? msg.content : ''
    const reasoning =
      typeof msg.reasoning_content === 'string' ? msg.reasoning_content : ''
    if (!content && reasoning) content = reasoning
    const message: ChatMessage & { reasoning_content?: string } = {
      role: 'assistant',
      content,
    }
    if (reasoning && content !== reasoning) message.reasoning_content = reasoning
    return {
      id: j.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: j.created || Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: choice?.finish_reason || 'stop',
        },
      ],
      usage: j.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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
        // Accept both \n\n-framed SSE and bare line SSE from chat.z.ai
        const parts = buf.split(/\r?\n/)
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
            const j = JSON.parse(data) as Record<string, unknown>
            const upstreamErr = extractZaiError(j)
            if (upstreamErr) {
              if (/CAPTCHA/i.test(upstreamErr)) {
                notifyCaptchaRequired('Z.AI', ZAI_CAPTCHA_HINT)
              }
              throw new Error(
                /CAPTCHA/i.test(upstreamErr)
                  ? ZAI_CAPTCHA_HINT
                  : `Z.AI: ${upstreamErr}`,
              )
            }
            const extracted = extractZaiDelta(j)
            if (!extracted.content && !extracted.reasoning && !extracted.finish) {
              continue
            }
            const delta: Partial<ChatMessage> & { reasoning_content?: string } = {}
            if (!sentRole) {
              delta.role = 'assistant'
              sentRole = true
            }
            if (extracted.content) delta.content = extracted.content
            if (extracted.reasoning) delta.reasoning_content = extracted.reasoning
            yield {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: extracted.finish,
                },
              ],
            }
            if (extracted.finish) return
          } catch {
            // skip non-JSON
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
      const token = extractZaiToken(session)
      const headers: Record<string, string> = {
        ...browserHeaders(session),
        Cookie: cookieHeader(session.cookies),
        Origin: ZAI,
        Referer: `${ZAI}/`,
        Accept: 'application/json',
      }
      if (token) headers.Authorization = `Bearer ${token}`

      const resp = await fetch(ZAI_AUTHS, {
        method: 'GET',
        headers,
      })
      if (!resp.ok) {
        return {
          ok: false,
          error: `Z.AI session refresh ${resp.status} (expected /api/v1/auths/)`,
        }
      }
      const j = (await resp.json().catch(() => ({}))) as Record<string, unknown>
      const newToken =
        pickString(j, ['token', 'access_token', 'accessToken']) ||
        pickNestedToken(j) ||
        token

      const setCookie = resp.headers.getSetCookie?.() ?? []
      const updatedCookies = mergeCookies(session.cookies, setCookie)
      // Ensure token cookie stays in sync when API returns a JWT
      const cookiesWithToken = upsertCookie(
        updatedCookies,
        'token',
        newToken,
        '.z.ai',
      )

      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
      return {
        ok: true,
        accessToken: newToken,
        cookies: cookiesWithToken,
        expiresAt,
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },

  async ping(session: AdapterSessionContext) {
    const r = await zaiAdapter.refresh(session)
    return { ok: r.ok, error: r.error }
  },

  async validate(session: AdapterSessionContext): Promise<SessionValidationResult> {
    try {
      const token = extractZaiToken(session)
      if (!token && session.cookies.length === 0) {
        return { valid: false, reason: 'No token or cookies captured' }
      }
      const headers: Record<string, string> = {
        ...browserHeaders(session),
        Cookie: cookieHeader(session.cookies),
        Origin: ZAI,
        Referer: `${ZAI}/`,
        Accept: 'application/json',
      }
      if (token) headers.Authorization = `Bearer ${token}`

      const resp = await fetch(ZAI_AUTHS, { headers })
      if (resp.status === 401 || resp.status === 403) {
        return { valid: false, reason: 'Unauthorized' }
      }
      if (!resp.ok) return { valid: false, reason: `HTTP ${resp.status}` }
      const j = (await resp.json().catch(() => ({}))) as Record<string, unknown>
      // Guest JWTs may lack email; treat any non-empty auth payload with token/id as valid
      const hasIdentity =
        Boolean(j.user || j.email || j.userId || j.id || j.token || j.name) ||
        Boolean(token)
      if (!hasIdentity) {
        return { valid: false, reason: 'No authenticated user in session payload' }
      }

      const models = await discoverZaiModels(headers)
      cachedModels = models
      if (models.length) await syncZaiModelsToDb(models)
      return {
        valid: true,
        detectedModels: models.map((m) => m.modelKey),
      }
    } catch (e) {
      return { valid: false, reason: (e as Error).message }
    }
  },
}

/** Live catalog from chat.z.ai — OpenWebUI-style GET /api/models */
async function discoverZaiModels(
  headers: Record<string, string>,
): Promise<AdapterModelSpec[]> {
  try {
    const resp = await fetch(ZAI_MODELS, {
      headers: { ...headers, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!resp.ok) return []
    const j = (await resp.json()) as {
      data?: Array<Record<string, unknown>>
    }
    const rows = Array.isArray(j.data) ? j.data : []
    const out: AdapterModelSpec[] = []
    for (const row of rows) {
      const id = String(row.id || row.name || '').trim()
      if (!id || id === 'default') continue
      const info =
        row.info && typeof row.info === 'object'
          ? (row.info as Record<string, unknown>)
          : null
      const display = String(
        row.name || info?.name || id,
      ).trim()
      const params =
        info?.params && typeof info.params === 'object'
          ? (info.params as Record<string, unknown>)
          : null
      const maxTok =
        typeof params?.max_tokens === 'number' ? params.max_tokens : undefined
      out.push({
        modelKey: id,
        displayName: display || id,
        upstreamName: id,
        contextWindow: maxTok && maxTok > 1000 ? maxTok : 128_000,
        isDefault: out.length === 0,
        supportsStream: true,
      })
    }
    return out
  } catch {
    return []
  }
}

async function syncZaiModelsToDb(models: AdapterModelSpec[]) {
  try {
    const provider = await db.provider.findUnique({ where: { key: 'zai' } })
    if (!provider || !models.length) return
    const keep = new Set(models.map((m) => m.modelKey))
    for (const m of models) {
      await db.providerModel.upsert({
        where: {
          providerId_modelKey: {
            providerId: provider.id,
            modelKey: m.modelKey,
          },
        },
        update: {
          displayName: m.displayName,
          upstreamName: m.upstreamName ?? m.modelKey,
          enabled: true,
          isDefault: m.isDefault ?? false,
          contextWindow: m.contextWindow ?? 128_000,
          supportsStream: true,
        },
        create: {
          providerId: provider.id,
          modelKey: m.modelKey,
          displayName: m.displayName,
          upstreamName: m.upstreamName ?? m.modelKey,
          enabled: true,
          isDefault: m.isDefault ?? false,
          contextWindow: m.contextWindow ?? 128_000,
          supportsStream: true,
        },
      })
    }
    const existing = await db.providerModel.findMany({
      where: { providerId: provider.id },
    })
    for (const row of existing) {
      if (!keep.has(row.modelKey)) {
        await db.providerModel.update({
          where: { id: row.id },
          data: { enabled: false, isDefault: false },
        })
      }
    }
  } catch {
    // best-effort
  }
}

function extractZaiError(j: Record<string, unknown>): string | null {
  const dig = (obj: unknown, depth = 0): string | null => {
    if (!obj || typeof obj !== 'object' || depth > 4) return null
    const o = obj as Record<string, unknown>
    const err = o.error
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>
      const detail = typeof e.detail === 'string' ? e.detail.trim() : ''
      const code = String(e.code || e.error_code || '').trim()
      if (detail || code) return detail || code
    }
    if (typeof err === 'string' && err.trim()) return err.trim()
    return dig(o.data, depth + 1)
  }
  return dig(j)
}

function extractZaiDelta(j: Record<string, unknown>): {
  content: string
  reasoning: string
  finish: string | null
} {
  const choice = Array.isArray(j.choices)
    ? (j.choices[0] as Record<string, unknown> | undefined)
    : undefined
  const delta =
    choice?.delta && typeof choice.delta === 'object'
      ? (choice.delta as Record<string, unknown>)
      : null
  const data =
    j.data && typeof j.data === 'object'
      ? (j.data as Record<string, unknown>)
      : null
  const nested =
    data?.data && typeof data.data === 'object'
      ? (data.data as Record<string, unknown>)
      : null

  let content = ''
  let reasoning = ''

  if (typeof delta?.content === 'string') content += delta.content
  if (typeof delta?.reasoning_content === 'string') {
    reasoning += delta.reasoning_content
  }

  // OpenWebUI / chat.z.ai custom SSE envelope (incl. nested edit/message shapes)
  for (const envelope of [data, nested, j]) {
    if (!envelope || typeof envelope !== 'object') continue
    const env = envelope as Record<string, unknown>
    if (typeof env.delta_content === 'string') {
      const phase = String(env.phase || env.status || env.type || '').toLowerCase()
      if (phase.includes('think') || phase.includes('reason')) {
        reasoning += env.delta_content
      } else {
        content += env.delta_content
      }
    }
    if (typeof env.edit_content === 'string') content += env.edit_content
    if (typeof env.content === 'string' && env.content && !content) {
      content = env.content
    }
    const msg = env.message
    if (msg && typeof msg === 'object') {
      const m = msg as Record<string, unknown>
      if (typeof m.content === 'string' && m.content) content += m.content
      if (typeof m.reasoning_content === 'string') {
        reasoning += m.reasoning_content
      }
    }
  }
  if (typeof j.content === 'string' && !content) content = j.content
  if (typeof j.delta_content === 'string' && !content) content = j.delta_content
  // Some Z.AI models emit only `data: {"data":"..."}` string chunks
  if (!content && typeof data === 'object' && data && typeof (data as { data?: unknown }).data === 'string') {
    const s = String((data as { data: string }).data)
    if (s && !s.startsWith('{')) content += s
  }

  const finish =
    (typeof choice?.finish_reason === 'string' && choice.finish_reason) ||
    (typeof data?.finish_reason === 'string' && data.finish_reason) ||
    (data?.done === true ? 'stop' : null) ||
    null

  return { content, reasoning, finish }
}

function collectZaiSse(raw: string): { content: string; reasoning: string } {
  let content = ''
  let reasoning = ''
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const j = JSON.parse(data) as Record<string, unknown>
      const err = extractZaiError(j)
      if (err) {
        if (/CAPTCHA/i.test(err)) {
          notifyCaptchaRequired('Z.AI', ZAI_CAPTCHA_HINT)
        }
        throw new Error(/CAPTCHA/i.test(err) ? ZAI_CAPTCHA_HINT : `Z.AI: ${err}`)
      }
      const d = extractZaiDelta(j)
      content += d.content
      reasoning += d.reasoning
    } catch (e) {
      if (e instanceof SyntaxError) continue
      throw e
    }
  }
  return { content, reasoning }
}

/** Browser HMAC over sorted fingerprint params (empty key — matches SPA). */
function computeZaiSignature(
  requestId: string,
  timestamp: string,
  userId: string,
): string {
  const params: Record<string, string> = {
    requestId,
    timestamp,
    user_id: userId,
  }
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join(',')
  return createHmac('sha256', Buffer.alloc(0)).update(sorted).digest('hex')
}

function extractUserIdFromJwt(token: string): string | undefined {
  const raw = token.replace(/^Bearer\s+/i, '').trim()
  const parts = raw.split('.')
  if (parts.length < 2) return undefined
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const payload = JSON.parse(json) as Record<string, unknown>
    for (const key of ['id', 'user_id', 'uid', 'sub']) {
      const v = payload[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  } catch {
    // ignore
  }
  return undefined
}

function extractZaiToken(session: AdapterSessionContext): string | undefined {
  const direct = session.accessToken?.replace(/^Bearer\s+/i, '').trim()
  if (direct) return direct
  for (const name of ['token', 'userToken', 'access_token', 'Authorization']) {
    const c = findCookie(session.cookies, name)?.value?.trim()
    if (c) return c.replace(/^Bearer\s+/i, '')
  }
  return undefined
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

function pickNestedToken(obj: Record<string, unknown>): string | undefined {
  const user = obj.user
  if (user && typeof user === 'object') {
    return pickString(user as Record<string, unknown>, [
      'token',
      'access_token',
      'accessToken',
    ])
  }
  return undefined
}

function asCookieJarEntry(c: {
  name: string
  value: string
  domain: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: CookieJarEntry['sameSite']
}): CookieJarEntry {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path ?? '/',
    ...(c.expires != null ? { expires: c.expires } : {}),
    ...(c.httpOnly != null ? { httpOnly: c.httpOnly } : {}),
    ...(c.secure != null ? { secure: c.secure } : {}),
    ...(c.sameSite != null ? { sameSite: c.sameSite } : {}),
  }
}

function upsertCookie(
  cookies: CookieJarEntry[],
  name: string,
  value: string | undefined,
  domain: string,
): CookieJarEntry[] {
  if (!value) return cookies
  const filtered = cookies.filter((c) => c.name.toLowerCase() !== name.toLowerCase())
  filtered.push(asCookieJarEntry({ name, value, domain, path: '/' }))
  return filtered
}

function mergeCookies(
  existing: Array<{
    name: string
    value: string
    domain: string
    path?: string
    expires?: number
    httpOnly?: boolean
    secure?: boolean
    sameSite?: CookieJarEntry['sameSite']
  }>,
  setCookie: string[],
): CookieJarEntry[] {
  const merged = new Map<string, CookieJarEntry>()
  for (const c of existing) {
    merged.set(`${c.name}@${c.domain}`, asCookieJarEntry(c))
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
    merged.set(
      `${name}@${domain}`,
      asCookieJarEntry({
        name,
        value,
        domain: domain || '.z.ai',
        path: '/',
      }),
    )
  }
  return Array.from(merged.values())
}

registerAdapter(zaiAdapter)
