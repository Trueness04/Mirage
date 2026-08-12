/**
 * Qwen International (chat.qwen.ai) — v2 API
 * --------------------------------------------------------------------
 * Legacy POST /api/chat/completions is dead upstream (always 504 HTML
 * from alibaba-ga). Current contract:
 *   1) POST /api/v2/chats/new
 *   2) POST /api/v2/chat/completions?chat_id=…
 * behind Alibaba BaXia WAF → must run via Mirage extension MAIN-world
 * fetch (credentials:include) so bx-* are injected live.
 */

import {
  enqueueToolJob,
  pickOnlineDeviceId,
  waitForToolJob,
} from '@/lib/tools/local'
import {
  browserHeaders,
  type AdapterSessionContext,
  type CookieJarEntry,
  type OpenAIChatRequest,
  cookieHeader,
  findCookie,
} from './base'
import { ensureQwenWafCookies } from './qwen-waf'
import { notifyCaptchaRequired } from '@/lib/notify'
import { resolveQwenUpstreamModel } from './qwen-catalog'

const CHAT_QWEN = 'https://chat.qwen.ai'
const CHATS_NEW = `${CHAT_QWEN}/api/v2/chats/new`
const CHAT_COMPLETIONS = `${CHAT_QWEN}/api/v2/chat/completions`

/** SPA build id — without `version`, v2 returns Bad_Request. */
const QWEN_SPA_VERSION = '0.2.66'
const BX_VERSION = '2.5.36'

const MODEL_ALIASES: Record<string, string> = {
  'qwen-plus': 'qwen3.7-plus',
  'qwen-max': 'qwen3.7-max',
  'qwen-turbo': 'qwen3.6-plus',
  'qwen3-plus': 'qwen3.7-plus',
  'qwen3-max': 'qwen3.7-max',
  'qwen3-flash': 'qwen3.6-plus',
  'qwen3-coder-flash': 'qwen3.6-plus',
  qwen: 'qwen3.7-max',
  qwen3: 'qwen3.7-max',
}

const INTL_HELP =
  'Log in at https://chat.qwen.ai, keep the tab open, Capture with Mirage. ' +
  'Need localStorage token (or token cookie) + WAF cookies (cna / ssxmod_*). ' +
  'Do NOT use the retired /api/chat/completions path (always 504 alibaba-ga).'

export function isChatQwenHost(websiteUrl: string | null | undefined): boolean {
  if (!websiteUrl) return false
  try {
    const h = new URL(websiteUrl).hostname.toLowerCase()
    return h === 'chat.qwen.ai' || h === 'www.qwen.ai' || h === 'qwen.ai'
  } catch {
    return /chat\.qwen\.ai/i.test(websiteUrl)
  }
}

export function isChatQwenProviderKey(key: string): boolean {
  const k = key.toLowerCase()
  return (
    k === 'chat-qwen-ai' ||
    k === 'qwen-international' ||
    k === 'qwen-intl' ||
    k === 'qwen-ai' ||
    k === 'qwenweb'
  )
}

export function extractQwenIntlToken(session: AdapterSessionContext): string {
  const fromCookie =
    findCookie(session.cookies, 'token')?.value?.trim() ||
    findCookie(session.cookies, 'access_token')?.value?.trim() ||
    ''
  const fromAccess = (session.accessToken || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
  const raw = fromCookie || fromAccess
  if (!raw) return ''
  // localStorage JSON wrapper
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw) as { value?: unknown }
      if (typeof j.value === 'string' && j.value.trim()) return j.value.trim()
    } catch {
      // fall through
    }
  }
  return raw.replace(/^Bearer\s+/i, '')
}

export function hasQwenIntlAuth(session: AdapterSessionContext): boolean {
  return Boolean(extractQwenIntlToken(session) || session.cookies.length > 0)
}

function mapIntlModel(model: string): string {
  const id = resolveQwenUpstreamModel(model)
    .replace(/^(qwen|qwen-web|chat-qwen-ai)\//i, '')
    .trim()
  const lower = id.toLowerCase()
  return MODEL_ALIASES[lower] || id
}

function foldMessages(req: OpenAIChatRequest): string {
  let system = ''
  let user = ''
  for (const m of req.messages || []) {
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((p) =>
                typeof p === 'string'
                  ? p
                  : String((p as { text?: string }).text || ''),
              )
              .join('\n')
          : ''
    if (m.role === 'system') system += (system ? '\n\n' : '') + text
    else if (m.role === 'user') user = text
  }
  return system ? `${system}\n\nUser: ${user}` : user
}

function realCookieHeader(cookies: CookieJarEntry[]): string {
  // Drop Mirage synthetic bx-* jar entries from Cookie header.
  const filtered = cookies.filter(
    (c) => c?.name && !String(c.name).startsWith('__mirage_'),
  )
  return cookieHeader(filtered)
}

export function buildQwenIntlHeaders(opts: {
  token: string
  cookies: CookieJarEntry[]
  chatId?: string
  session?: AdapterSessionContext
}): Record<string, string> {
  const headers: Record<string, string> = {
    ...browserHeaders(opts.session),
    Accept: '*/*',
    'Content-Type': 'application/json',
    Origin: CHAT_QWEN,
    Referer: opts.chatId
      ? `${CHAT_QWEN}/c/${opts.chatId}`
      : `${CHAT_QWEN}/`,
    source: 'web',
    version: QWEN_SPA_VERSION,
    'x-request-id': crypto.randomUUID(),
    'bx-v': BX_VERSION,
  }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const jar = realCookieHeader(opts.cookies)
  if (jar) headers.Cookie = jar

  const bxUa = findCookie(opts.cookies, '__mirage_bx_ua')?.value
  const bxUmid = findCookie(opts.cookies, '__mirage_bx_umidtoken')?.value
  if (bxUa) headers['bx-ua'] = bxUa
  if (bxUmid) headers['bx-umidtoken'] = bxUmid

  return headers
}

function isWafOrDeadV1(status: number, contentType: string, body: string): boolean {
  if (status === 504) return true
  if (/text\/html/i.test(contentType) || /<!DOCTYPE html>/i.test(body)) return true
  return /aliyun_waf|alibaba-ga|Gateway Time-out|baxia/i.test(body)
}

async function browserJson(
  opts: {
    url: string
    method?: string
    headers: Record<string, string>
    body?: string
    deviceId?: string | null
  },
): Promise<{ status: number; ok: boolean; body: string; contentType: string }> {
  const deviceId = await pickOnlineDeviceId(opts.deviceId)
  if (!deviceId) {
    throw new Error(
      `Qwen International needs an online Mirage extension with ${CHAT_QWEN} open. ${INTL_HELP}`,
    )
  }
  const headers = { ...opts.headers }
  // Live tab cookies win for WAF; keep Authorization / source / version / bx-*.
  delete headers.Cookie
  delete headers.cookie

  const jobId = await enqueueToolJob({
    deviceId,
    toolName: 'mirage_browser_fetch',
    arguments: {
      url: opts.url,
      method: opts.method || 'POST',
      headers,
      body: opts.body,
      maxBody: 2_000_000,
    },
  })
  const waited = await waitForToolJob(jobId, 70_000, 400)
  if (!waited.ok) {
    throw new Error(waited.error || 'extension browser_fetch failed for Qwen')
  }
  const r = waited.result as {
    status?: number
    ok?: boolean
    body?: string
    contentType?: string
  } | null
  return {
    status: Number(r?.status || 502),
    ok: Boolean(r?.ok),
    body: String(r?.body ?? ''),
    contentType: String(r?.contentType || ''),
  }
}

async function createIntlChatId(opts: {
  session: AdapterSessionContext
  cookies: CookieJarEntry[]
  token: string
  modelId: string
}): Promise<string> {
  const headers = buildQwenIntlHeaders({
    token: opts.token,
    cookies: opts.cookies,
    session: opts.session,
  })
  const res = await browserJson({
    url: CHATS_NEW,
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'New Chat',
      models: [opts.modelId],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
    }),
    deviceId: opts.session.deviceId,
  })

  if (isWafOrDeadV1(res.status, res.contentType, res.body)) {
    throw new Error(
      `Qwen International WAF/auth blocked create-chat (HTTP ${res.status}). ${INTL_HELP}`,
    )
  }
  if (!res.ok) {
    throw new Error(
      `Qwen create-chat HTTP ${res.status}: ${res.body.replace(/\s+/g, ' ').slice(0, 240)}`,
    )
  }

  let chatId = ''
  try {
    const j = JSON.parse(res.body) as { data?: { id?: string }; id?: string }
    chatId = String(j?.data?.id || j?.id || '')
  } catch {
    throw new Error(
      `Qwen create-chat returned non-JSON: ${res.body.slice(0, 180)}`,
    )
  }
  if (!chatId) {
    throw new Error('Qwen create-chat returned no chat_id')
  }
  return chatId
}

export async function buildQwenIntlUpstream(
  req: OpenAIChatRequest,
  session: AdapterSessionContext,
): Promise<{
  url: string
  method: 'POST'
  stream: true
  viaBrowser: true
  headers: Record<string, string>
  body: Record<string, unknown>
  remoteChatId: string
}> {
  let cookies = session.cookies
  try {
    cookies = await ensureQwenWafCookies({
      sessionId: session.id || '',
      deviceId: session.deviceId,
      cookies,
    })
  } catch (e) {
    // Still attempt viaBrowser — live BaXia often works without harvested bx-*.
    const msg = (e as Error).message
    console.warn('[qwen-intl] waf warmup:', msg)
    notifyCaptchaRequired('Qwen', `WAF warmup failed: ${msg}`)
  }

  const token = extractQwenIntlToken({ ...session, cookies })
  if (!token && cookies.length === 0) {
    throw new Error(`Qwen International missing token/cookies. ${INTL_HELP}`)
  }

  const modelId = mapIntlModel(String(req.model || ''))
  const chatId = await createIntlChatId({
    session,
    cookies,
    token,
    modelId,
  })

  const prompt = foldMessages(req)
  const enableThinking =
    /think|reason|r1|preview/i.test(String(req.model || '')) ||
    /preview/i.test(modelId)
  const fid = crypto.randomUUID()

  const body = {
    stream: true,
    incremental_output: true,
    chat_id: chatId,
    chat_mode: 'normal',
    model: modelId,
    parent_id: null as null,
    messages: [
      {
        fid,
        parentId: null,
        childrenIds: [] as string[],
        role: 'user',
        content: prompt,
        user_action: 'chat',
        files: [] as unknown[],
        timestamp: Math.floor(Date.now() / 1000),
        models: [modelId],
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: enableThinking,
          output_schema: 'phase',
          auto_thinking: enableThinking,
          research_mode: 'normal',
          auto_search: false,
        },
        sub_chat_type: 't2t',
        parent_id: null,
      },
    ],
  }

  return {
    url: `${CHAT_COMPLETIONS}?chat_id=${encodeURIComponent(chatId)}`,
    method: 'POST',
    stream: true,
    viaBrowser: true,
    headers: buildQwenIntlHeaders({ token, cookies, chatId }),
    body,
    remoteChatId: chatId,
  }
}

/** Parse chat.qwen.ai phase SSE → answer / think text. */
export function parseQwenIntlSseLine(
  line: string,
): { kind: 'answer' | 'think'; text: string } | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{ delta?: { phase?: string | null; content?: unknown } }>
      success?: boolean
      data?: { code?: string; message?: string }
    }
    if (parsed?.success === false) {
      const code = parsed.data?.code || 'error'
      const msg = parsed.data?.message || code
      throw new Error(`Qwen International: ${code} — ${msg}`)
    }
    const delta = parsed?.choices?.[0]?.delta
    if (!delta) return null
    const content = typeof delta.content === 'string' ? delta.content : ''
    if (!content) return null
    const phase = delta.phase
    if (phase === 'think' || phase === 'thinking_summary') {
      return { kind: 'think', text: content }
    }
    if (phase === 'answer' || phase == null) {
      return { kind: 'answer', text: content }
    }
    return null
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Qwen International:')) throw e
    return null
  }
}

export function collectQwenIntlContent(raw: string): string {
  let content = ''
  let reasoning = ''
  for (const line of raw.split('\n')) {
    const d = parseQwenIntlSseLine(line)
    if (!d) continue
    if (d.kind === 'answer') content += d.text
    else reasoning += d.text
  }
  return content || reasoning
}

export { INTL_HELP, CHAT_QWEN }
