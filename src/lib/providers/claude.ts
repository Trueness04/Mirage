/**
 * Claude.ai Adapter
 * --------------------------------------------------------------------
 * Website: https://claude.ai
 *
 * Auth: sessionKey cookie (+ anthropic-device-id, lastActiveOrg).
 * Models: imported from /api/bootstrap → organization.claude_ai_bootstrap_models_config
 * Chat:
 *   1) POST /api/organizations/{org}/chat_conversations
 *   2) POST .../chat_conversations/{uuid}/completion  (SSE Anthropic messages)
 */

import { db } from '@/lib/db'
import {
  browserHeaders,
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
import { claudeHttp, isCloudflareChallenge } from './claude-http'

const CLAUDE = 'https://claude.ai'
const CLAUDE_ORGS = `${CLAUDE}/api/organizations`
const CLAUDE_BOOTSTRAP = `${CLAUDE}/api/bootstrap`

/** OmniRoute claude-web static catalog (cw / claude-web). */
export const CLAUDE_WEB_MODELS: AdapterModelSpec[] = [
  {
    modelKey: 'claude-fable-5',
    displayName: 'Claude Fable 5 (web)',
    upstreamName: 'claude-fable-5',
    contextWindow: 1_000_000,
  },
  {
    modelKey: 'claude-opus-5',
    displayName: 'Claude Opus 5 (web)',
    upstreamName: 'claude-opus-5',
    contextWindow: 1_000_000,
  },
  {
    modelKey: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8 (web)',
    upstreamName: 'claude-opus-4-8',
    contextWindow: 1_000_000,
  },
  {
    modelKey: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7 (web)',
    upstreamName: 'claude-opus-4-7',
    contextWindow: 1_000_000,
  },
  {
    modelKey: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6 (web)',
    upstreamName: 'claude-opus-4-6',
    contextWindow: 1_000_000,
  },
  {
    modelKey: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5 (web)',
    upstreamName: 'claude-sonnet-5',
    contextWindow: 1_000_000,
    isDefault: true,
  },
  {
    modelKey: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6 (web)',
    upstreamName: 'claude-sonnet-4-6',
    contextWindow: 200_000,
  },
  {
    modelKey: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5 (web)',
    upstreamName: 'claude-haiku-4-5-20251001',
    contextWindow: 200_000,
  },
]

export function getClaudeWebCatalog(): AdapterModelSpec[] {
  return CLAUDE_WEB_MODELS.map((m) => ({ ...m }))
}

let cachedModels: AdapterModelSpec[] | null = null

export const claudeAdapter: ProviderAdapter = {
  key: 'claude',
  displayName: 'Claude (Anthropic)',

  listModels(): AdapterModelSpec[] {
    return cachedModels?.length ? cachedModels : getClaudeWebCatalog()
  },

  async buildUpstreamRequest(
    req: OpenAIChatRequest,
    session: AdapterSessionContext,
  ): Promise<UpstreamRequestSpec> {
    const sessionKey = extractSessionKey(session.cookies)
    if (!sessionKey) {
      throw new Error(
        'Claude session has no sessionKey cookie. Open claude.ai while logged in with the Mirage extension.',
      )
    }

    const headers = claudeHeaders(session)
    if (!cachedModels?.length) {
      const imported = await importModelsFromBootstrap(headers, session.deviceId)
      if (imported.length) {
        cachedModels = imported
        void syncClaudeModelsToDb(imported)
      } else {
        cachedModels = getClaudeWebCatalog()
      }
    }
    const orgId = await resolveOrgId(session, headers)
    const upstreamModel = resolveUpstreamModel(req.model)

    const convId = crypto.randomUUID()
    const create = await claudeHttp({
      url: `${CLAUDE}/api/organizations/${orgId}/chat_conversations`,
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uuid: convId,
        name: '',
        model: upstreamModel,
      }),
      deviceId: session.deviceId,
    })
    if (!create.ok) {
      // Retry without explicit model — server picks account default
      const retryId = crypto.randomUUID()
      const retry = await claudeHttp({
        url: `${CLAUDE}/api/organizations/${orgId}/chat_conversations`,
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: retryId, name: '' }),
        deviceId: session.deviceId,
      })
      if (!retry.ok) {
        const snippet = create.body.replace(/\s+/g, ' ').trim().slice(0, 220)
        if (isCloudflareChallenge(create.status, create.body)) {
          throw new Error(
            'Claude Cloudflare challenge — open https://claude.ai in Chrome, finish CF while logged in, keep tab open, Mirage extension online, retry.',
          )
        }
        throw new Error(
          `Claude create conversation failed ${create.status}: ${snippet}`,
        )
      }
      let created: { uuid?: string; model?: string } = {}
      try {
        created = JSON.parse(retry.body)
      } catch {
        created = {}
      }
      return completionSpec(
        orgId,
        created.uuid || retryId,
        created.model || upstreamModel,
        req,
        headers,
      )
    }

    return completionSpec(orgId, convId, upstreamModel, req, headers)
  },

  async parseUpstreamResponse(
    raw: Response,
    _session: AdapterSessionContext,
    model: string,
  ): Promise<ChatCompletionResponse> {
    if (!raw.ok) {
      const text = await raw.text()
      throw new Error(`Claude upstream error ${raw.status}: ${text.slice(0, 200)}`)
    }
    const text = await raw.text()
    const content = extractClaudeContent(text)
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

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        const events = buf.split('\n\n')
        buf = events.pop() ?? ''
        for (const evt of events) {
          const dataStr = sseData(evt)
          if (!dataStr) continue
          try {
            const j = JSON.parse(dataStr)
            const piece = deltaTextFromClaudeEvent(j)
            if (piece) {
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
            if (
              j.type === 'message_stop' ||
              j.type === 'message_limit' ||
              j.stop_reason === 'end_turn'
            ) {
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
      if (!extractSessionKey(session.cookies)) {
        return {
          ok: false,
          error:
            'Claude session has no sessionKey cookie. Open claude.ai while logged in with the Mirage extension.',
        }
      }
      const resp = await claudeHttp({
        url: CLAUDE_ORGS,
        headers: claudeHeaders(session),
        deviceId: session.deviceId,
      })
      if (isCloudflareChallenge(resp.status, resp.body)) {
        return {
          ok: false,
          error: `Claude upstream HTTP ${resp.status}: Cloudflare challenge — open https://claude.ai in Chrome with Mirage extension online`,
        }
      }
      if (resp.status === 401) return { ok: false, error: 'Session expired' }
      if (!resp.ok) {
        return {
          ok: false,
          error: `Claude upstream HTTP ${resp.status}: ${resp.body.replace(/\s+/g, ' ').trim().slice(0, 200)}`,
        }
      }
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
    const r = await claudeAdapter.refresh(session)
    return { ok: r.ok, error: r.error }
  },

  async cleanupRemoteChat(session: AdapterSessionContext, remoteChatId: string) {
    if (!remoteChatId) return
    try {
      const headers = claudeHeaders(session)
      const orgId = await resolveOrgId(session, headers)
      await claudeHttp({
        url: `${CLAUDE}/api/organizations/${orgId}/chat_conversations/${remoteChatId}`,
        method: 'DELETE',
        headers,
        deviceId: session.deviceId,
      })
    } catch {
      // cleanup only
    }
  },

  async clearRemoteChats(
    session: AdapterSessionContext,
    opts = {},
  ): Promise<ClearRemoteChatsResult> {
    const headers = claudeHeaders(session)
    const orgId = await resolveOrgId(session, headers)
    const limit = Math.min(500, Math.max(1, opts.limit ?? 200))
    const list = await claudeHttp({
      url: `${CLAUDE}/api/organizations/${orgId}/chat_conversations`,
      method: 'GET',
      headers,
      deviceId: session.deviceId,
    })
    if (!list.ok) {
      return {
        ok: false,
        deleted: 0,
        error: `Claude list conversations HTTP ${list.status}`,
      }
    }
    let chats: Array<{ uuid?: string; name?: string }> = []
    try {
      const parsed = JSON.parse(list.body)
      chats = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.chat_conversations)
          ? parsed.chat_conversations
          : []
    } catch {
      return { ok: false, deleted: 0, error: 'Claude list returned non-JSON' }
    }
    const targets = chats
      .map((c) => String(c.uuid || ''))
      .filter(Boolean)
      .slice(0, limit)
    let deleted = 0
    for (const uuid of targets) {
      const r = await claudeHttp({
        url: `${CLAUDE}/api/organizations/${orgId}/chat_conversations/${uuid}`,
        method: 'DELETE',
        headers,
        deviceId: session.deviceId,
      })
      if (r.ok || r.status === 404) deleted += 1
      await new Promise((res) => setTimeout(res, 250))
    }
    return {
      ok: true,
      deleted,
      listed: chats.length,
      detail: `Deleted ${deleted} conversation(s) on claude.ai`,
    }
  },

  async validate(session: AdapterSessionContext): Promise<SessionValidationResult> {
    try {
      if (!extractSessionKey(session.cookies)) {
        return {
          valid: false,
          reason:
            'Claude session has no sessionKey cookie. Open claude.ai while logged in with the Mirage extension.',
        }
      }
      const headers = claudeHeaders(session)
      const models = await importModelsFromBootstrap(headers, session.deviceId)
      if (models.length === 0) {
        const resp = await claudeHttp({
          url: CLAUDE_ORGS,
          headers,
          deviceId: session.deviceId,
        })
        if (isCloudflareChallenge(resp.status, resp.body)) {
          // Cookie jar is still usable via browser transport + static catalog.
          const catalog = getClaudeWebCatalog()
          cachedModels = catalog
          await syncClaudeModelsToDb(catalog)
          return {
            valid: true,
            detectedModels: catalog.map((m) => m.modelKey),
            reason:
              'Cloudflare blocks Node; using OmniRoute claude-web catalog. Keep claude.ai tab open for chat.',
          }
        }
        if (resp.status === 401) return { valid: false, reason: 'Session expired' }
        if (!resp.ok) {
          return {
            valid: false,
            reason: `Claude upstream HTTP ${resp.status}: ${resp.body.replace(/\s+/g, ' ').trim().slice(0, 200)}`,
          }
        }
        let j: unknown
        try {
          j = JSON.parse(resp.body)
        } catch {
          j = null
        }
        if (!Array.isArray(j) || j.length === 0) {
          return { valid: false, reason: 'No organizations found' }
        }
      }

      if (models.length === 0) {
        const catalog = getClaudeWebCatalog()
        cachedModels = catalog
        await syncClaudeModelsToDb(catalog)
        return {
          valid: true,
          detectedModels: catalog.map((m) => m.modelKey),
          reason: 'Bootstrap empty — using OmniRoute claude-web catalog',
        }
      }

      cachedModels = models
      await syncClaudeModelsToDb(models)

      return {
        valid: true,
        detectedModels: models.map((m) => m.modelKey),
      }
    } catch (e) {
      return { valid: false, reason: (e as Error).message }
    }
  },
}

/** Import path helper — live bootstrap, else OmniRoute static catalog. */
export async function importClaudeLiveModels(
  session: AdapterSessionContext,
): Promise<AdapterModelSpec[]> {
  const headers = claudeHeaders(session)
  const live = await importModelsFromBootstrap(headers, session.deviceId)
  if (live.length) {
    cachedModels = live
    await syncClaudeModelsToDb(live)
    return live
  }
  const catalog = getClaudeWebCatalog()
  cachedModels = catalog
  await syncClaudeModelsToDb(catalog)
  return catalog
}

function completionSpec(
  orgId: string,
  convId: string,
  model: string,
  req: OpenAIChatRequest,
  headers: Record<string, string>,
): UpstreamRequestSpec {
  const prompt = buildPrompt(req)
  return {
    url: `${CLAUDE}/api/organizations/${orgId}/chat_conversations/${convId}/completion`,
    method: 'POST',
    stream: true,
    // Claude CF clearance is TLS-bound; Node fetch fails — use Chrome tab.
    viaBrowser: true,
    remoteChatId: convId,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
      Referer: `${CLAUDE}/chat/${convId}`,
    },
    body: {
      prompt,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      model,
      attachments: [],
      files: [],
      rendering_mode: 'messages',
    },
  }
}

function buildPrompt(req: OpenAIChatRequest): string {
  const sysMsg = req.messages.find((m) => m.role === 'system')?.content
  const sysText =
    typeof sysMsg === 'string'
      ? sysMsg
      : Array.isArray(sysMsg)
        ? sysMsg.map((p) => (p as { text?: string }).text || '').join('\n')
        : ''
  const recent = req.messages.filter((m) => m.role !== 'system')
  const lastUser = [...recent].reverse().find((m) => m.role === 'user')
  const userText = lastUser
    ? typeof lastUser.content === 'string'
      ? lastUser.content
      : Array.isArray(lastUser.content)
        ? lastUser.content.map((p) => (p as { text?: string }).text || '').join('\n')
        : ''
    : ''
  const transcript = recent
    .slice(0, -1)
    .map((m) => {
      const t =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((p) => (p as { text?: string }).text || '').join('\n')
            : ''
      return `${m.role}: ${t}`
    })
    .join('\n\n')

  const promptParts: string[] = []
  if (sysText) promptParts.push(`[Instructions]\n${sysText}`)
  if (transcript) promptParts.push(`[Previous messages]\n${transcript}`)
  if (userText) promptParts.push(userText)
  return promptParts.join('\n\n\n') || 'Hello'
}

function resolveUpstreamModel(modelKey: string): string {
  // Prefer live-imported upstreamName from cache; otherwise pass through as-is
  // (chat route already substitutes ProviderModel.upstreamName into req.model).
  const key = modelKey.includes('/')
    ? modelKey.split('/').slice(1).join('/')
    : modelKey
  const fromCache = cachedModels?.find(
    (m) => m.modelKey === key || m.upstreamName === key,
  )
  return fromCache?.upstreamName || key
}

function claudeHeaders(session: AdapterSessionContext): Record<string, string> {
  const deviceId =
    findCookie(session.cookies, 'anthropic-device-id')?.value || crypto.randomUUID()
  return {
    ...browserHeaders(session),
    Cookie: cookieHeader(session.cookies),
    Origin: CLAUDE,
    Referer: `${CLAUDE}/`,
    Accept: 'application/json',
    'anthropic-client-platform': 'web_claude_ai',
    'anthropic-device-id': deviceId,
    'anthropic-client-shield-enabled': 'true',
  }
}

function extractSessionKey(cookies: CookieJarEntry[]): string | undefined {
  return (
    findCookie(cookies, 'sessionKey')?.value ||
    findCookie(cookies, 'sessionKeyLC')?.value
  )
}

async function resolveOrgId(
  session: AdapterSessionContext,
  headers: Record<string, string>,
): Promise<string> {
  const fromCookie = findCookie(session.cookies, 'lastActiveOrg')?.value
  if (fromCookie) return fromCookie

  const resp = await claudeHttp({
    url: CLAUDE_ORGS,
    headers,
    deviceId: session.deviceId,
  })
  if (!resp.ok) {
    throw new Error(
      `Failed to fetch Claude org: ${resp.status} ${resp.body.replace(/\s+/g, ' ').trim().slice(0, 160)}`,
    )
  }
  let j: unknown
  try {
    j = JSON.parse(resp.body)
  } catch {
    throw new Error('Failed to fetch Claude org: non-JSON response')
  }
  const list = Array.isArray(j) ? j : []
  const withChat = list.find(
    (o: { capabilities?: string[] }) =>
      Array.isArray(o.capabilities) && o.capabilities.includes('chat'),
  )
  const org = withChat || list[0]
  const id = org?.uuid || org?.id
  if (!id) {
    throw new Error(
      'No Claude organization found. Open claude.ai once while logged in, then re-capture.',
    )
  }
  return String(id)
}

async function importModelsFromBootstrap(
  headers: Record<string, string>,
  deviceId?: string | null,
): Promise<AdapterModelSpec[]> {
  let resp
  try {
    resp = await claudeHttp({
      url: CLAUDE_BOOTSTRAP,
      headers,
      deviceId,
    })
  } catch {
    return []
  }
  if (!resp.ok || isCloudflareChallenge(resp.status, resp.body)) return []
  let boot: Record<string, unknown>
  try {
    boot = JSON.parse(resp.body) as Record<string, unknown>
  } catch {
    return []
  }
  const account = boot.account as Record<string, unknown> | undefined
  const memberships = (account?.memberships ||
    boot.memberships ||
    []) as Array<{ organization?: Record<string, unknown> }>
  const org = memberships[0]?.organization
  const cfg = (org?.claude_ai_bootstrap_models_config || []) as Array<{
    model?: string
    name?: string
  }>
  if (!Array.isArray(cfg) || cfg.length === 0) return []

  const models: AdapterModelSpec[] = []
  for (const row of cfg) {
    const upstream = String(row.model || '').trim()
    if (!upstream || !upstream.startsWith('claude-')) continue

    const modelKey = shortenModelKey(upstream)
    models.push({
      modelKey,
      displayName: String(row.name || modelKey),
      upstreamName: upstream,
      contextWindow: 200_000,
      isDefault: upstream === 'claude-sonnet-5' || modelKey === 'claude-sonnet-5',
      supportsStream: true,
    })
  }

  if (models.length && !models.some((m) => m.isDefault)) {
    models[0].isDefault = true
  }
  return models
}

function shortenModelKey(upstream: string): string {
  // claude-haiku-4-5-20251001 → claude-haiku-4-5
  return upstream.replace(/-\d{8}$/, '').replace(/-claude-ai$/, '')
}

async function syncClaudeModelsToDb(models: AdapterModelSpec[]) {
  try {
    const provider = await db.provider.findUnique({ where: { key: 'claude' } })
    if (!provider) return

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
          contextWindow: m.contextWindow ?? 200_000,
          supportsStream: true,
        },
        create: {
          providerId: provider.id,
          modelKey: m.modelKey,
          displayName: m.displayName,
          upstreamName: m.upstreamName ?? m.modelKey,
          enabled: true,
          isDefault: m.isDefault ?? false,
          contextWindow: m.contextWindow ?? 200_000,
          supportsStream: true,
        },
      })
    }

    // Disable stale rows not in the live bootstrap catalog
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
  } catch (e) {
    console.warn('[claude] model sync failed:', e)
  }
}

function sseData(block: string): string {
  let data = ''
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  return data
}

function deltaTextFromClaudeEvent(j: Record<string, unknown>): string {
  // Modern Anthropic SSE
  if (j.type === 'content_block_delta') {
    const delta = j.delta as { type?: string; text?: string } | undefined
    if (delta?.type === 'text_delta' && delta.text) return delta.text
  }
  // Legacy web SSE
  if (j.type === 'completion' && typeof j.completion === 'string') {
    return j.completion
  }
  return ''
}

function extractClaudeContent(raw: string): string {
  let content = ''
  for (const evt of raw.split('\n\n')) {
    const dataStr = sseData(evt)
    if (!dataStr) continue
    try {
      content += deltaTextFromClaudeEvent(JSON.parse(dataStr))
    } catch {
      // skip
    }
  }
  return content
}

registerAdapter(claudeAdapter)
