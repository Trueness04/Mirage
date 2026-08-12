/**
 * Dola (dola.com) — Doubao/ByteDance global chat
 * --------------------------------------------------------------------
 * No OpenAI /models. Catalog is product modes:
 *   dola-speed (fast) · dola-pro (deep think)
 *
 * Chat: POST https://www.dola.com/chat/completion?...  (SSE)
 * Auth: session cookies (sessionid / sessionid_ss, ttwid, s_v_web_id/fp)
 */

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
import { syncImportedModelsToDb } from './model-import'

const DOLA = 'https://www.dola.com'
const DOLA_CHAT = `${DOLA}/chat/completion`
const DOLA_BOT_ID = '7339470689562525703'

const CATALOG: AdapterModelSpec[] = [
  {
    modelKey: 'dola-speed',
    displayName: 'Dola Speed',
    upstreamName: 'dola-speed',
    contextWindow: 128_000,
    isDefault: true,
    supportsStream: true,
  },
  {
    modelKey: 'dola-pro',
    displayName: 'Dola Pro (Deep Think)',
    upstreamName: 'dola-pro',
    contextWindow: 128_000,
    isDefault: false,
    supportsStream: true,
  },
]

export const dolaAdapter: ProviderAdapter = {
  key: 'dola',
  displayName: 'Dola',

  listModels() {
    return CATALOG
  },

  async buildUpstreamRequest(
    req: OpenAIChatRequest,
    session: AdapterSessionContext,
  ): Promise<UpstreamRequestSpec> {
    const cookies = normalizeDolaCookies(session.cookies)
    const cookieStr = cookieHeader(cookies)
    const sessionId =
      findCookie(cookies, 'sessionid')?.value ||
      findCookie(cookies, 'sessionid_ss')?.value
    if (!sessionId) {
      throw new Error(
        'Dola needs sessionid cookie. Open https://www.dola.com/chat logged in with Mirage, then re-capture.',
      )
    }
    const fp = resolveFingerprint(cookies, session.accessToken)
    if (!fp) {
      throw new Error(
        'Dola needs s_v_web_id (or fp) cookie. Browse dola.com/chat once so the browser fingerprint is set, then re-capture.',
      )
    }

    const modelId = String(req.model || '')
      .replace(/^dola\//i, '')
      .trim() || 'dola-speed'
    const prompt = foldMessages(req.messages)
    const deepThink = modelId === 'dola-pro' || /pro|deep|think/i.test(modelId) ? 3 : 0
    const deviceId = randomNumericId(19)
    const query = new URLSearchParams({
      aid: '495671',
      real_aid: '495671',
      device_platform: 'web',
      device_id: deviceId,
      web_id: deviceId,
      tea_uuid: deviceId,
      web_tab_id: crypto.randomUUID(),
      pc_version: '3.25.3',
      pkg_type: 'release_version',
      version_code: '20800',
      samantha_web: '1',
      web_platform: 'browser',
      'use-olympus-account': '1',
      language: 'en',
      region: 'US',
      sys_region: 'US',
      fp,
    })

    const now = Date.now()
    const body = {
      client_meta: {
        local_conversation_id: `local_${randomNumericId(16)}`,
        conversation_id: '',
        bot_id: DOLA_BOT_ID,
        last_section_id: '',
        last_message_index: null,
      },
      messages: [
        {
          local_message_id: crypto.randomUUID(),
          content_block: [
            {
              block_type: 10000,
              content: {
                text_block: {
                  text: prompt,
                  icon_url: '',
                  icon_url_dark: '',
                  summary: '',
                },
                pc_event_block: '',
              },
              block_id: crypto.randomUUID(),
              parent_id: '',
              meta_info: [],
              append_fields: [],
            },
          ],
          message_status: 0,
        },
      ],
      option: {
        send_message_scene: '',
        create_time_ms: now,
        collect_id: '',
        is_audio: false,
        answer_with_suggest: false,
        tts_switch: false,
        need_deep_think: deepThink,
        click_clear_context: false,
        from_suggest: false,
        is_regen: false,
        is_replace: false,
        is_from_click_option: false,
        is_from_click_softlink: false,
        disable_sse_cache: false,
        select_text_action: '',
        is_select_text: false,
        resend_for_regen: false,
        scene_type: 0,
        unique_key: crypto.randomUUID(),
        start_seq: 0,
        need_create_conversation: true,
        conversation_init_option: { need_ack_conversation: true },
        regen_query_id: [],
        edit_query_id: [],
        regen_instruction: '',
        no_replace_for_regen: false,
        message_from: 0,
        shared_app_name: '',
        shared_app_id: '',
        sse_recv_event_options: { support_chunk_delta: true },
        is_ai_playground: false,
        is_old_user: false,
        recovery_option: {
          is_recovery: false,
          req_create_time_sec: Math.floor(now / 1000),
          append_sse_event_scene: 0,
        },
        message_storage_type: 0,
      },
      user_context: [],
      ext: {
        use_deep_think: String(deepThink),
        fp,
        sub_conv_firstmet_type: '1',
        collection_id: '',
        conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
        commerce_credit_config_enable: '0',
      },
    }

    return {
      url: `${DOLA_CHAT}?${query.toString()}`,
      method: 'POST',
      stream: true,
      headers: {
        ...browserHeaders(session),
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Origin: DOLA,
        Referer: `${DOLA}/chat/`,
        'Agw-Js-Conv': 'str',
        Cookie: cookieStr,
      },
      body,
    }
  },

  async parseUpstreamResponse(
    raw: Response,
    _session: AdapterSessionContext,
    model: string,
  ): Promise<ChatCompletionResponse> {
    const text = await raw.text()
    if (!raw.ok) {
      throw new Error(`Dola upstream ${raw.status}: ${text.slice(0, 200)}`)
    }
    const content = collectDolaSse(text, model)
    if (!content.trim()) {
      throw new Error('Dola returned empty response — re-capture sessionid + s_v_web_id')
    }
    if (isBusy(content)) {
      throw new Error('Dola is busy — try again shortly')
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
        prompt_tokens: 0,
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
    const state = createExtractState(model)
    let sentRole = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const blocks = buf.split(/\r?\n\r?\n/)
        buf = blocks.pop() ?? ''
        for (const block of blocks) {
          const event = parseSseBlock(block)
          if (!event) continue
          if (event.event === 'STREAM_ERROR') {
            throw new Error(extractError(event.data) || 'Dola stream error')
          }
          for (const piece of extractDeltas(event.data, state)) {
            const delta: Partial<ChatMessage> = {}
            if (!sentRole) {
              delta.role = 'assistant'
              sentRole = true
            }
            delta.content = piece
            yield {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta, finish_reason: null }],
            }
          }
          if (event.event === 'SSE_REPLY_END') {
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
      for (const piece of flushState(state)) {
        yield {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { role: sentRole ? undefined : 'assistant', content: piece },
              finish_reason: null,
            },
          ],
        }
        sentRole = true
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
    const v = await dolaAdapter.validate(session)
    return v.valid
      ? {
          ok: true,
          cookies: session.cookies,
          accessToken: session.accessToken,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }
      : { ok: false, error: v.reason }
  },

  async ping(session: AdapterSessionContext) {
    const v = await dolaAdapter.validate(session)
    return { ok: v.valid, error: v.reason }
  },

  async validate(session: AdapterSessionContext): Promise<SessionValidationResult> {
    const cookies = normalizeDolaCookies(session.cookies)
    const sessionId =
      findCookie(cookies, 'sessionid')?.value ||
      findCookie(cookies, 'sessionid_ss')?.value
    if (!sessionId) {
      return { valid: false, reason: 'Missing sessionid — log in on dola.com/chat and re-capture' }
    }
    await syncDolaModels()
    const fp = resolveFingerprint(cookies, session.accessToken)
    return {
      valid: true,
      detectedModels: CATALOG.map((m) => m.modelKey),
      reason: fp
        ? undefined
        : 'Models ready. Chat also needs s_v_web_id — open dola.com/chat once and re-capture.',
    }
  },
}

export function getDolaCatalog(): AdapterModelSpec[] {
  return CATALOG
}

async function syncDolaModels() {
  try {
    const row = await db.provider.findUnique({ where: { key: 'dola' } })
    if (!row) return
    await syncImportedModelsToDb(
      row.id,
      CATALOG.map((m) => ({
        modelKey: m.modelKey,
        displayName: m.displayName,
        upstreamName: m.upstreamName || m.modelKey,
        contextWindow: m.contextWindow,
      })),
    )
  } catch {
    // ignore
  }
}

function normalizeDolaCookies(cookies: CookieJarEntry[]): CookieJarEntry[] {
  const out = [...cookies]
  const sid = findCookie(out, 'sessionid')
  const sidSs = findCookie(out, 'sessionid_ss')
  if (!sid?.value && sidSs?.value) {
    out.push({
      name: 'sessionid',
      value: sidSs.value,
      domain: '.dola.com',
      path: '/',
      secure: true,
      sameSite: 'None',
    })
  }
  return out
}

function resolveFingerprint(
  cookies: CookieJarEntry[],
  accessToken?: string,
): string {
  const fromToken = (accessToken || '').trim()
  return (
    findCookie(cookies, 's_v_web_id')?.value ||
    findCookie(cookies, 'fp')?.value ||
    (fromToken.startsWith('verify_') || fromToken.length > 20 ? fromToken : '') ||
    ''
  )
}

function foldMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const text =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .map((p) =>
                  typeof p === 'string' ? p : (p as { text?: string }).text || '',
                )
                .join('\n')
            : ''
      return text ? `${m.role}: ${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function randomNumericId(length: number): string {
  let id = String(1 + Math.floor(Math.random() * 9))
  for (let i = 1; i < length; i++) id += String(Math.floor(Math.random() * 10))
  return id
}

interface ExtractState {
  deferUntilAnswer: boolean
  answerStarted: boolean
  buffered: string[]
}

function createExtractState(modelId: string): ExtractState {
  const defer = /pro|deep|think/i.test(modelId)
  return { deferUntilAnswer: defer, answerStarted: !defer, buffered: [] }
}

function parseSseBlock(block: string): { event: string; data: unknown } | null {
  const lines = block.split(/\r?\n/)
  const event =
    lines.find((l) => l.startsWith('event:'))?.slice(6).trim() || ''
  const dataLines = lines
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
  if (!dataLines.length) return null
  const raw = dataLines.join('\n')
  if (raw === '[DONE]') return { event: event || 'done', data: '[DONE]' }
  try {
    return { event, data: JSON.parse(raw) }
  } catch {
    return null
  }
}

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

function extractDeltas(data: unknown, state: ExtractState): string[] {
  const root = asRec(data)
  const payload = asRec(root.data)
  const content = asRec(root.content)
  const payloadContent = asRec(payload.content)
  const initial = Array.isArray(content.content_block)
    ? content.content_block
    : Array.isArray(payloadContent.content_block)
      ? payloadContent.content_block
      : []
  const patchOps = Array.isArray(root.patch_op)
    ? root.patch_op
    : Array.isArray(payload.patch_op)
      ? payload.patch_op
      : []
  const out: string[] = []
  out.push(...fromBlocks(initial, state))
  for (const op of patchOps) {
    const blocks = asRec(asRec(op).patch_value).content_block
    if (Array.isArray(blocks)) out.push(...fromBlocks(blocks, state))
  }
  return out
}

function fromBlocks(blocks: unknown[], state: ExtractState): string[] {
  const deltas: string[] = []
  for (const block of blocks) {
    const b = asRec(block)
    if (b.block_type === 10040 && b.is_finish === true) {
      state.answerStarted = true
      state.buffered = []
      continue
    }
    const text = String(asRec(asRec(b.content).text_block).text || '')
    if (!text) continue
    if (state.answerStarted) deltas.push(text)
    else state.buffered.push(text)
  }
  return deltas
}

function flushState(state: ExtractState): string[] {
  if (state.answerStarted) return []
  const fallback = state.buffered
  state.buffered = []
  state.answerStarted = true
  return fallback
}

function collectDolaSse(raw: string, model: string): string {
  const state = createExtractState(model)
  const deltas: string[] = []
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const event = parseSseBlock(block)
    if (event) deltas.push(...extractDeltas(event.data, state))
  }
  deltas.push(...flushState(state))
  return deltas.join('')
}

function extractError(data: unknown): string {
  const root = asRec(data)
  const payload = asRec(root.data)
  return String(
    root.message || payload.message || payload.error_msg || payload.errorMessage || '',
  )
}

function isBusy(content: string): boolean {
  const n = content.toLowerCase()
  return n.includes('a lot of people are using') && n.includes('try again later')
}

registerAdapter(dolaAdapter)
