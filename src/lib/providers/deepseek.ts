/**
 * DeepSeek Web Adapter (OmniRoute / ds-web compatible)
 * --------------------------------------------------------------------
 * Website: https://chat.deepseek.com
 *
 * Auth (same as OmniRoute deepseek-web):
 *   localStorage userToken → GET /api/v0/users/current → short-lived Bearer
 * Models: static OpenAI-style ids (deepseek-v4-*, deepseek-chat, deepseek-reasoner…)
 *   mapped to model_type + thinking_enabled + search_enabled by name.
 * Chat: POST /api/v0/chat/completion (SSE) + PoW
 */

import { db } from '@/lib/db'
import {
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
  findCookie,
  registerAdapter,
} from './base'
import { syncImportedModelsToDb } from './model-import'

import { solvePowChallenge, type PowChallenge } from './deepseek-pow'
import {
  clearStickyRemoteChat,
  getStickyRemoteChat,
  isProbeChatRequest,
  setStickyRemoteChat,
} from './remote-chat-sticky'

const DS = 'https://chat.deepseek.com'
const DS_CHAT = `${DS}/api/v0/chat/completion`
const DS_USER = `${DS}/api/v0/users/current`
const DS_CREATE_SESSION = `${DS}/api/v0/chat_session/create`
const DS_POW = `${DS}/api/v0/chat/create_pow_challenge`
const DS_DELETE_SESSION = `${DS}/api/v0/chat_session/delete`
const DS_DELETE_ALL = `${DS}/api/v0/chat_session/delete_all`
const DS_FETCH_PAGE = `${DS}/api/v0/chat_session/fetch_page`

/** OmniRoute deepseek-web FAKE_HEADERS (client v2.0.0) — stale X-App-Version is a bot signal. */
const DS_WEB_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: DS,
  Referer: `${DS}/`,
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'X-Client-Bundle-Id': 'com.deepseek.chat',
  'X-Client-Locale': 'en-US',
  'X-Client-Platform': 'web',
  'X-Client-Version': '2.0.0',
}

/**
 * Static catalog — same ids as OmniRoute `open-sse/config/providers/registry/deepseek/web`.
 * Names are flags for resolveModelOptions (pro/expert/think/search), not Instant/Expert labels.
 */
const DEEPSEEK_WEB_MODELS: AdapterModelSpec[] = [
  { modelKey: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', upstreamName: 'expert', isDefault: false, supportsStream: true, contextWindow: 128_000 },
  { modelKey: 'deepseek-v4-pro-think', displayName: 'DeepSeek V4 Pro Think', upstreamName: 'expert', isDefault: false, supportsStream: true, contextWindow: 128_000 },
  { modelKey: 'deepseek-v4-pro-search', displayName: 'DeepSeek V4 Pro Search', upstreamName: 'expert', isDefault: false, supportsStream: true, contextWindow: 128_000 },
  { modelKey: 'deepseek-v4-pro-think-search', displayName: 'DeepSeek V4 Pro Think+Search', upstreamName: 'expert', isDefault: false, supportsStream: true, contextWindow: 128_000 },
  { modelKey: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', upstreamName: 'default', isDefault: false, supportsStream: true, contextWindow: 128_000 },
  { modelKey: 'deepseek-v4-flash-think', displayName: 'DeepSeek V4 Flash Think', upstreamName: 'default', isDefault: false, supportsStream: true, contextWindow: 128_000 },
  { modelKey: 'deepseek-v4-flash-search', displayName: 'DeepSeek V4 Flash Search', upstreamName: 'default', isDefault: false, supportsStream: true, contextWindow: 128_000 },
  { modelKey: 'deepseek-v4-flash-think-search', displayName: 'DeepSeek V4 Flash Think+Search', upstreamName: 'default', isDefault: false, supportsStream: true, contextWindow: 128_000 },
  { modelKey: 'deepseek-chat', displayName: 'DeepSeek Chat', upstreamName: 'default', isDefault: true, supportsStream: true, contextWindow: 128_000 },
  { modelKey: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner', upstreamName: 'default', isDefault: false, supportsStream: true, contextWindow: 128_000 },
  { modelKey: 'DeepSeek-R1', displayName: 'DeepSeek R1', upstreamName: 'default', isDefault: false, supportsStream: true, contextWindow: 128_000 },
  { modelKey: 'DeepSeek-R1-Search', displayName: 'DeepSeek R1 Search', upstreamName: 'default', isDefault: false, supportsStream: true, contextWindow: 128_000 },
  { modelKey: 'DeepSeek-V3.2', displayName: 'DeepSeek V3.2', upstreamName: 'default', isDefault: false, supportsStream: true, contextWindow: 128_000 },
  { modelKey: 'DeepSeek-Search', displayName: 'DeepSeek Search', upstreamName: 'default', isDefault: false, supportsStream: true, contextWindow: 128_000 },
]

let cachedModels: AdapterModelSpec[] | null = DEEPSEEK_WEB_MODELS

/** userToken → short-lived access token from /users/current */
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>()

export const deepseekAdapter: ProviderAdapter = {
  key: 'deepseek',
  displayName: 'DeepSeek Web',

  listModels(): AdapterModelSpec[] {
    return cachedModels ?? DEEPSEEK_WEB_MODELS
  },

  async buildUpstreamRequest(
    req: OpenAIChatRequest,
    session: AdapterSessionContext,
  ): Promise<UpstreamRequestSpec> {
    const userToken = deepseekUserToken(session)
    if (!userToken) {
      throw new Error(
        'DeepSeek: missing userToken. Paste localStorage userToken from chat.deepseek.com (same as OmniRoute ds-web).',
      )
    }

    // OmniRoute: userToken → /users/current → access Bearer for create/pow/completion
    const accessToken = await acquireDeepSeekAccessToken(userToken)
    // OmniRoute sends a synthetic cookie line (not the browser jar) on create/chat.
    const authHeaders = {
      ...DS_WEB_HEADERS,
      Authorization: `Bearer ${accessToken}`,
      Cookie: generateFakeCookie(),
    }

    const ephemeral = isProbeChatRequest(req.messages)
    let sessionId = ephemeral
      ? ''
      : getStickyRemoteChat('deepseek', session.id) || ''
    if (!sessionId) {
      sessionId = await createDeepSeekChatSession(accessToken)
      if (!ephemeral) setStickyRemoteChat('deepseek', session.id, sessionId)
    }
    const powHeader = await createDeepSeekPowHeader(accessToken)
    if (!powHeader) {
      throw new Error(
        'DeepSeek PoW failed (X-Ds-Pow-Response). Retry — Keccak solver could not find a nonce.',
      )
    }

    const modelId = String(req.model || '')
      .replace(/^(deepseek|ds-web|deepseek-web)\//i, '')
      .trim()
    const { modelType, thinkingEnabled, searchEnabled } =
      resolveModelOptions(modelId)

    // Web API is a single `prompt` string (not messages[]). Prefer system +
    // recent turns so playground multi-turn isn't amnesic.
    const prompt = messagesToDeepSeekPrompt(req.messages)

    const body = {
      chat_session_id: sessionId,
      parent_message_id: null as null,
      prompt,
      ref_file_ids: [] as string[],
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled,
      model_type: modelType,
      preempt: false,
    }

    return {
      url: DS_CHAT,
      method: 'POST',
      stream: true,
      headers: {
        ...authHeaders,
        Accept: 'text/event-stream, application/json',
        'Content-Type': 'application/json',
        'X-Client-Timezone-Offset': String(new Date().getTimezoneOffset() * -60),
        'X-Ds-Pow-Response': powHeader,
      },
      body,
      remoteChatId: sessionId,
      ...(ephemeral ? { ephemeralRemoteChat: true } : {}),
    }
  },

  async cleanupRemoteChat(session: AdapterSessionContext, remoteChatId: string) {
    clearStickyRemoteChat('deepseek', session.id)
    const userToken = deepseekUserToken(session)
    if (!userToken || !remoteChatId) return
    try {
      const accessToken = await acquireDeepSeekAccessToken(userToken)
      await fetch(DS_DELETE_SESSION, {
        method: 'POST',
        headers: {
          ...DS_WEB_HEADERS,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Cookie: generateFakeCookie(),
        },
        body: JSON.stringify({ chat_session_id: remoteChatId }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      // cleanup only
    }
  },

  async clearRemoteChats(
    session: AdapterSessionContext,
    opts = {},
  ): Promise<ClearRemoteChatsResult> {
    const userToken = deepseekUserToken(session)
    if (!userToken) {
      return {
        ok: false,
        deleted: 0,
        error: 'No userToken — connect DeepSeek first',
      }
    }
    const accessToken = await acquireDeepSeekAccessToken(userToken)
    const headers = {
      ...DS_WEB_HEADERS,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Cookie: generateFakeCookie(),
    }

    // Prefer bulk delete_all when available.
    try {
      const all = await fetch(DS_DELETE_ALL, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(30_000),
      })
      if (all.ok) {
        return {
          ok: true,
          deleted: -1,
          detail: 'Requested delete_all on chat.deepseek.com',
        }
      }
    } catch {
      // fall through to page delete
    }

    const limit = Math.min(500, Math.max(1, opts.limit ?? 200))
    const ids: string[] = []
    let cursor: { pinned?: number; updated_at?: number } | null = null
    for (let page = 0; page < 40 && ids.length < limit; page++) {
      let url = `${DS_FETCH_PAGE}?count=50`
      if (cursor) {
        url += `&lte_cursor.pinned=${cursor.pinned ? 'true' : 'false'}&lte_cursor.updated_at=${cursor.updated_at}`
      }
      const resp = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(20_000),
      })
      if (!resp.ok) {
        throw new Error(`DeepSeek list sessions HTTP ${resp.status}`)
      }
      const j = (await resp.json()) as {
        data?: { biz_data?: { chat_sessions?: Array<{ id?: string; pinned?: boolean; updated_at?: number }>; has_more?: boolean } }
      }
      const list = j.data?.biz_data?.chat_sessions || []
      for (const s of list) {
        if (s?.id) ids.push(String(s.id))
      }
      if (!j.data?.biz_data?.has_more || list.length === 0) break
      const last = list[list.length - 1]
      cursor = {
        pinned: last.pinned ? 1 : 0,
        updated_at: last.updated_at,
      }
    }

    let deleted = 0
    for (const id of ids.slice(0, limit)) {
      const r = await fetch(DS_DELETE_SESSION, {
        method: 'POST',
        headers,
        body: JSON.stringify({ chat_session_id: id }),
        signal: AbortSignal.timeout(15_000),
      })
      if (r.ok) deleted += 1
      await new Promise((res) => setTimeout(res, 100))
    }
    return {
      ok: true,
      deleted,
      listed: ids.length,
      detail: `Deleted ${deleted} session(s) on chat.deepseek.com`,
    }
  },

  async parseUpstreamResponse(
    raw: Response,
    _session: AdapterSessionContext,
    model: string,
  ): Promise<ChatCompletionResponse> {
    const text = await raw.text()
    const bizErr = deepseekBizError(raw.status, text)
    if (bizErr) throw new Error(bizErr)
    if (!raw.ok) {
      throw new Error(`DeepSeek upstream error ${raw.status}: ${text.slice(0, 200)}`)
    }
    const content = extractDeepSeekContent(text)
    if (!content.trim()) {
      throw new Error(
        `DeepSeek upstream HTTP ${raw.status}: empty content — ${text.slice(0, 300) || '(empty body)'}`,
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
        prompt_tokens: Math.max(1, Math.round(text.length / 8)),
        completion_tokens: Math.max(1, Math.round(content.length / 4)),
        total_tokens: Math.max(1, Math.round(text.length / 4)),
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
    let emittedContent = false
    const state: DeepSeekSseState = { path: '' }

    const emitDelta = function* (
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
      if (delta.content) emittedContent = true
      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        const bizErr = deepseekBizError(200, buf)
        if (
          bizErr &&
          !buf.includes('\ndata:') &&
          !buf.trimStart().startsWith('data:')
        ) {
          throw new Error(bizErr)
        }

        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data || data === '[DONE]') {
            yield* emitDelta({}, 'stop')
            return
          }
          try {
            const j = JSON.parse(data) as Record<string, unknown>
            const lineBiz = deepseekBizError(200, data)
            if (lineBiz) throw new Error(lineBiz)

            const pieces = consumeDeepSeekSseEvent(j, state)
            for (const piece of pieces) {
              if (piece.finish) {
                yield* emitDelta({}, 'stop')
                return
              }
              if (piece.reasoning) {
                yield* emitDelta({ reasoning_content: piece.reasoning })
              }
              if (piece.text) {
                yield* emitDelta({ content: piece.text })
              }
            }
          } catch (e) {
            if (
              e instanceof Error &&
              e.message.startsWith('DeepSeek upstream')
            ) {
              throw e
            }
            // skip malformed
          }
        }
      }

      const tailBiz = deepseekBizError(200, buf)
      if (tailBiz) throw new Error(tailBiz)
      if (!emittedContent) {
        // Final leftover line without trailing newline
        if (buf.trim().startsWith('data:')) {
          try {
            const j = JSON.parse(buf.trim().slice(5).trim()) as Record<
              string,
              unknown
            >
            for (const piece of consumeDeepSeekSseEvent(j, state)) {
              if (piece.reasoning) {
                yield* emitDelta({ reasoning_content: piece.reasoning })
              }
              if (piece.text) yield* emitDelta({ content: piece.text })
            }
          } catch {
            // ignore
          }
        }
      }
      if (!emittedContent) {
        throw new Error(
          `DeepSeek upstream HTTP 200: empty stream — ${buf.trim().slice(0, 300) || '(no content frames)'}`,
        )
      }

      yield* emitDelta({}, 'stop')
    } finally {
      reader.releaseLock()
    }
  },

  async refresh(session: AdapterSessionContext): Promise<RefreshResult> {
    try {
      const userToken = deepseekUserToken(session)
      if (!userToken) {
        return { ok: false, error: 'No userToken captured' }
      }
      accessTokenCache.delete(userToken)
      await acquireDeepSeekAccessToken(userToken)
      return {
        ok: true,
        // Keep storing the long-lived userToken; short-lived access is cached in-process.
        accessToken: userToken,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },

  async ping(session: AdapterSessionContext) {
    const r = await deepseekAdapter.refresh(session)
    return { ok: r.ok, error: r.error }
  },

  async validate(session: AdapterSessionContext): Promise<SessionValidationResult> {
    const userToken = deepseekUserToken(session)
    if (!userToken) {
      return {
        valid: false,
        reason:
          'No userToken captured. Open chat.deepseek.com → DevTools → Application → Local Storage → userToken (OmniRoute ds-web).',
      }
    }
    try {
      await acquireDeepSeekAccessToken(userToken)
      const models = getDeepSeekWebCatalog()
      cachedModels = models
      const provider = await db.provider.findUnique({ where: { key: 'deepseek' } })
      if (provider) {
        await syncImportedModelsToDb(
          provider.id,
          models.map((m) => ({
            modelKey: m.modelKey,
            displayName: m.displayName,
            upstreamName: m.upstreamName || m.modelKey,
            contextWindow: m.contextWindow,
            isDefault: m.isDefault,
          })),
        )
      }
      return {
        valid: true,
        detectedModels: models.map((m) => m.modelKey),
      }
    } catch (e) {
      return { valid: false, reason: (e as Error).message }
    }
  },
}

/** Public helper for Import — OmniRoute-style static catalog (not Instant/Expert scrape). */
export async function importDeepSeekLiveModels(
  session: AdapterSessionContext,
): Promise<AdapterModelSpec[]> {
  const userToken = deepseekUserToken(session)
  if (!userToken) return []
  await acquireDeepSeekAccessToken(userToken)
  return getDeepSeekWebCatalog()
}

export function getDeepSeekWebCatalog(): AdapterModelSpec[] {
  return DEEPSEEK_WEB_MODELS.map((m) => ({ ...m }))
}

/**
 * OmniRoute resolveModelOptions — model id string drives flags:
 *   pro|expert → model_type expert (V4 Pro / Instant Expert)
 *   r1|think|reason → thinking_enabled
 *   search → search_enabled
 */
function resolveModelOptions(model?: string): {
  modelType: string
  thinkingEnabled: boolean
  searchEnabled: boolean
} {
  const m = (model || '').toLowerCase()
  const modelType = m.includes('pro') || m.includes('expert') ? 'expert' : 'default'
  const thinkingEnabled =
    m.includes('r1') || m.includes('think') || m.includes('reason')
  const searchEnabled = m.includes('search')
  return { modelType, thinkingEnabled, searchEnabled }
}

async function acquireDeepSeekAccessToken(userToken: string): Promise<string> {
  const cached = accessTokenCache.get(userToken)
  const now = Math.floor(Date.now() / 1000)
  if (cached && cached.expiresAt > now + 30) return cached.token

  const resp = await fetch(DS_USER, {
    headers: {
      Authorization: `Bearer ${userToken}`,
      ...DS_WEB_HEADERS,
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (resp.status === 401 || resp.status === 403) {
    accessTokenCache.delete(userToken)
    throw new Error(
      'DeepSeek userToken invalid/expired — get a fresh userToken from chat.deepseek.com localStorage',
    )
  }
  if (!resp.ok) {
    throw new Error(`DeepSeek /users/current HTTP ${resp.status}`)
  }
  const json = (await resp.json()) as {
    code?: number
    msg?: string
    data?: { biz_code?: number; biz_msg?: string; biz_data?: { token?: string } }
  }
  if (typeof json.code === 'number' && json.code !== 0) {
    accessTokenCache.delete(userToken)
    throw new Error(
      `DeepSeek rejected userToken: ${json.msg || json.data?.biz_msg || `code ${json.code}`}`,
    )
  }
  const access =
    json.data?.biz_data?.token ||
    (json as { biz_data?: { token?: string } }).biz_data?.token
  if (!access || typeof access !== 'string') {
    throw new Error('DeepSeek /users/current returned no access token (biz_data.token)')
  }
  accessTokenCache.set(userToken, {
    token: access,
    expiresAt: now + 3600,
  })
  return access
}

function unwrapLocalStorageToken(raw: string | undefined | null): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  // Extension often captures localStorage JSON: {"value":"...","__version":"0"}
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as { value?: unknown }
      if (typeof j.value === 'string' && j.value.trim()) {
        return j.value.trim()
      }
    } catch {
      // fall through
    }
  }
  return trimmed.replace(/^Bearer\s+/i, '')
}

function deepseekUserToken(session: AdapterSessionContext): string {
  return (
    unwrapLocalStorageToken(findCookie(session.cookies, 'userToken')?.value) ||
    unwrapLocalStorageToken(session.accessToken) ||
    unwrapLocalStorageToken(findCookie(session.cookies, 'token')?.value) ||
    ''
  )
}

function generateFakeCookie(): string {
  const ts = Date.now()
  const hex = (n: number) =>
    Array.from({ length: n }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('')
  const uid = () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    })
  return `intercom-HWWAFSESTIME=${ts}; HWWAFSESID=${hex(18)}; Hm_lvt_${uid()}=${Math.floor(ts / 1000)}; _frid=${uid()}`
}

async function createDeepSeekChatSession(accessToken: string): Promise<string> {
  const resp = await fetch(DS_CREATE_SESSION, {
    method: 'POST',
    headers: {
      ...DS_WEB_HEADERS,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Cookie: generateFakeCookie(),
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await resp.text()
  let j: Record<string, unknown> = {}
  try {
    j = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(
      `DeepSeek chat_session/create HTTP ${resp.status}: ${text.slice(0, 180)}`,
    )
  }
  if (!resp.ok) {
    throw new Error(
      `DeepSeek chat_session/create HTTP ${resp.status}: ${text.slice(0, 180)}`,
    )
  }
  const data = j.data as Record<string, unknown> | undefined
  const biz = (data?.biz_data || j.biz_data) as Record<string, unknown> | undefined
  const chatSession = biz?.chat_session as { id?: string } | undefined
  const id =
    chatSession?.id ||
    (typeof biz?.id === 'string' ? biz.id : null) ||
    (typeof biz?.chat_session_id === 'string' ? biz.chat_session_id : null)
  if (!id) {
    throw new Error(
      `DeepSeek chat_session/create returned no id: ${JSON.stringify({ code: j.code, msg: j.msg }).slice(0, 220)}`,
    )
  }
  return String(id)
}

async function createDeepSeekPowHeader(
  accessToken: string,
): Promise<string | null> {
  const powResp = await fetch(DS_POW, {
    method: 'POST',
    headers: {
      ...DS_WEB_HEADERS,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Cookie: generateFakeCookie(),
    },
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!powResp.ok) {
    throw new Error(`DeepSeek create_pow_challenge HTTP ${powResp.status}`)
  }
  const j = (await powResp.json()) as {
    data?: { biz_data?: { challenge?: PowChallenge } }
    biz_data?: { challenge?: PowChallenge }
    challenge?: PowChallenge
  }
  const challenge = (j?.data?.biz_data?.challenge ||
    j?.biz_data?.challenge ||
    j?.challenge) as PowChallenge | undefined
  if (!challenge?.salt || !challenge?.challenge) {
    throw new Error('DeepSeek create_pow_challenge returned no challenge')
  }
  return solvePowChallenge({
    ...challenge,
    target_path: challenge.target_path || '/api/v0/chat/completion',
  })
}

function messageText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p
        if (p && typeof p === 'object' && 'text' in p) {
          return String((p as { text?: string }).text || '')
        }
        return ''
      })
      .join('\n')
  }
  return ''
}

/**
 * DeepSeek web takes one `prompt` string. Keep system + a short transcript so
 * playground multi-turn still has context (OmniRoute historyWindow style).
 */
function messagesToDeepSeekPrompt(
  messages: ChatMessage[],
  historyWindow = 8,
): string {
  const systemParts: string[] = []
  const turns: Array<{ role: string; text: string }> = []
  for (const m of messages) {
    const text = messageText(m.content).trim()
    if (!text) continue
    if (m.role === 'system') systemParts.push(text)
    else if (m.role === 'user' || m.role === 'assistant') {
      turns.push({ role: m.role, text })
    }
  }
  const parts: string[] = []
  if (systemParts.length) parts.push(systemParts.join('\n\n'))
  if (turns.length <= 1) {
    const last = turns[turns.length - 1]
    if (last) parts.push(last.text)
  } else {
    const recent = turns.slice(-historyWindow)
    parts.push(
      recent
        .map((t) =>
          t.role === 'assistant' ? `Assistant: ${t.text}` : `User: ${t.text}`,
        )
        .join('\n\n'),
    )
  }
  return parts.join('\n\n').trim()
}

type DeepSeekSseState = { path: 'thinking' | 'content' | '' }
type DeepSeekSsePiece = {
  text?: string
  reasoning?: string
  finish?: boolean
}

function isTitlePath(p: string): boolean {
  return /(^|\/)title$/i.test(p)
}

function applyFragment(
  frag: Record<string, unknown>,
  state: DeepSeekSseState,
  setPathFromType: boolean,
): DeepSeekSsePiece[] {
  const type = String(frag?.type || '').toUpperCase()
  // Auto chat titles look like Persian "پاسخ به سلام" — never treat as reply.
  if (type === 'TITLE' || type === 'TEMPLATE' || type === 'HINT') return []
  if (setPathFromType || type) {
    if (type === 'THINK') state.path = 'thinking'
    else if (type === 'ANSWER' || type === 'RESPONSE') state.path = 'content'
  }
  const content = typeof frag?.content === 'string' ? frag.content : ''
  if (!content) return []
  if (state.path === 'thinking' || type === 'THINK') {
    return [{ reasoning: content }]
  }
  // Unknown fragment types without an established content path are skipped
  // (avoids leaking title-like stubs).
  if (state.path === 'content' || type === 'ANSWER' || type === 'RESPONSE') {
    return [{ text: content }]
  }
  return []
}

/**
 * Parse one DeepSeek web SSE JSON frame (path/op/value patches + fragments).
 * Ignores title/status noise so auto titles never become the assistant reply.
 */
function consumeDeepSeekSseEvent(
  data: Record<string, unknown>,
  state: DeepSeekSseState,
): DeepSeekSsePiece[] {
  const out: DeepSeekSsePiece[] = []
  const p = typeof data.p === 'string' ? data.p : ''
  const o = typeof data.o === 'string' ? data.o : ''
  const v = data.v

  if (isTitlePath(p)) return out

  // OpenAI-shaped frames (rare / proxied)
  const openai =
    (data as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string }> })
      .choices?.[0]
  if (openai?.delta?.content) out.push({ text: String(openai.delta.content) })
  if (openai?.finish_reason === 'stop') out.push({ finish: true })
  if (typeof data.content === 'string' && data.content && !p) {
    out.push({ text: data.content })
  }

  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const resp = (v as { response?: Record<string, unknown> }).response
    if (resp && typeof resp === 'object') {
      if (resp.thinking_enabled === true) state.path = 'thinking'
      else if (resp.thinking_enabled === false) state.path = 'content'
      const fragments = resp.fragments
      if (Array.isArray(fragments)) {
        for (const frag of fragments) {
          if (frag && typeof frag === 'object') {
            out.push(
              ...applyFragment(frag as Record<string, unknown>, state, false),
            )
          }
        }
      }
    }
  }

  if (p === 'response/fragments') {
    if (Array.isArray(v)) {
      for (const frag of v) {
        if (frag && typeof frag === 'object') {
          out.push(
            ...applyFragment(frag as Record<string, unknown>, state, true),
          )
        }
      }
    } else if (v && typeof v === 'object') {
      out.push(...applyFragment(v as Record<string, unknown>, state, true))
    }
  }

  if (typeof v === 'string' && v.length > 0) {
    if (/thinking_content$/i.test(p)) {
      state.path = 'thinking'
      out.push({ reasoning: v })
    } else if (/\/content$/i.test(p) || p === 'response/content') {
      state.path = 'content'
      out.push({ text: v })
    } else if (!p && state.path) {
      // Bare token continuation after a content/thinking path was established.
      if (state.path === 'thinking') out.push({ reasoning: v })
      else out.push({ text: v })
    }
    // else ignore (title SET, misc metadata)
  } else if (Array.isArray(v) && p === 'response') {
    for (const entry of v) {
      if (!entry || typeof entry !== 'object') continue
      const ev = (entry as { v?: unknown }).v
      if (Array.isArray(ev)) {
        const joined = ev
          .map((item) =>
            item && typeof item === 'object'
              ? String((item as { content?: string }).content || '')
              : '',
          )
          .join('')
        if (joined) {
          state.path = 'content'
          out.push({ text: joined })
        }
      }
    }
  }

  if (
    (p === 'response/status' || p === 'status') &&
    (v === 'FINISHED' || (o === 'SET' && v === 'FINISHED'))
  ) {
    out.push({ finish: true })
  }

  return out
}

function extractDeepSeekContent(raw: string): string {
  let content = ''
  let reasoning = ''
  const state: DeepSeekSseState = { path: '' }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const j = JSON.parse(data) as Record<string, unknown>
      for (const piece of consumeDeepSeekSseEvent(j, state)) {
        if (piece.text) content += piece.text
        if (piece.reasoning) reasoning += piece.reasoning
      }
    } catch {
      // skip
    }
  }
  return content || reasoning
}

/** DeepSeek often returns HTTP 200 + `{code:40003,msg:"INVALID_TOKEN"}` (not SSE). */
function deepseekBizError(status: number, text: string): string | null {
  const raw = (text || '').trim()
  if (!raw || raw.startsWith('data:')) return null
  try {
    const j = JSON.parse(raw) as {
      code?: number
      msg?: string
      message?: string
      data?: { biz_code?: number; biz_msg?: string }
    }
    const code = typeof j.code === 'number' ? j.code : null
    const biz = typeof j.data?.biz_code === 'number' ? j.data.biz_code : null
    if (code != null && code !== 0) {
      const msg = j.msg || j.message || `code ${code}`
      return `DeepSeek upstream HTTP ${status}: ${JSON.stringify({ code, msg }).slice(0, 400)}`
    }
    if (biz != null && biz !== 0) {
      const msg = j.data?.biz_msg || j.msg || `biz_code ${biz}`
      return `DeepSeek upstream HTTP ${status}: ${JSON.stringify({ biz_code: biz, msg }).slice(0, 400)}`
    }
  } catch {
    // not JSON
  }
  return null
}

// Export cookie helper for extension content-script reference
export function deepseekUserTokenFromCookies(cookies: CookieJarEntry[]): string | undefined {
  return findCookie(cookies, 'userToken')?.value
}

registerAdapter(deepseekAdapter)
