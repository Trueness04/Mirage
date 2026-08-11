/**
 * HuggingChat Adapter (OmniRoute huggingchat-compatible)
 * --------------------------------------------------------------------
 * Website: https://huggingface.co/chat
 *
 * Auth: hf-chat cookie (NOT router.huggingface.co API tokens).
 * Flow:
 *   1) POST /chat/conversation { model } → conversationId
 *   2) GET  /chat/api/v2/conversations/{id} → rootMessageId
 *   3) POST /chat/conversation/{id} multipart data=JSON → JSONL stream
 */

import {
  type AdapterModelSpec,
  type AdapterSessionContext,
  type ChatCompletionResponse,
  type ChatMessage,
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

const HF = 'https://huggingface.co'
const CONV = `${HF}/chat/conversation`
const CONV_API = `${HF}/chat/api/v2/conversations`
const MODELS_URL = `${HF}/chat/api/v2/models`

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'

/** Short OmniRoute-style fallback when live catalog is unreachable. */
export const HUGGINGCHAT_WEB_MODELS: AdapterModelSpec[] = [
  {
    modelKey: 'deepseek-ai/DeepSeek-V4-Flash',
    displayName: 'DeepSeek V4 Flash',
    upstreamName: 'deepseek-ai/DeepSeek-V4-Flash',
    isDefault: true,
    supportsStream: true,
    contextWindow: 128_000,
  },
  {
    modelKey: 'moonshotai/Kimi-K2.7-Code',
    displayName: 'Kimi K2.7 Code',
    upstreamName: 'moonshotai/Kimi-K2.7-Code',
    supportsStream: true,
    contextWindow: 128_000,
  },
  {
    modelKey: 'google/gemma-4-31B-it',
    displayName: 'Gemma 4 31B',
    upstreamName: 'google/gemma-4-31B-it',
    supportsStream: true,
    contextWindow: 128_000,
  },
  {
    modelKey: 'Qwen/Qwen3.6-27B',
    displayName: 'Qwen3.6 27B',
    upstreamName: 'Qwen/Qwen3.6-27B',
    supportsStream: true,
    contextWindow: 128_000,
  },
]

export function getHuggingChatCatalog(): AdapterModelSpec[] {
  return HUGGINGCHAT_WEB_MODELS.map((m) => ({ ...m }))
}

let cachedModels: AdapterModelSpec[] | null = null

export const huggingchatAdapter: ProviderAdapter = {
  key: 'huggingface',
  displayName: 'HuggingChat',

  listModels(): AdapterModelSpec[] {
    return cachedModels?.length ? cachedModels : getHuggingChatCatalog()
  },

  async buildUpstreamRequest(
    req: OpenAIChatRequest,
    session: AdapterSessionContext,
  ): Promise<UpstreamRequestSpec> {
    const cookie = huggingChatCookieHeader(session)
    if (!cookie) {
      throw new Error(
        'HuggingChat needs hf-chat cookie. Open https://huggingface.co/chat while logged in with Mirage extension, then Capture.',
      )
    }

    const model = resolveModel(req.model)
    const { inputs, systemPrompt } = buildPrompt(req.messages)
    if (!inputs.trim()) {
      throw new Error('HuggingChat: empty prompt after processing messages')
    }

    const headers: Record<string, string> = {
      Cookie: cookie,
      'User-Agent': UA,
      Origin: HF,
      Referer: `${HF}/chat/`,
      Accept: 'application/json',
    }

    const createBody: Record<string, unknown> = { model }
    if (systemPrompt) createBody.preprompt = systemPrompt

    const createResp = await fetch(CONV, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody),
      signal: AbortSignal.timeout(30_000),
    })
    if (!createResp.ok) {
      const text = await createResp.text().catch(() => '')
      if (createResp.status === 401 || createResp.status === 403) {
        throw new Error(
          `HuggingChat auth failed (HTTP ${createResp.status}) — re-capture hf-chat cookie from huggingface.co/chat`,
        )
      }
      throw new Error(
        `HuggingChat create conversation HTTP ${createResp.status}: ${text.slice(0, 200)}`,
      )
    }

    const createJson = (await createResp.json()) as {
      conversationId?: string
    }
    const conversationId = createJson.conversationId
    if (!conversationId) {
      throw new Error('HuggingChat did not return conversationId')
    }

    // Merge Set-Cookie into jar for follow-up requests
    const setCookies = createResp.headers.getSetCookie?.() ?? []
    headers.Cookie = mergeSetCookie(headers.Cookie, setCookies)

    const parentId = await fetchParentMessageId(conversationId, headers)
    if (!parentId) {
      throw new Error('HuggingChat did not return rootMessageId')
    }

    const sendData = {
      inputs,
      is_retry: false,
      is_continue: false,
      generationId: crypto.randomUUID(),
      selectedMcpServerNames: [] as string[],
      selectedMcpServers: [] as string[],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      id: parentId,
    }

    return {
      url: `${CONV}/${conversationId}`,
      method: 'POST',
      stream: true,
      headers: {
        Cookie: headers.Cookie,
        'User-Agent': UA,
        Origin: HF,
        Referer: `${HF}/chat/`,
        Accept: '*/*',
      },
      body: {},
      multipart: {
        data: JSON.stringify(sendData),
      },
    }
  },

  async parseUpstreamResponse(
    raw: Response,
    _session: AdapterSessionContext,
    model: string,
  ): Promise<ChatCompletionResponse> {
    if (!raw.ok) {
      const text = await raw.text().catch(() => '')
      throw new Error(
        `HuggingChat upstream HTTP ${raw.status}: ${text.slice(0, 220)}`,
      )
    }
    const text = await raw.text()
    const content = collectJsonlText(text)
    if (!content) {
      throw new Error(
        `HuggingChat returned empty content: ${text.replace(/\s+/g, ' ').trim().slice(0, 220)}`,
      )
    }
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
        total_tokens: Math.max(1, Math.ceil(content.length / 4)),
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
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const parsed = parseJsonlLine(line.trim())
          if (parsed.error) {
            throw new Error(`HuggingChat: ${parsed.error}`)
          }
          if (parsed.token) {
            const delta: Partial<ChatMessage> = {}
            if (!sentRole) {
              delta.role = 'assistant'
              sentRole = true
            }
            delta.content = parsed.token
            yield {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta, finish_reason: null }],
            }
          }
          if (parsed.done) {
            yield {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            }
            return
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
    const cookie = huggingChatCookieHeader(session)
    if (!cookie) {
      return { ok: false, error: 'No hf-chat cookie' }
    }
    try {
      const resp = await fetch(`${HF}/chat/api/v2/models`, {
        headers: {
          Cookie: cookie,
          'User-Agent': UA,
          Accept: 'application/json',
          Referer: `${HF}/chat/`,
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (resp.status === 401 || resp.status === 403) {
        return { ok: false, error: `HuggingChat session expired (HTTP ${resp.status})` }
      }
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
      return {
        ok: true,
        cookies: session.cookies,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },

  async ping(session: AdapterSessionContext) {
    const r = await huggingchatAdapter.refresh(session)
    return { ok: r.ok, error: r.error }
  },

  async validate(session: AdapterSessionContext): Promise<SessionValidationResult> {
    const cookie = huggingChatCookieHeader(session)
    if (!cookie) {
      return {
        valid: false,
        reason:
          'No hf-chat cookie — open huggingface.co/chat logged in and Capture (not router API tokens)',
      }
    }
    try {
      const models = await importHuggingChatModels(cookie)
      if (models.length) {
        cachedModels = models
        return {
          valid: true,
          detectedModels: models.map((m) => m.modelKey),
        }
      }
      const catalog = getHuggingChatCatalog()
      cachedModels = catalog
      return {
        valid: true,
        detectedModels: catalog.map((m) => m.modelKey),
        reason: 'Using OmniRoute huggingchat catalog (live models empty)',
      }
    } catch (e) {
      return { valid: false, reason: (e as Error).message }
    }
  },
}

export async function importHuggingChatModels(
  cookieHeaderValue: string,
): Promise<AdapterModelSpec[]> {
  const resp = await fetch(MODELS_URL, {
    headers: {
      Cookie: cookieHeaderValue,
      'User-Agent': UA,
      Accept: 'application/json',
      Referer: `${HF}/chat/`,
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) return []
  const text = await resp.text()
  if (!text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) {
    return []
  }
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(j)
    ? j
    : Array.isArray((j as { models?: unknown }).models)
      ? (j as { models: unknown[] }).models
      : Array.isArray((j as { json?: unknown[] }).json)
        ? (j as { json: unknown[] }).json
        : []

  const models: AdapterModelSpec[] = []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const o = row as Record<string, unknown>
    const id = String(o.id || o.name || o.model || '').trim()
    if (!id || id.includes(' ')) continue
    models.push({
      modelKey: id,
      displayName: String(o.displayName || o.name || id),
      upstreamName: id,
      supportsStream: true,
      contextWindow: 128_000,
      isDefault: models.length === 0,
    })
  }
  return models.slice(0, 80)
}

function huggingChatCookieHeader(session: AdapterSessionContext): string {
  const hfChat =
    findCookie(session.cookies, 'hf-chat')?.value ||
    // Extension sometimes stores cookie value as accessToken
    (session.accessToken && !session.accessToken.startsWith('hf_')
      ? session.accessToken
      : '')
  if (hfChat && !cookieHeader(session.cookies).includes('hf-chat=')) {
    return `hf-chat=${hfChat}`
  }
  const full = cookieHeader(session.cookies)
  if (/hf-chat=/i.test(full)) return full
  if (hfChat) return `hf-chat=${hfChat}`
  return ''
}

function resolveModel(model: string): string {
  const raw = String(model || '')
    .replace(/^(huggingface|huggingchat|hf)\//i, '')
    .trim()
  return raw || HUGGINGCHAT_WEB_MODELS[0].modelKey
}

function buildPrompt(messages: ChatMessage[]): {
  inputs: string
  systemPrompt: string | null
} {
  const systemParts: string[] = []
  const turns: Array<{ role: string; content: string }> = []
  for (const m of messages) {
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => (p as { text?: string }).text || '').join('\n')
          : ''
    if (!text.trim()) continue
    if (m.role === 'system') systemParts.push(text)
    else if (m.role === 'user' || m.role === 'assistant') {
      turns.push({ role: m.role, content: text })
    }
  }
  if (turns.length === 0) {
    return { inputs: systemParts.join('\n\n'), systemPrompt: null }
  }
  if (turns.length === 1 && turns[0].role === 'user') {
    return {
      inputs: turns[0].content,
      systemPrompt: systemParts.length ? systemParts.join('\n\n') : null,
    }
  }
  const lines = turns.map(
    (t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`,
  )
  lines.push('Assistant:')
  return {
    inputs: lines.join('\n\n'),
    systemPrompt: systemParts.length ? systemParts.join('\n\n') : null,
  }
}

async function fetchParentMessageId(
  conversationId: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const resp = await fetch(`${CONV_API}/${conversationId}`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  })
  if (!resp.ok) return null
  const j = (await resp.json().catch(() => null)) as Record<string, unknown> | null
  if (!j) return null
  const payload =
    j.json && typeof j.json === 'object'
      ? (j.json as Record<string, unknown>)
      : j
  if (typeof payload.rootMessageId === 'string' && payload.rootMessageId) {
    return payload.rootMessageId
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const last = messages[messages.length - 1] as { id?: string } | undefined
  return last?.id || null
}

function mergeSetCookie(existing: string, setCookies: string[]): string {
  const map = new Map<string, string>()
  for (const part of existing.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  for (const sc of setCookies) {
    const pair = sc.split(';')[0] || ''
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function parseJsonlLine(line: string): {
  token?: string
  done?: boolean
  error?: string
} {
  if (!line) return {}
  try {
    const event = JSON.parse(line) as Record<string, unknown>
    if (event.type === 'stream' && typeof event.token === 'string') {
      const token = event.token.replace(/\0/g, '')
      if (token) return { token }
    }
    if (event.type === 'finalAnswer') return { done: true }
    if (event.type === 'status') {
      if (event.status === 'error') {
        return { error: String(event.message || 'generation error') }
      }
      if (event.status === 'finished') return { done: true }
    }
  } catch {
    // skip
  }
  return {}
}

function collectJsonlText(raw: string): string {
  let content = ''
  let finalText = ''
  for (const line of raw.split('\n')) {
    const parsed = parseJsonlLine(line.trim())
    if (parsed.error) throw new Error(parsed.error)
    if (parsed.token) content += parsed.token
    try {
      const j = JSON.parse(line.trim()) as { type?: string; text?: string }
      if (j.type === 'finalAnswer' && typeof j.text === 'string') {
        finalText = j.text.replace(/\0/g, '')
      }
    } catch {
      // skip
    }
  }
  return finalText || content
}

registerAdapter(huggingchatAdapter)
