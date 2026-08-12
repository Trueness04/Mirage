/**
 * Google Gemini Web (gemini.google.com)
 * --------------------------------------------------------------------
 * No public OpenAI /models for browser cookies. Chat uses Bard StreamGenerate:
 *   POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
 *
 * Auth: __Secure-1PSID (+ __Secure-1PSIDTS). CSRF from GET /app → SNlM0e.
 * Models: live product modes (field 79) — synced as friendly ids.
 */

import { createHash } from 'crypto'
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

const GEMINI = 'https://gemini.google.com'
const STREAM_PATH =
  '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
const ROTATE = 'https://accounts.google.com/RotateCookies'

const XSRF_RE = /SNlM0e(?:\\?"|"):\\?"(.*?)(?:\\?"|")/
const SID_RE = /FdrFJe(?:\\?"|"):\\?"([\d-]+)(?:\\?"|")/
const BL_RE = /boq_assistant-bard-web-server_[A-Za-z0-9_.-]+/

/** mode id for request[79] — from live Gemini web (gpt4free 2026). */
const MODEL_MODES: Record<string, number> = {
  'gemini-3.6-flash': 1,
  'gemini-3.5-flash-lite': 6,
  'gemini-3.1-pro': 3,
}

const ALIASES: Record<string, string> = {
  'gemini-2.5-flash': 'gemini-3.6-flash',
  'gemini-2.5-pro': 'gemini-3.1-pro',
  'gemini-flash': 'gemini-3.6-flash',
  'gemini-pro': 'gemini-3.1-pro',
  'gemini-auto': 'gemini-3.6-flash',
}

const CATALOG: AdapterModelSpec[] = Object.keys(MODEL_MODES).map((id, i) => ({
  modelKey: id,
  displayName: id,
  upstreamName: id,
  contextWindow: 1_000_000,
  isDefault: i === 0,
  supportsStream: true,
}))

interface GeminiMeta {
  snlm0e: string
  sid?: string
  bl: string
}

/** Per-process cache keyed by PSID prefix */
const metaCache = new Map<string, { meta: GeminiMeta; at: number }>()

export const geminiAdapter: ProviderAdapter = {
  key: 'gemini',
  displayName: 'Google Gemini',

  listModels() {
    return CATALOG
  },

  async buildUpstreamRequest(
    req: OpenAIChatRequest,
    session: AdapterSessionContext,
  ): Promise<UpstreamRequestSpec> {
    const psid = findCookie(session.cookies, '__Secure-1PSID')?.value
    if (!psid) {
      throw new Error(
        'Gemini needs __Secure-1PSID. Open https://gemini.google.com logged in with Mirage, then re-capture.',
      )
    }

    const meta = await fetchGeminiMeta(session.cookies)
    const modelId = resolveModel(req.model)
    const mode = MODEL_MODES[modelId]
    if (mode == null) {
      throw new Error(`Unknown Gemini model ${modelId}`)
    }
    const prompt = lastUserText(req.messages)
    const requestUuid = crypto.randomUUID().toUpperCase()
    const inner = buildRequestArray(prompt, mode, requestUuid)
    const fReq = JSON.stringify([null, JSON.stringify(inner)])
    const params = new URLSearchParams({
      bl: meta.bl,
      hl: 'en',
      _reqid: String(100_000 + Math.floor(Math.random() * 899_999)),
      rt: 'c',
    })
    if (meta.sid) params.set('f.sid', meta.sid)

    const form = new URLSearchParams()
    form.set('f.req', fReq)
    form.set('at', meta.snlm0e)

    const headers: Record<string, string> = {
      ...browserHeaders(session),
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Origin: GEMINI,
      Referer: `${GEMINI}/app`,
      'x-same-domain': '1',
      Cookie: cookieHeader(session.cookies),
      'x-goog-ext-525005358-jspb': `["${requestUuid}",1]`,
    }
    const sapisid = makeSapisidHash(session.cookies)
    if (sapisid) headers.Authorization = sapisid

    return {
      url: `${GEMINI}${STREAM_PATH}?${params.toString()}`,
      method: 'POST',
      stream: true,
      headers,
      // Upstream expects form body; chat route JSON.stringifies — use raw string marker
      body: {
        __mirage_form_body: form.toString(),
      },
    }
  },

  async parseUpstreamResponse(
    raw: Response,
    _session: AdapterSessionContext,
    model: string,
  ): Promise<ChatCompletionResponse> {
    const text = await raw.text()
    if (!raw.ok) {
      throw new Error(`Gemini upstream ${raw.status}: ${text.slice(0, 200)}`)
    }
    const content = extractGeminiText(text)
    if (!content.trim()) {
      throw new Error(
        'Gemini returned empty content — cookies may be stale; open gemini.google.com and re-capture.',
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
    let last = ''
    let sentRole = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const content = contentFromGeminiLine(line)
          if (!content) continue
          let deltaText = ''
          if (content.startsWith(last)) deltaText = content.slice(last.length)
          else deltaText = content
          last = content
          if (!deltaText) continue
          const delta: Partial<ChatMessage> = { content: deltaText }
          if (!sentRole) {
            delta.role = 'assistant'
            sentRole = true
          }
          yield {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: null }],
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
      const psid = findCookie(session.cookies, '__Secure-1PSID')?.value
      if (!psid) return { ok: false, error: 'Missing __Secure-1PSID' }
      // Soft rotate PSIDTS when possible
      try {
        await fetch(ROTATE, {
          method: 'POST',
          headers: {
            ...browserHeaders(session),
            Cookie: cookieHeader(session.cookies),
            Origin: 'https://accounts.google.com',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([psid]),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        // ignore rotate failures
      }
      metaCache.delete(psid.slice(0, 16))
      const v = await geminiAdapter.validate(session)
      return v.valid
        ? {
            ok: true,
            cookies: session.cookies,
            expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
          }
        : { ok: false, error: v.reason }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },

  async ping(session: AdapterSessionContext) {
    const v = await geminiAdapter.validate(session)
    return { ok: v.valid, error: v.reason }
  },

  async validate(session: AdapterSessionContext): Promise<SessionValidationResult> {
    const psid = findCookie(session.cookies, '__Secure-1PSID')?.value
    if (!psid) {
      return {
        valid: false,
        reason: 'Missing __Secure-1PSID — log into gemini.google.com and re-capture',
      }
    }
    try {
      await fetchGeminiMeta(session.cookies)
      await syncGeminiModels()
      return {
        valid: true,
        detectedModels: CATALOG.map((m) => m.modelKey),
      }
    } catch (e) {
      return { valid: false, reason: (e as Error).message }
    }
  },
}

export function getGeminiCatalog(): AdapterModelSpec[] {
  return CATALOG
}

async function syncGeminiModels() {
  try {
    const row = await db.provider.findUnique({ where: { key: 'gemini' } })
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

async function fetchGeminiMeta(cookies: CookieJarEntry[]): Promise<GeminiMeta> {
  const psid = findCookie(cookies, '__Secure-1PSID')?.value || ''
  const cacheKey = psid.slice(0, 16)
  const cached = metaCache.get(cacheKey)
  if (cached && Date.now() - cached.at < 50 * 60 * 1000) return cached.meta

  let resp: Response
  try {
    resp = await fetch(`${GEMINI}/app`, {
      headers: {
        ...browserHeaders(),
        Accept: 'text/html',
        Cookie: cookieHeader(cookies),
        Referer: `${GEMINI}/`,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    })
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string; hostname?: string } }
    const cause = e.cause
    const detail = [cause?.code, cause?.hostname, cause?.message || e.message]
      .filter(Boolean)
      .join(' ')
    throw new Error(
      `Gemini fetch failed contacting gemini.google.com${detail ? `: ${detail}` : ''}`,
    )
  }
  const html = await resp.text()
  if (!resp.ok) {
    throw new Error(`Gemini /app HTTP ${resp.status}: ${html.slice(0, 200)}`)
  }
  if (/accounts\.google\.com\/ServiceLogin|Sign in/i.test(html.slice(0, 2000))) {
    throw new Error('Gemini session expired — sign in again and re-capture')
  }
  const snlm0e = html.match(XSRF_RE)?.[1]
  if (!snlm0e) {
    throw new Error('Could not extract SNlM0e CSRF from Gemini — re-capture cookies')
  }
  const sid = html.match(SID_RE)?.[1]
  const bl = html.match(BL_RE)?.[0] || 'boq_assistant-bard-web-server_20260525.09_p0'
  const meta = { snlm0e, sid, bl }
  metaCache.set(cacheKey, { meta, at: Date.now() })
  return meta
}

function resolveModel(raw: string): string {
  const id = String(raw || '')
    .replace(/^gemini\//i, '')
    .trim()
  return ALIASES[id] || (MODEL_MODES[id] != null ? id : 'gemini-3.6-flash')
}

function buildRequestArray(prompt: string, mode: number, requestUuid: string): unknown[] {
  const request: unknown[] = new Array(97).fill(null)
  request[0] = [prompt, 0, null, [], null, null, 0]
  request[1] = ['en']
  request[2] = ['', '', '', null, null, null, null, null, null, '']
  request[6] = [1]
  request[7] = 1
  request[10] = 1
  request[11] = 0
  request[17] = [[0]]
  request[18] = 0
  request[27] = 1
  request[30] = [4]
  request[41] = [1]
  request[53] = 0
  request[59] = requestUuid
  request[61] = []
  request[68] = 2
  request[79] = mode
  request[80] = 1
  request[91] = 0
  request[96] = 1
  return request
}

function makeSapisidHash(cookies: CookieJarEntry[]): string | undefined {
  const sapisid =
    findCookie(cookies, 'SAPISID')?.value ||
    findCookie(cookies, '__Secure-1PAPISID')?.value
  if (!sapisid) return undefined
  const ts = Math.floor(Date.now() / 1000)
  const digest = createHash('sha1')
    .update(`${ts} ${sapisid} https://gemini.google.com`)
    .digest('hex')
  return `SAPISIDHASH ${ts}_${digest}`
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      return m.content
        .map((p) => (typeof p === 'string' ? p : (p as { text?: string }).text || ''))
        .join('\n')
    }
  }
  return messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
}

function extractGeminiText(raw: string): string {
  let best = ''
  for (const line of raw.split('\n')) {
    const c = contentFromGeminiLine(line)
    if (c && c.length >= best.length) best = c
  }
  return best
}

function contentFromGeminiLine(line: string): string {
  const trimmed = line.trim()
  if (!trimmed || trimmed === ")]}'") return ''
  let data = trimmed
  // Length-prefixed Google frames: "123\n[[...]]" or bare JSON
  if (/^\d+$/.test(trimmed)) return ''
  try {
    let parsed: unknown = JSON.parse(data)
    // Often wrb.fr nested: [[["wrb.fr", null, "<json string>"]]]
    const payloads = collectWrbPayloads(parsed)
    for (const payload of payloads) {
      const text = deepFindResponseText(payload)
      if (text) return text
    }
    const direct = deepFindResponseText(parsed)
    if (direct) return direct
  } catch {
    if (data.startsWith(")]}'")) {
      try {
        const parsed = JSON.parse(data.replace(/^\)\]\}'\n?/, ''))
        return deepFindResponseText(parsed)
      } catch {
        return ''
      }
    }
  }
  return ''
}

function collectWrbPayloads(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    if (
      value.length >= 3 &&
      value[0] === 'wrb.fr' &&
      typeof value[2] === 'string'
    ) {
      try {
        out.push(JSON.parse(value[2]))
      } catch {
        // ignore
      }
    }
    for (const item of value) collectWrbPayloads(item, out)
  }
  return out
}

/** Walk Gemini nested arrays for the assistant text snapshot. */
function deepFindResponseText(node: unknown, depth = 0): string {
  if (depth > 12 || node == null) return ''
  if (typeof node === 'string') {
    // Prefer longer prose-looking strings
    if (node.length > 20 && !/^[\[{]/.test(node.trim())) return node
    return ''
  }
  if (!Array.isArray(node)) return ''
  // Classic shape: response_part[4][*][1] text
  if (node.length > 4 && Array.isArray(node[4])) {
    const snapshots: string[] = []
    for (const part of node[4] as unknown[]) {
      if (!Array.isArray(part) || part.length <= 1) continue
      const values = part[1]
      if (typeof values === 'string') snapshots.push(values)
      else if (Array.isArray(values)) {
        for (const v of values) if (typeof v === 'string') snapshots.push(v)
      }
    }
    if (snapshots.length) return snapshots[snapshots.length - 1]
  }
  let best = ''
  for (const child of node) {
    const t = deepFindResponseText(child, depth + 1)
    if (t.length > best.length) best = t
  }
  return best
}

registerAdapter(geminiAdapter)
