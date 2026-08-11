import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeeded } from '@/lib/providers/seed'
import { hashKey } from '@/lib/openai/api-key'
import {
  getAdapter,
  type AdapterSessionContext,
  type ChatCompletionResponse,
  type ChatMessage,
  type OpenAIChatRequest,
  type ProviderAdapter,
} from '@/lib/providers/base'
import '@/lib/providers'
import { loadSessionContext } from '@/lib/providers/session-loader'
import {
  enqueueToolJob,
  extractToolCalls,
  isMirageLocalTool,
  pickOnlineDeviceId,
  requestHasMirageTools,
  splitTools,
  waitForToolJob,
} from '@/lib/tools/local'
import {
  chatNotReadyMessage,
  isChatCapableProvider,
} from '@/lib/providers/chat-ready'
import { ensureZaiCaptcha } from '@/lib/providers/zai-captcha'
import { qwenTongyiHttp2 } from '@/lib/providers/qwen'
import { responseFromClaudeHttp } from '@/lib/providers/claude-http'
import { scheduleRemoteChatCleanup } from '@/lib/providers/clear-remote'
import { isProbeChatRequest } from '@/lib/providers/remote-chat-sticky'
import {
  normalizeDeepSeekModelKey,
  resolveProviderAlias,
} from '@/lib/providers/aliases'
import { requireAdmin } from '@/lib/auth/admin'
import { hasProviderAuthMaterial, parseCookieJar } from '@/lib/providers/cookie-jar'
import {
  isChatQwenHost,
  isChatQwenProviderKey,
} from '@/lib/providers/qwen-intl'

/**
 * POST /v1/chat/completions (also rewritten from /v1/chat/completions)
 *
 * Auth: Bearer <Mirage API key>
 *   or dashboard admin cookie (Playground) — uses first enabled API key.
 * Body: standard OpenAI chat completion request.
 *
 * Model naming convention:
 *   - "provider/modelKey"  -> routes to that provider adapter
 *   - "modelKey" (no slash) -> unique enabled model across providers
 *
 * If multiple sessions exist for a provider, the API key's sessionIds
 * (if set) restrict which sessions can be used; otherwise the most-recently
 * refreshed active session is chosen.
 */
export async function POST(req: Request) {
  await ensureSeeded()
  const startedAt = Date.now()
  const elapsed = () => Date.now() - startedAt

  const auth = req.headers.get('authorization') || ''
  const apiKey = auth.replace(/^Bearer\s+/i, '').trim()

  let keyRecord: Awaited<ReturnType<typeof db.apiKey.findUnique>> = null
  if (apiKey) {
    const keyHash = hashKey(apiKey)
    keyRecord = await db.apiKey.findUnique({ where: { keyHash } })
    if (!keyRecord || !keyRecord.enabled) {
      const msg =
        'Invalid Mirage API key (sk-mg-…). This is not a DeepSeek/provider key — create or paste a full key from Dashboard → API Keys.'
      await logRequest({
        status: 401,
        stream: false,
        durationMs: elapsed(),
        errorMessage: msg,
      })
      return NextResponse.json(
        {
          error: {
            message: msg,
            type: 'invalid_request_error',
          },
        },
        { status: 401 },
      )
    }
  } else {
    // Dashboard Playground: already logged in as admin — no pasted sk-mg needed.
    const denied = requireAdmin(req)
    if (denied) {
      await logRequest({
        status: 401,
        stream: false,
        durationMs: elapsed(),
        errorMessage: 'Missing API key',
      })
      return NextResponse.json(
        { error: { message: 'Missing API key', type: 'invalid_request_error' } },
        { status: 401 },
      )
    }
    keyRecord = await db.apiKey.findFirst({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
    })
    if (!keyRecord) {
      const msg =
        'No Mirage API key exists yet. Create one under Dashboard → API Keys (Playground needs it for logging).'
      await logRequest({
        status: 401,
        stream: false,
        durationMs: elapsed(),
        errorMessage: msg,
      })
      return NextResponse.json(
        { error: { message: msg, type: 'invalid_request_error' } },
        { status: 401 },
      )
    }
  }

  const body = (await req.json().catch(() => ({}))) as OpenAIChatRequest
  if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
    await logRequest({
      apiKeyId: keyRecord.id,
      model: body.model,
      status: 400,
      stream: false,
      durationMs: elapsed(),
      errorMessage: 'model and messages[] are required',
    })
    return NextResponse.json(
      { error: { message: 'model and messages[] are required', type: 'invalid_request_error' } },
      { status: 400 },
    )
  }

  // Parse "provider/model" or unambiguous single-provider model key.
  // NOTE: JS String#split(sep, limit) caps array length (unlike Python) —
  // so "huggingface/org/model" must use indexOf, not split('/', 2).
  // Aliases: ds-web → deepseek, etc. (other web-cookie gateway naming).
  let providerKey: string
  let modelKey: string
  if (body.model.includes('/')) {
    const slash = body.model.indexOf('/')
    providerKey = resolveProviderAlias(body.model.slice(0, slash))
    modelKey = body.model.slice(slash + 1)
  } else {
    const matches = await db.providerModel.findMany({
      where: {
        modelKey: body.model,
        enabled: true,
        provider: { enabled: true },
      },
      include: { provider: true },
      take: 5,
    })
    if (matches.length === 0) {
      const msg = `Unknown model: ${body.model}. Use provider/modelKey from GET /v1/models.`
      await logRequest({
        apiKeyId: keyRecord.id,
        model: body.model,
        status: 400,
        stream: false,
        durationMs: elapsed(),
        errorMessage: msg,
      })
      return NextResponse.json(
        { error: { message: msg, type: 'invalid_request_error' } },
        { status: 400 },
      )
    }
    if (matches.length > 1) {
      const options = matches.map((m) => `${m.provider.key}/${m.modelKey}`)
      const msg = `Ambiguous model "${body.model}". Specify one of: ${options.join(', ')}`
      await logRequest({
        apiKeyId: keyRecord.id,
        model: body.model,
        status: 400,
        stream: false,
        durationMs: elapsed(),
        errorMessage: msg,
      })
      return NextResponse.json(
        { error: { message: msg, type: 'invalid_request_error' } },
        { status: 400 },
      )
    }
    providerKey = matches[0].provider.key
    modelKey = matches[0].modelKey
  }

  if (providerKey === 'deepseek') {
    modelKey = normalizeDeepSeekModelKey(modelKey)
  }

  // Resolve provider + model
  const provider = await db.provider.findUnique({
    where: { key: providerKey },
    include: { models: { where: { enabled: true } } },
  })
  if (!provider) {
    const msg = `Unknown provider: ${providerKey}`
    await logRequest({
      apiKeyId: keyRecord.id,
      model: body.model,
      status: 400,
      stream: false,
      durationMs: elapsed(),
      errorMessage: msg,
    })
    return NextResponse.json(
      { error: { message: msg, type: 'invalid_request_error' } },
      { status: 400 },
    )
  }
  if (!provider.enabled) {
    const msg = `Provider ${providerKey} is disabled`
    await logRequest({
      apiKeyId: keyRecord.id,
      providerId: provider.id,
      model: body.model,
      status: 403,
      stream: false,
      durationMs: elapsed(),
      errorMessage: msg,
    })
    return NextResponse.json(
      { error: { message: msg, type: 'invalid_request_error' } },
      { status: 403 },
    )
  }

  if (!isChatCapableProvider(provider)) {
    const msg = chatNotReadyMessage(providerKey)
    await logRequest({
      apiKeyId: keyRecord.id,
      providerId: provider.id,
      model: body.model,
      status: 501,
      stream: false,
      durationMs: elapsed(),
      errorMessage: msg,
    })
    return NextResponse.json(
      { error: { message: msg, type: 'invalid_request_error' } },
      { status: 501 },
    )
  }

  const modelRecord = provider.models.find((m) => m.modelKey === modelKey)
  if (!modelRecord) {
    const msg = `Provider ${providerKey} does not expose model ${modelKey}`
    await logRequest({
      apiKeyId: keyRecord.id,
      providerId: provider.id,
      model: body.model,
      status: 400,
      stream: false,
      durationMs: elapsed(),
      errorMessage: msg,
    })
    return NextResponse.json(
      { error: { message: msg, type: 'invalid_request_error' } },
      { status: 400 },
    )
  }

  // Find sessions — primary (priority 0) first, then fallback (1+),
  // then most recently refreshed within the same priority.
  const scopedSessionIds = safeParseSessionIds(keyRecord.sessionIds)
  const sessionsRaw = await db.providerSession.findMany({
    where: {
      providerId: provider.id,
      // Soft-failed jars (status error with cookies/token) still usable for chat.
      status: { in: ['active', 'error', 'refreshing'] },
      ...(scopedSessionIds.length > 0 ? { id: { in: scopedSessionIds } } : {}),
    },
    orderBy: [{ priority: 'asc' }, { lastRefreshAt: 'desc' }],
  })

  // Prefer sessions that actually have credentials (skip empty cookie shells).
  // Kimi is bearer-only: cookies without access/refresh cannot chat.
  // Arena/Claude viaBrowser can still work with a device-bound session when
  // the live tab is logged in, but prefer jars with real auth material.
  const sessions = sessionsRaw
    .filter((s) => {
      const hasToken = Boolean(s.accessToken?.trim() || s.refreshToken?.trim())
      if (providerKey === 'kimi') return hasToken
      const cookies = parseCookieJar(s.cookies)
      if (hasToken || cookies.length > 0) return true
      return false
    })
    .sort((a, b) => {
      const aAuth = hasProviderAuthMaterial(
        providerKey,
        parseCookieJar(a.cookies),
        a.accessToken,
        a.refreshToken,
      )
        ? 0
        : 1
      const bAuth = hasProviderAuthMaterial(
        providerKey,
        parseCookieJar(b.cookies),
        b.accessToken,
        b.refreshToken,
      )
        ? 0
        : 1
      if (aAuth !== bAuth) return aAuth - bAuth
      return 0
    })

  if (sessions.length === 0) {
    const msg =
      providerKey === 'kimi'
        ? `No usable Kimi session (need access_token or refresh_token). Open www.kimi.com, send one message, then Capture with the Mirage extension.`
        : `No active session for ${providerKey}. Capture one with the Mirage extension (ideally on Chrome + Edge for fallback).`
    await logRequest({
      apiKeyId: keyRecord.id,
      providerId: provider.id,
      model: body.model,
      status: 503,
      stream: !!body.stream,
      durationMs: elapsed(),
      errorMessage: msg,
    })
    return NextResponse.json(
      { error: { message: msg, type: 'invalid_request_error' } },
      { status: 503 },
    )
  }

  const useQwenAdapter =
    provider.key === 'qwen' ||
    isChatQwenProviderKey(provider.key) ||
    isChatQwenHost(provider.websiteUrl)

  const adapter = useQwenAdapter
    ? getAdapter('qwen')
    : getAdapter(provider.key)
  if (!adapter) {
    const msg = `No adapter for ${providerKey}`
    await logRequest({
      apiKeyId: keyRecord.id,
      providerId: provider.id,
      model: body.model,
      status: 500,
      stream: !!body.stream,
      durationMs: elapsed(),
      errorMessage: msg,
    })
    return NextResponse.json(
      { error: { message: msg, type: 'server_error' } },
      { status: 500 },
    )
  }

  const wantsMirageTools = requestHasMirageTools(body)
  const { local: localTools, upstream: upstreamTools } = splitTools(body.tools)
  // Local tool loop cannot stream intermediate rounds — force non-stream when needed.
  const allowStream = !wantsMirageTools && !!body.stream

  // Try each session in order until one works
  let lastErr: { status: number; message: string } | null = null
  for (const session of sessions) {
    const loaded = await loadSessionContext(session.id)
    if (!loaded) continue
    const { ctx } = loaded
    let lastRemoteChatId: string | undefined
    let lastEphemeralRemote = false

    try {
      const hasAccess =
        Boolean(ctx.accessToken?.trim()) ||
        Boolean(
          ctx.cookies?.some(
            (c) =>
              /^(access_token|kimi_access_token|accessToken)$/i.test(c.name) &&
              c.value?.trim(),
          ),
        )
      const hasRefresh =
        Boolean(ctx.refreshToken?.trim()) ||
        Boolean(
          ctx.cookies?.some(
            (c) =>
              /^(refresh_token|refreshToken)$/i.test(c.name) && c.value?.trim(),
          ),
        )
      const nearExpiry =
        Boolean(session.expiresAt) &&
        session.expiresAt!.getTime() - Date.now() < 60_000
      // Kimi (and similar): cookies-only jars often lack access_token until refresh.
      const shouldRefresh =
        Boolean(provider.refreshEndpoint) &&
        (( !hasAccess && hasRefresh) || (hasAccess && nearExpiry))

      if (shouldRefresh) {
        const r = await adapter.refresh(ctx)
        if (r.ok) {
          await db.providerSession.update({
            where: { id: session.id },
            data: {
              accessToken: r.accessToken ?? session.accessToken,
              refreshToken: r.refreshToken ?? session.refreshToken,
              cookies: r.cookies ? JSON.stringify(r.cookies) : session.cookies,
              expiresAt: r.expiresAt ?? null,
              lastRefreshAt: new Date(),
              status: 'active',
              errorMessage: null,
            },
          })
          ctx.accessToken = r.accessToken || ctx.accessToken
          ctx.refreshToken = r.refreshToken || ctx.refreshToken
          ctx.expiresAt = r.expiresAt
          if (r.cookies) ctx.cookies = r.cookies
        } else if (!hasAccess) {
          lastErr = {
            status: 401,
            message:
              r.error ||
              'Session has no access_token and refresh failed. Open www.kimi.com while logged in, send one chat message, then Capture again.',
          }
          continue
        }
      }

      const modelId = body.model
      const workingMessages: ChatMessage[] = [...body.messages]
      const maxToolRounds = wantsMirageTools ? 4 : 0
      let round = 0
      let parsed: ChatCompletionResponse | null = null
      let lastUpstreamStatus = 200

      while (true) {
        const toolsForUpstream =
          localTools.length > 0
            ? [...upstreamTools, ...localTools]
            : upstreamTools.length > 0
              ? upstreamTools
              : body.tools

        const upstreamModel =
          modelRecord.upstreamName?.trim() || modelKey

        const req2: OpenAIChatRequest = {
          ...body,
          model: upstreamModel,
          messages: workingMessages,
          stream: allowStream && round === 0 && maxToolRounds === 0,
          ...(Array.isArray(toolsForUpstream) && toolsForUpstream.length > 0
            ? { tools: toolsForUpstream }
            : { tools: undefined }),
        }

        // Z.AI: captcha via extension. If extension is stale (Unknown tool),
        // continue and surface the real upstream captcha/body error instead.
        if (providerKey === 'zai') {
          try {
            const captcha = await ensureZaiCaptcha({
              sessionId: session.id,
              deviceId: session.deviceId,
              cookies: ctx.cookies,
              force: true,
            })
            ctx.cookies = captcha.cookies
          } catch (e) {
            const msg = (e as Error).message || String(e)
            if (!/Unknown tool:\s*mirage_zai_captcha/i.test(msg)) throw e
            // fall through — upstream will return the real captcha failure
          }
        }

        const upstream = await adapter.buildUpstreamRequest(req2, ctx)
        lastRemoteChatId = upstream.remoteChatId
        lastEphemeralRemote = Boolean(
          upstream.ephemeralRemoteChat || isProbeChatRequest(req2.messages),
        )
        const headersOut = { ...upstream.headers }
        const kimiSentModel = headersOut['x-mirage-kimi-model']
        const kimiRequested = headersOut['x-mirage-kimi-requested']
        delete headersOut['x-mirage-kimi-model']
        delete headersOut['x-mirage-kimi-requested']
        let upstreamBody: BodyInit
        if (upstream.multipart && Object.keys(upstream.multipart).length) {
          const fd = new FormData()
          for (const [k, v] of Object.entries(upstream.multipart)) {
            fd.append(k, v)
          }
          upstreamBody = fd
          delete headersOut['Content-Type']
          delete headersOut['content-type']
        } else {
          // Belt-and-suspenders: force kimi.com allowlist on the wire body.
          if (providerKey === 'kimi' && upstream.body && typeof upstream.body === 'object') {
            const b = {
              ...(upstream.body as Record<string, unknown>),
            }
            const { resolveKimiUpstreamModel } = await import(
              '@/lib/providers/kimi'
            )
            const fixed = resolveKimiUpstreamModel(String(b.model || modelKey))
            b.model = fixed
            // Absolute hard clamp — if anything weird slips through, send kimi.
            if (
              fixed !== 'kimi' &&
              fixed !== 'k1' &&
              fixed !== 'k1.5' &&
              fixed !== 'k2' &&
              fixed !== 'k1.5-thinking'
            ) {
              b.model = 'kimi'
            }
            upstreamBody = JSON.stringify(b)
          } else {
            upstreamBody = serializeUpstreamBody(upstream.body)
          }
        }
        let upstreamResp: Response
        try {
          if (upstream.viaBrowser) {
            const deviceId = await pickOnlineDeviceId(session.deviceId)
            if (!deviceId) {
              lastErr = {
                status: 503,
                message:
                  `${providerKey}: Cloudflare-bound request needs an online Mirage extension with the provider site open in Chrome`,
              }
              parsed = null
              break
            }
            // Live-tab sites: credentials:include — drop jar Cookie
            // (stale clearance / WAF cookies often worse than the browser's).
            const browserHeaders = { ...headersOut }
            if (upstream.viaBrowser) {
              delete browserHeaders.Cookie
              delete browserHeaders.cookie
            }
            const jobId = await enqueueToolJob({
              deviceId,
              toolName: 'mirage_browser_fetch',
              arguments: {
                url: upstream.url,
                method: upstream.method,
                headers: browserHeaders,
                body:
                  typeof upstreamBody === 'string' ? upstreamBody : undefined,
              },
            })
            const waited = await waitForToolJob(jobId, 90_000, 400)
            if (!waited.ok) {
              lastErr = {
                status: 502,
                message: waited.error || 'extension browser_fetch failed',
              }
              parsed = null
              break
            }
            const r = waited.result as {
              status?: number
              ok?: boolean
              body?: string
              contentType?: string
            } | null
            upstreamResp = responseFromClaudeHttp({
              status: Number(r?.status || 502),
              ok: Boolean(r?.ok),
              body: String(r?.body ?? ''),
              contentType:
                typeof r?.contentType === 'string' ? r.contentType : undefined,
            })
          } else if (
            providerKey === 'qwen' &&
            headersOut['x-mirage-qwen-http2'] === '1'
          ) {
            // Qwen-Free-API path: HTTP/2 dialog/conversation (fetch → empty SSE).
            const cookie = headersOut.Cookie || headersOut.cookie || ''
            delete headersOut['x-mirage-qwen-http2']
            upstreamResp = await qwenTongyiHttp2(upstream.body, cookie)
          } else {
            upstreamResp = await fetch(upstream.url, {
              method: upstream.method,
              headers: headersOut,
              body: upstreamBody,
            })
          }
        } catch (e) {
          lastErr = {
            status: 502,
            message: formatNetworkError(providerKey, e),
          }
          parsed = null
          break
        }

        const upstreamCt = upstreamResp.headers.get('content-type') || ''
        // Peek non-SSE JSON error bodies (Qwen WAF punish / DeepSeek INVALID_TOKEN)
        // so clients get a real error instead of an empty stream.
        let upstreamForParse: Response = upstreamResp
        let upstreamBodyStream = upstreamResp.body
        if (
          (providerKey === 'qwen' || providerKey === 'deepseek') &&
          upstreamResp.ok &&
          upstreamCt.includes('application/json') &&
          !upstreamCt.includes('text/event-stream')
        ) {
          const text = await upstreamResp.text().catch(() => '')
          const isQwenPunish =
            providerKey === 'qwen' &&
            /FAIL_SYS_USER_VALIDATE|_____tmd_____|punish\?/i.test(text)
          const isDeepSeekBiz =
            providerKey === 'deepseek' &&
            /"code"\s*:\s*(?!0\b)\d+|"INVALID_TOKEN"|Authorization Failed/i.test(
              text,
            )
          if (isQwenPunish || isDeepSeekBiz) {
            lastErr = {
              status: isDeepSeekBiz ? 401 : upstreamResp.status || 403,
              message: formatUpstreamError(
                providerKey,
                isDeepSeekBiz ? 401 : upstreamResp.status || 403,
                text,
              ),
            }
            await db.providerSession.update({
              where: { id: session.id },
              data: {
                status: 'error',
                errorMessage: lastErr.message.slice(0, 300),
              },
            })
            parsed = null
            break
          }
          upstreamForParse = new Response(text, {
            status: upstreamResp.status,
            headers: upstreamResp.headers,
          })
          upstreamBodyStream = upstreamForParse.clone().body
        }

        if (!upstreamResp.ok || upstreamCt.includes('text/html')) {
          const text = await upstreamResp.text().catch(() => '')
          let message = formatUpstreamError(providerKey, upstreamResp.status, text)
          if (providerKey === 'kimi') {
            let wireModel = kimiSentModel || '?'
            if (typeof upstreamBody === 'string') {
              try {
                wireModel = String(
                  (JSON.parse(upstreamBody) as { model?: unknown }).model ??
                    wireModel,
                )
              } catch {
                // ignore
              }
            }
            message += ` [wire.model=${wireModel} requested=${kimiRequested || '?'}]`
          }
          lastErr = {
            status: upstreamResp.status || 502,
            message,
          }
          if (
            upstreamResp.status === 401 ||
            upstreamResp.status === 403 ||
            /aliyun_waf|alibaba-ga|Gateway Time-out|FAIL_SYS_USER_VALIDATE/i.test(
              text,
            )
          ) {
            await db.providerSession.update({
              where: { id: session.id },
              data: {
                status: 'error',
                errorMessage: lastErr.message.slice(0, 300),
              },
            })
          }
          parsed = null
          break
        }

        lastUpstreamStatus = upstreamResp.status

        if (allowStream && upstream.stream && round === 0 && maxToolRounds === 0) {
          await db.providerSession.update({
            where: { id: session.id },
            data: { requestCount: { increment: 1 }, lastPingAt: new Date() },
          })
          return streamResponse(upstreamBodyStream!, adapter, ctx, modelId, {
            apiKeyId: keyRecord.id,
            providerId: provider.id,
            sessionLabel: session.label || session.id.slice(0, 8),
            model: modelId,
            upstreamStatus: lastUpstreamStatus,
            startedAt,
            providerKey,
            remoteChatId: upstream.remoteChatId,
            ephemeralRemoteChat: lastEphemeralRemote,
          })
        }

        parsed = await adapter.parseUpstreamResponse(upstreamForParse, ctx, modelId)
        const choice = parsed.choices?.[0]
        const toolCalls = extractToolCalls(choice?.message)
        const localCalls = toolCalls.filter((c) =>
          isMirageLocalTool(c.function.name),
        )
        const hasUpstreamToolCalls = toolCalls.some(
          (c) => !isMirageLocalTool(c.function.name),
        )

        // Upstream-only or mixed tool_calls: return to the client.
        // Pure mirage_* calls are executed by the extension in a server loop.
        if (
          localCalls.length === 0 ||
          hasUpstreamToolCalls ||
          round >= maxToolRounds
        ) {
          break
        }

        const deviceId = await pickOnlineDeviceId(session.deviceId)
        if (!deviceId) {
          lastErr = {
            status: 503,
            message:
              'Local mirage_* tools require an online Mirage extension device',
          }
          parsed = null
          break
        }

        workingMessages.push({
          role: 'assistant',
          content: choice?.message?.content || '',
          tool_calls: localCalls,
        })

        for (const call of localCalls) {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(call.function.arguments || '{}')
          } catch {
            args = {}
          }
          const jobId = await enqueueToolJob({
            deviceId,
            toolName: call.function.name,
            arguments: args,
          })
          const waited = await waitForToolJob(jobId, 45_000)
          const content = waited.ok
            ? JSON.stringify(waited.result ?? null)
            : JSON.stringify({ error: waited.error || 'tool failed' })
          workingMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content,
          })
        }

        round += 1
      }

      if (!parsed) continue

      await db.providerSession.update({
        where: { id: session.id },
        data: { requestCount: { increment: 1 }, lastPingAt: new Date() },
      })

      await logRequest({
        apiKeyId: keyRecord.id,
        providerId: provider.id,
        sessionLabel: session.label || session.id.slice(0, 8),
        model: modelId,
        status: 200,
        upstreamStatus: lastUpstreamStatus,
        stream: false,
        durationMs: elapsed(),
      })
      scheduleRemoteChatCleanup(
        providerKey,
        ctx,
        lastRemoteChatId,
        lastEphemeralRemote,
      )
      return NextResponse.json(parsed)
    } catch (e) {
      const msg = (e as Error).message || String(e)
      // Empty Mirage chats left after create-then-fail also trip anti-bot — wipe.
      if (lastRemoteChatId) {
        scheduleRemoteChatCleanup(providerKey, ctx, lastRemoteChatId, true)
      }
      const missingAuth =
        /needs arena-auth|missing auth|missing tongyi|No access_token|no refresh_token|missing userToken|Chat needs/i.test(
          msg,
        )
      lastErr = {
        status: missingAuth
          ? 401
          : /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network/i.test(msg)
            ? 502
            : 500,
        message: /fetch failed/i.test(msg)
          ? formatNetworkError(providerKey, e)
          : msg,
      }
      continue
    }
  }

  const failStatus = lastErr == null ? 500 : lastErr.status
  const failMessage =
    lastErr == null
      ? `All sessions failed for ${providerKey}/${modelKey}`
      : lastErr.message

  await logRequest({
    apiKeyId: keyRecord.id,
    providerId: provider.id,
    model: body.model,
    status: failStatus,
    stream: !!body.stream,
    durationMs: elapsed(),
    errorMessage: failMessage.slice(0, 2000),
  })

  return NextResponse.json(
    {
      error: {
        message: failMessage,
        type: 'upstream_error',
      },
    },
    { status: failStatus },
  )
}

async function streamResponse(
  body: ReadableStream<Uint8Array>,
  adapter: ProviderAdapter,
  ctx: AdapterSessionContext,
  model: string,
  logCtx: {
    apiKeyId?: string
    providerId?: string
    sessionLabel?: string
    model: string
    upstreamStatus?: number
    startedAt: number
    providerKey?: string
    remoteChatId?: string
    ephemeralRemoteChat?: boolean
  },
) {
  const generator = adapter.transformStream(body, ctx, model)
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let hadError: string | null = null
      try {
        for await (const chunk of generator) {
          const payload = `data: ${JSON.stringify(chunk)}\n\n`
          controller.enqueue(encoder.encode(payload))
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (e) {
        hadError = (e as Error).message || String(e)
        const errPayload = `data: ${JSON.stringify({
          error: { message: hadError, type: 'stream_error' },
        })}\n\n`
        controller.enqueue(encoder.encode(errPayload))
      } finally {
        controller.close()
        await logRequest({
          apiKeyId: logCtx.apiKeyId,
          providerId: logCtx.providerId,
          sessionLabel: logCtx.sessionLabel,
          model: logCtx.model,
          status: hadError ? 500 : 200,
          upstreamStatus: logCtx.upstreamStatus,
          stream: true,
          durationMs: Date.now() - logCtx.startedAt,
          errorMessage: hadError ? hadError.slice(0, 2000) : undefined,
        })
        if (logCtx.providerKey && logCtx.remoteChatId) {
          scheduleRemoteChatCleanup(
            logCtx.providerKey,
            ctx,
            logCtx.remoteChatId,
            Boolean(logCtx.ephemeralRemoteChat || hadError),
          )
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

async function logRequest(opts: {
  apiKeyId?: string
  providerId?: string
  sessionLabel?: string
  model?: string
  status: number
  upstreamStatus?: number
  stream: boolean
  durationMs?: number
  errorMessage?: string
}) {
  try {
    await db.requestLog.create({
      data: {
        apiKeyId: opts.apiKeyId ?? null,
        providerId: opts.providerId ?? null,
        sessionLabel: opts.sessionLabel ?? null,
        model: opts.model ?? null,
        endpoint: '/v1/chat/completions',
        method: 'POST',
        status: opts.status,
        upstreamStatus: opts.upstreamStatus ?? null,
        stream: opts.stream,
        durationMs: opts.durationMs ?? null,
        errorMessage: opts.errorMessage?.slice(0, 2000) ?? null,
      },
    })
  } catch {
    // never fail the request on logging errors
  }
}

function safeParseSessionIds(s: string): string[] {
  try {
    const arr = JSON.parse(s)
    if (!Array.isArray(arr)) return []
    return arr.filter((x) => typeof x === 'string' && x.length > 0) as string[]
  } catch {
    return []
  }
}

/** JSON by default; adapters may set `{ __mirage_form_body: "a=b&c=d" }` for form posts. */
function serializeUpstreamBody(body: unknown): string {
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    typeof (body as { __mirage_form_body?: unknown }).__mirage_form_body ===
      'string'
  ) {
    return (body as { __mirage_form_body: string }).__mirage_form_body
  }
  return JSON.stringify(body)
}

/**
 * Surface the real upstream failure. Never replace it with a canned tip —
 * clients need status + body (or a compact HTML summary) to debug.
 */
function formatUpstreamError(
  providerKey: string,
  status: number,
  text: string,
): string {
  return `Upstream ${providerKey} HTTP ${status || 0}: ${compactUpstreamBody(text)}`
}

function formatNetworkError(providerKey: string, err: unknown): string {
  const e = err as Error & { cause?: unknown; code?: string }
  const parts = [`Upstream ${providerKey} fetch failed`]
  if (e?.message && e.message !== 'fetch failed') parts.push(e.message)
  const cause = e?.cause as
    | { code?: string; message?: string; errno?: number; syscall?: string; hostname?: string }
    | undefined
  if (cause && typeof cause === 'object') {
    const detail = [
      cause.code,
      cause.syscall,
      cause.hostname,
      cause.message,
    ]
      .filter(Boolean)
      .join(' ')
    if (detail) parts.push(detail)
  } else if (e?.code) {
    parts.push(e.code)
  }
  return parts.join(': ')
}

function compactUpstreamBody(text: string): string {
  const raw = (text || '').trim()
  if (!raw) return '(empty body)'

  if (/<!doctype html|<html[\s>]/i.test(raw)) {
    const title = raw.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim()
    const flags: string[] = []
    if (/FAIL_SYS_USER_VALIDATE|_____tmd_____|punish\?/i.test(raw)) {
      flags.push('FAIL_SYS_USER_VALIDATE/punish')
    }
    if (/aliyun_waf/i.test(raw)) flags.push('aliyun_waf')
    if (/Gateway Time-out|alibaba-ga/i.test(raw)) flags.push('gateway-timeout')
    const plain = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180)
    return [
      'HTML',
      title ? `title="${title}"` : null,
      flags.length ? flags.join(',') : null,
      plain || null,
    ]
      .filter(Boolean)
      .join(' | ')
  }

  try {
    return JSON.stringify(JSON.parse(raw)).slice(0, 400)
  } catch {
    return raw.slice(0, 400)
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  })
}
