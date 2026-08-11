/**
 * Qwen adapter — dual mode
 * --------------------------------------------------------------------
 * Chinese (Tongyi): cookie tongyi_sso_ticket → HTTP/2
 *   qianwen.biz.aliyun.com/dialog/conversation
 * International (chat.qwen.ai): JWT + WAF → v2 viaBrowser
 *   POST /api/v2/chats/new → /api/v2/chat/completions?chat_id=
 *   (legacy /api/chat/completions is dead — always 504 alibaba-ga)
 */

import http2 from 'node:http2'
import {
  type AdapterModelSpec,
  type AdapterSessionContext,
  type ChatCompletionResponse,
  type ChatMessage,
  type ClearRemoteChatsResult,
  type OpenAIChatRequest,
  type ProviderAdapter,
  type RefreshResult,
  type SessionValidationResult,
  type StreamChunk,
  type UpstreamRequestSpec,
  findCookie,
  registerAdapter,
} from './base'
import {
  QWEN_FREE_API_MODELS as QWEN_WEB_MODELS,
  getQwenWebCatalog,
  resolveQwenUpstreamModel,
} from './qwen-catalog'
import {
  INTL_HELP,
  buildQwenIntlUpstream,
  collectQwenIntlContent,
  extractQwenIntlToken,
  hasQwenIntlAuth,
  parseQwenIntlSseLine,
} from './qwen-intl'

export {
  QWEN_WEB_MODELS,
  getQwenWebCatalog,
  resolveQwenUpstreamModel,
}
export { isValidQwenWebModel } from './qwen-catalog'
export {
  isChatQwenHost,
  isChatQwenProviderKey,
  extractQwenIntlToken,
} from './qwen-intl'

const TONGYI_ORIGIN = 'https://tongyi.aliyun.com'
const QIANWEN_HOST = 'https://qianwen.biz.aliyun.com'
const QIANWEN_CONVERSATION_PATH = '/dialog/conversation'
const QIANWEN_SESSION_LIST = `${QIANWEN_HOST}/dialog/session/list`
const QIANWEN_SESSION_DELETE = `${QIANWEN_HOST}/dialog/session/delete`

const TONGYI_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: TONGYI_ORIGIN,
  Pragma: 'no-cache',
  'Sec-Ch-Ua':
    '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  Referer: `${TONGYI_ORIGIN}/`,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'X-Platform': 'pc_tongyi',
  'X-Xsrf-Token': '48b9ee49-a184-45e2-9f67-fa87213edcdc',
}

const TICKET_HELP =
  'Log in at https://tongyi.aliyun.com/qianwen, then Capture Qwen again. ' +
  'Need cookie tongyi_sso_ticket (or login_aliyunid_ticket) — not chat.qwen.ai JWT.'

export const qwenAdapter: ProviderAdapter = {
  key: 'qwen',
  displayName: 'Qwen (Tongyi)',

  listModels(): AdapterModelSpec[] {
    return getQwenWebCatalog()
  },

  async buildUpstreamRequest(
    req: OpenAIChatRequest,
    session: AdapterSessionContext,
  ): Promise<UpstreamRequestSpec> {
    const ticket = extractTongyiTicket(session)
    const intlOk = hasQwenIntlAuth(session)

    // Prefer Tongyi when a real SSO ticket exists; otherwise chat.qwen.ai v2.
    if (ticket) {
      return buildTongyiUpstream(req, ticket)
    }
    if (intlOk) {
      return buildQwenIntlUpstream(req, session)
    }

    throw new Error(
      `Qwen missing auth. Chinese: ${TICKET_HELP} International: ${INTL_HELP}`,
    )
  },

  async parseUpstreamResponse(
    raw: Response,
    session: AdapterSessionContext,
    model: string,
  ): Promise<ChatCompletionResponse> {
    const text = await raw.text()
    if (!raw.ok) {
      throw new Error(
        `Qwen HTTP ${raw.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`,
      )
    }

    // International phase SSE (OpenAI-shaped with phase) vs Tongyi dialog SSE.
    const intlContent = collectQwenIntlContent(text)
    if (intlContent.trim() && /"phase"\s*:/.test(text)) {
      return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: intlContent },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: Math.max(1, Math.ceil(intlContent.length / 4)),
          total_tokens: Math.max(2, Math.ceil(intlContent.length / 4) + 1),
        },
      }
    }

    const { content, convId, bizError } = collectTongyiContent(text)
    if (bizError) throw new Error(`Qwen tongyi: ${bizError}`)
    if (!content.trim()) {
      if (intlContent.trim()) {
        return {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: intlContent },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: Math.max(1, Math.ceil(intlContent.length / 4)),
            total_tokens: Math.max(2, Math.ceil(intlContent.length / 4) + 1),
          },
        }
      }
      throw new Error(
        `Qwen returned empty content. ${TICKET_HELP} Upstream snippet: ${text.replace(/\s+/g, ' ').slice(0, 220)}`,
      )
    }
    if (convId) {
      const ticket = extractTongyiTicket(session)
      if (ticket) void removeConversation(convId, ticket)
    }

    return {
      id: convId || `chatcmpl-${Date.now()}`,
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
        prompt_tokens: 1,
        completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
        total_tokens: Math.max(2, Math.ceil(content.length / 4) + 1),
      },
    }
  },

  async *transformStream(
    upstreamStream: ReadableStream<Uint8Array>,
    session: AdapterSessionContext,
    model: string,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const id = `chatcmpl-${Date.now()}`
    const created = Math.floor(Date.now() / 1000)
    const reader = upstreamStream.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let assembled = ''
    let convId = ''
    let sentRole = false
    let bizError = ''
    let mode: 'unknown' | 'intl' | 'tongyi' = 'unknown'
    let intlEmitted = false

    const emitOpenAi = function* (
      partial: Partial<ChatMessage> & { reasoning_content?: string },
      finish: string | null = null,
    ): Generator<StreamChunk, void, unknown> {
      const delta: Partial<ChatMessage> & { reasoning_content?: string } = {
        ...partial,
      }
      if (!sentRole) {
        delta.role = 'assistant'
        sentRole = true
      }
      yield {
        id: convId || id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      }
    }

    const emitTongyi = function* (
      delta: TongyiDelta,
    ): Generator<StreamChunk, void, unknown> {
      if (delta.bizError) {
        bizError = delta.bizError
        return
      }
      if (delta.convId) convId = delta.convId

      let chunk = ''
      if (delta.text.length > assembled.length) {
        chunk = delta.text.slice(assembled.length)
        assembled = delta.text
      }
      if (!chunk && !delta.finished) return

      const out: Partial<ChatMessage> = {}
      if (!sentRole) {
        out.role = 'assistant'
        sentRole = true
      }
      if (chunk) out.content = chunk

      yield {
        id: convId || id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: out,
            finish_reason: delta.finished ? 'stop' : null,
          },
        ],
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        if (mode === 'unknown') {
          if (/"phase"\s*:/.test(buf) || /chat\.qwen\.ai/i.test(buf)) {
            mode = 'intl'
          } else if (
            /parentMsgId|msgStatus|contents|sessionId|errorCode/.test(buf)
          ) {
            mode = 'tongyi'
          }
        }

        if (mode === 'intl' || (mode === 'unknown' && /"phase"\s*:/.test(buf))) {
          mode = 'intl'
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            try {
              const piece = parseQwenIntlSseLine(line)
              if (!piece) {
                if (line.trim() === 'data: [DONE]') {
                  yield* emitOpenAi({}, 'stop')
                  return
                }
                continue
              }
              if (piece.kind === 'think') {
                yield* emitOpenAi({ reasoning_content: piece.text })
              } else {
                intlEmitted = true
                yield* emitOpenAi({ content: piece.text })
              }
            } catch (e) {
              if (
                e instanceof Error &&
                e.message.startsWith('Qwen International:')
              ) {
                throw e
              }
            }
          }
          continue
        }

        // Tongyi (default)
        mode = mode === 'unknown' ? 'tongyi' : mode
        const parts = buf.split(/\n\n/)
        buf = parts.pop() ?? ''
        for (const block of parts) {
          const delta = parseTongyiSseBlock(block)
          if (!delta) continue
          yield* emitTongyi(delta)
          if (delta.finished) {
            if (convId) {
              const ticket = extractTongyiTicket(session)
              if (ticket) void removeConversation(convId, ticket)
            }
            return
          }
        }
      }

      if (mode === 'intl') {
        if (buf.trim()) {
          const piece = parseQwenIntlSseLine(buf.trim())
          if (piece?.kind === 'answer') {
            intlEmitted = true
            yield* emitOpenAi({ content: piece.text })
          } else if (piece?.kind === 'think') {
            yield* emitOpenAi({ reasoning_content: piece.text })
          }
        }
        if (!intlEmitted && !sentRole) {
          throw new Error(`Qwen International empty stream. ${INTL_HELP}`)
        }
        yield* emitOpenAi({}, 'stop')
        return
      }

      if (buf.trim()) {
        const delta = parseTongyiSseBlock(buf)
        if (delta) yield* emitTongyi(delta)
      }

      if (bizError) throw new Error(`Qwen tongyi: ${bizError}`)
      if (!assembled.trim()) {
        throw new Error(`Qwen returned empty content. ${TICKET_HELP}`)
      }

      yield {
        id: convId || id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }
      if (convId) {
        const ticket = extractTongyiTicket(session)
        if (ticket) void removeConversation(convId, ticket)
      }
    } finally {
      reader.releaseLock()
    }
  },

  async refresh(session: AdapterSessionContext): Promise<RefreshResult> {
    const v = await qwenAdapter.validate(session)
    if (v.valid) {
      return {
        ok: true,
        accessToken: extractTongyiTicket(session) || session.accessToken,
        refreshToken: session.refreshToken,
        cookies: session.cookies,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        refreshExpiresAt: session.refreshExpiresAt,
      }
    }
    return {
      ok: false,
      error: v.reason || `Qwen tongyi ticket invalid. ${TICKET_HELP}`,
    }
  },

  async ping(session: AdapterSessionContext) {
    const v = await qwenAdapter.validate(session)
    return { ok: v.valid, error: v.reason }
  },

  async cleanupRemoteChat(_session: AdapterSessionContext, remoteChatId: string) {
    // Ticket required — load from nothing here; removeConversation needs ticket.
    // Per-request cleanup already runs inside parse/transform with ticket in scope.
    void remoteChatId
  },

  async clearRemoteChats(
    session: AdapterSessionContext,
    opts = {},
  ): Promise<ClearRemoteChatsResult> {
    const ticket = extractTongyiTicket(session)
    if (!ticket) {
      return { ok: false, deleted: 0, error: `No tongyi ticket. ${TICKET_HELP}` }
    }
    const limit = Math.min(500, Math.max(1, opts.limit ?? 200))
    const ids = await qwenListSessionIds(ticket, limit)
    if (ids.length === 0) {
      return {
        ok: true,
        deleted: 0,
        listed: 0,
        detail: 'No sessions found on Tongyi/Qwen',
      }
    }
    let deleted = 0
    for (const id of ids) {
      await removeConversation(id, ticket)
      deleted += 1
      await new Promise((r) => setTimeout(r, 120))
    }
    return {
      ok: true,
      deleted,
      listed: ids.length,
      detail: `Deleted ${deleted} session(s) on tongyi.aliyun.com`,
    }
  },

  async validate(session: AdapterSessionContext): Promise<SessionValidationResult> {
    const ticket = extractTongyiTicket(session)
    if (!ticket) {
      const token = extractQwenIntlToken(session)
      if (token || session.cookies.length > 0) {
        const models = getQwenWebCatalog()
        return {
          valid: true,
          detectedModels: models.map((m) => m.modelKey),
        }
      }
      return {
        valid: false,
        reason: `No tongyi ticket and no chat.qwen.ai token. Chinese: ${TICKET_HELP} International: ${INTL_HELP}`,
      }
    }

    try {
      const resp = await fetch(QIANWEN_SESSION_LIST, {
        method: 'POST',
        headers: {
          ...TONGYI_HEADERS,
          'Content-Type': 'application/json',
          Cookie: generateTongyiCookie(ticket),
        },
        body: '{}',
        signal: AbortSignal.timeout(15_000),
      })
      const text = await resp.text()
      if (!resp.ok) {
        return {
          valid: false,
          reason: `Qwen tongyi HTTP ${resp.status}: ${text.slice(0, 200)}`,
        }
      }
      let j: { success?: boolean; data?: unknown; errorCode?: string; errorMsg?: string }
      try {
        j = JSON.parse(text)
      } catch {
        return { valid: false, reason: 'Qwen tongyi returned non-JSON' }
      }
      if (j.success === false) {
        return {
          valid: false,
          reason: `Qwen tongyi: ${j.errorCode || ''}-${j.errorMsg || 'auth failed'}. ${TICKET_HELP}`,
        }
      }
      try {
        const { importQwenLiveModels } = await import('./qwen-catalog')
        const live = await importQwenLiveModels()
        if (live.models.length) {
          return {
            valid: true,
            detectedModels: live.models.map((m) => m.modelKey),
          }
        }
      } catch {
        // ticket ok even if live catalog fails
      }
      return { valid: true }
    } catch (e) {
      return { valid: false, reason: (e as Error).message }
    }
  },
}

function buildTongyiUpstream(
  req: OpenAIChatRequest,
  ticket: string,
): UpstreamRequestSpec {
  const model = resolveUpstreamModel(req.model)
  const contents = messagesPrepare(req.messages)
  const body = {
    mode: 'chat',
    model,
    action: 'next',
    userAction: 'chat',
    requestId: crypto.randomUUID().replace(/-/g, ''),
    sessionId: '',
    sessionType: 'text_chat',
    parentMsgId: '',
    params: {
      fileUploadBatchId: crypto.randomUUID().replace(/-/g, ''),
      searchType: '',
    },
    contents,
  }

  return {
    url: `${QIANWEN_HOST}${QIANWEN_CONVERSATION_PATH}`,
    method: 'POST',
    stream: true,
    headers: {
      ...TONGYI_HEADERS,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Cookie: generateTongyiCookie(ticket),
      'x-mirage-qwen-http2': '1',
    },
    body,
  }
}

/**
 * Free-API transport: HTTP/2 to qianwen.biz.aliyun.com/dialog/conversation.
 * Returns a buffered Response (SSE text) for Mirage stream/non-stream paths.
 */
export async function qwenTongyiHttp2(
  body: unknown,
  cookieHeader: string,
): Promise<Response> {
  const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {})

  return new Promise<Response>((resolve, reject) => {
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      try {
        session.close()
      } catch {
        // ignore
      }
      reject(err)
    }

    const session = http2.connect(QIANWEN_HOST)
    session.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))))

    const headers: Record<string, string> = {
      ':method': 'POST',
      ':path': QIANWEN_CONVERSATION_PATH,
      'content-type': 'application/json',
      cookie: cookieHeader,
      accept: 'text/event-stream',
    }
    for (const [k, v] of Object.entries(TONGYI_HEADERS)) {
      if (k.toLowerCase() === 'accept') continue
      headers[k.toLowerCase()] = v
    }

    const req = session.request(headers)
    req.setTimeout(120_000, () => fail(new Error('Qwen tongyi HTTP/2 timeout')))

    const chunks: Buffer[] = []
    let status = 200
    req.on('response', (h) => {
      const s = h[':status']
      if (typeof s === 'number') status = s
    })
    req.on('data', (c: Buffer | string) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    })
    req.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))))
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        session.close()
      } catch {
        // ignore
      }
      const text = Buffer.concat(chunks).toString('utf8')
      resolve(
        new Response(text, {
          status,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        }),
      )
    })
    req.end(payload)
  })
}

/** Prefer real Tongyi cookies; named tickets are valid even if JWT-shaped.
 * Only reject bare accessToken JWTs from chat.qwen.ai. */
export function extractTongyiTicket(session: AdapterSessionContext): string {
  const names = [
    'tongyi_sso_ticket',
    'login_aliyunid_ticket',
    'login_aliyunid_sso',
  ]
  for (const name of names) {
    const v = findCookie(session.cookies, name)?.value?.trim()
    if (v && v.length > 8) return v
  }

  const access = (session.accessToken || '').trim().replace(/^Bearer\s+/i, '')
  if (access && !looksLikeJwt(access)) return access

  // JWT in accessToken = chat.qwen.ai capture — unusable for tongyi dialog API.
  return ''
}

function looksLikeJwt(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 3 && parts.every((p) => p.length > 4)
}

function generateTongyiCookie(ticket: string): string {
  const name = ticket.length > 100 ? 'login_aliyunid_ticket' : 'tongyi_sso_ticket'
  return [
    `${name}=${ticket}`,
    'aliyun_choice=intl',
    '_samesite_flag_=true',
    `t=${crypto.randomUUID().replace(/-/g, '')}`,
  ].join('; ')
}

function resolveUpstreamModel(model: string): string {
  return resolveQwenUpstreamModel(model)
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const p = part as { text?: unknown }
          if (typeof p.text === 'string') return p.text
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return content == null ? '' : String(content)
}

function messagesPrepare(messages: ChatMessage[]): Array<{
  content: string
  contentType: string
  role: string
}> {
  let content: string
  if (messages.length < 2) {
    content = messages
      .map((m) => contentToText(m.content))
      .filter(Boolean)
      .join('\n')
  } else {
    content = messages
      .map((m) => {
        const text = contentToText(m.content)
        return `<|im_start|>${m.role || 'user'}\n${text}<|im_end|>\n`
      })
      .join('')
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
  }
  return [{ content, contentType: 'text', role: 'user' }]
}

type TongyiDelta = {
  text: string
  finished: boolean
  convId: string
  bizError?: string
}

function parseTongyiSseBlock(block: string): TongyiDelta | null {
  const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const dataLine =
    lines.find((l) => l.startsWith('data:')) ||
    (lines[0]?.startsWith('{') ? `data: ${lines[0]}` : '')
  if (!dataLine) return null
  const payload = dataLine.replace(/^data:\s*/, '').trim()
  if (!payload || payload === '[DONE]') return null

  let result: {
    success?: boolean
    errorCode?: string
    errorMsg?: string
    sessionId?: string
    msgId?: string
    msgStatus?: string
    contents?: Array<{ contentType?: string; role?: string; content?: unknown }>
  }
  try {
    result = JSON.parse(payload)
  } catch {
    return null
  }

  if (result.success === false || result.errorCode) {
    return {
      text: '',
      finished: true,
      convId: '',
      bizError: `${result.errorCode || 'error'}-${result.errorMsg || 'request failed'}`,
    }
  }

  const text = (result.contents || []).reduce((str, part) => {
    const { contentType, role, content } = part
    if (contentType !== 'text' && contentType !== 'text2image') return str
    if (role !== 'assistant' && typeof content !== 'string') return str
    return str + (typeof content === 'string' ? content : '')
  }, '')

  const convId =
    result.sessionId && result.msgId
      ? `${result.sessionId}-${result.msgId}`
      : result.sessionId || ''

  return {
    text,
    finished: result.msgStatus === 'finished',
    convId,
  }
}

function collectTongyiContent(raw: string): {
  content: string
  convId: string
  bizError: string
} {
  let content = ''
  let convId = ''
  let bizError = ''

  // Try SSE blocks first
  const blocks = raw.includes('\n\n') ? raw.split(/\n\n/) : raw.split(/\r?\n/)
  for (const block of blocks) {
    const delta = parseTongyiSseBlock(block)
    if (!delta) continue
    if (delta.bizError) bizError = delta.bizError
    if (delta.convId) convId = delta.convId
    if (delta.text.length > content.length) content = delta.text
  }

  // Non-SSE JSON error envelope
  if (!content && !bizError && raw.trim().startsWith('{')) {
    try {
      const j = JSON.parse(raw) as {
        success?: boolean
        errorCode?: string
        errorMsg?: string
      }
      if (j.success === false || j.errorCode) {
        bizError = `${j.errorCode || 'error'}-${j.errorMsg || 'request failed'}`
      }
    } catch {
      // ignore
    }
  }

  return { content, convId, bizError }
}

async function removeConversation(convId: string, ticket: string): Promise<void> {
  const sessionId = convId.includes('-') ? convId.split('-')[0] : convId
  if (!sessionId?.trim()) return
  try {
    await fetch(QIANWEN_SESSION_DELETE, {
      method: 'POST',
      headers: {
        ...TONGYI_HEADERS,
        'Content-Type': 'application/json',
        Cookie: generateTongyiCookie(ticket),
      },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    // cleanup only
  }
}

function collectSessionIds(node: unknown, out: string[], limit: number): void {
  if (out.length >= limit || node == null) return
  if (Array.isArray(node)) {
    for (const item of node) collectSessionIds(item, out, limit)
    return
  }
  if (typeof node !== 'object') return
  const o = node as Record<string, unknown>
  const id =
    (typeof o.sessionId === 'string' && o.sessionId) ||
    (typeof o.session_id === 'string' && o.session_id) ||
    (typeof o.id === 'string' && o.id) ||
    ''
  if (id && id.length > 4 && !out.includes(id)) out.push(id)
  for (const v of Object.values(o)) collectSessionIds(v, out, limit)
}

async function qwenListSessionIds(
  ticket: string,
  limit: number,
): Promise<string[]> {
  const resp = await fetch(QIANWEN_SESSION_LIST, {
    method: 'POST',
    headers: {
      ...TONGYI_HEADERS,
      'Content-Type': 'application/json',
      Cookie: generateTongyiCookie(ticket),
    },
    body: '{}',
    signal: AbortSignal.timeout(20_000),
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw new Error(`Qwen session list HTTP ${resp.status}: ${text.slice(0, 180)}`)
  }
  let j: unknown = {}
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error('Qwen session list returned non-JSON')
  }
  const out: string[] = []
  collectSessionIds(j, out, limit)
  return out
}

registerAdapter(qwenAdapter)
