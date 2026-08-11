/**
 * Z.AI SDK-backed direct route.
 * --------------------------------------------------------------------
 * TEST endpoint proving OmniRoute can route requests to a real z.ai
 * GLM model and return its real response. Uses the official
 * z-ai-web-dev-sdk to call https://internal-api.z.ai/v1/chat/completions
 * — the response is genuine, served by z.ai's web infrastructure.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeeded } from '@/lib/providers/seed'
import { hashKey } from '@/lib/openai/api-key'
import type { OpenAIChatRequest, ChatCompletionResponse } from '@/lib/providers/base'

interface ZaiSdkResponse {
  id?: string
  model?: string
  created?: number
  choices: Array<{
    index: number
    message: { role: string; content: string }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

async function callZaiSdkDirectly(
  req: OpenAIChatRequest,
  model: string,
): Promise<ZaiSdkResponse> {
  // Dynamic import — z-ai-web-dev-sdk is server-only and reads /etc/.z-ai-config
  const ZAIModule = await import('z-ai-web-dev-sdk')
  const ZAI = ZAIModule.default
  type CreateChatCompletionBody = import('z-ai-web-dev-sdk').CreateChatCompletionBody
  const zai = await ZAI.create()

  const body: CreateChatCompletionBody = {
    model,
    messages: req.messages.map((m) => ({
      role: (m.role === 'system' || m.role === 'assistant' ? m.role : 'user') as
        | 'system'
        | 'user'
        | 'assistant',
      content:
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .map((p) => (p as { text?: string }).text || '')
                .join('\n')
            : '',
    })),
    stream: false,
    thinking: { type: 'disabled' },
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
  }

  const resp = (await zai.chat.completions.create(
    body,
  )) as unknown as ZaiSdkResponse

  return resp
}

/**
 * GET /api/test/zai
 * Smoke test — calls GLM directly via the SDK and returns the raw
 * response. No auth required. Useful for sanity-checking that the SDK
 * is wired up correctly and the real GLM model responds.
 */
export async function GET() {
  await ensureSeeded()

  // Use the first live-imported Z.AI model — never a hardcoded id.
  const provider = await db.provider.findUnique({
    where: { key: 'zai' },
    include: {
      models: {
        where: { enabled: true },
        orderBy: [{ isDefault: 'desc' }, { modelKey: 'asc' }],
        take: 1,
      },
    },
  })
  const liveModel =
    provider?.models[0]?.upstreamName || provider?.models[0]?.modelKey
  if (!liveModel) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'No imported Z.AI models yet. Capture a chat.z.ai session so /api/models can sync.',
      },
      { status: 400 },
    )
  }

  const start = Date.now()
  try {
    const resp = await callZaiSdkDirectly(
      {
        model: liveModel,
        messages: [
          {
            role: 'user',
            content:
              'What model are you? Reply in EXACTLY this format on a single line: ' +
              'MODEL_NAME=<your identifier>;VENDOR=<your vendor>. No other text.',
          },
        ],
        stream: false,
      },
      liveModel,
    )
    const elapsed = Date.now() - start

    return NextResponse.json({
      ok: true,
      elapsed_ms: elapsed,
      upstream: 'z-ai-web-dev-sdk → https://internal-api.z.ai/v1/chat/completions',
      response: {
        id: resp.id,
        model: resp.model,
        created: resp.created,
        content: resp.choices?.[0]?.message?.content,
        finish_reason: resp.choices?.[0]?.finish_reason,
        usage: resp.usage,
      },
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message, elapsed_ms: Date.now() - start },
      { status: 500 },
    )
  }
}

/**
 * POST /api/test/zai
 * Authenticated route — same body shape as /v1/chat/completions but
 * always uses the z.ai SDK as the upstream. Requires an OmniRoute API
 * key in the Authorization header so we verify the auth layer works.
 */
export async function POST(req: Request) {
  await ensureSeeded()

  const auth = req.headers.get('authorization') || ''
  const apiKey = auth.replace(/^Bearer\s+/i, '').trim()
  if (!apiKey) {
    return NextResponse.json(
      { error: { message: 'Missing API key', type: 'invalid_request_error' } },
      { status: 401 },
    )
  }

  const keyHash = hashKey(apiKey)
  const keyRecord = await db.apiKey.findUnique({ where: { keyHash } })
  if (!keyRecord || !keyRecord.enabled) {
    return NextResponse.json(
      { error: { message: 'Invalid API key', type: 'invalid_request_error' } },
      { status: 401 },
    )
  }

  const body = (await req.json().catch(() => ({}))) as OpenAIChatRequest
  if (!body.model || !Array.isArray(body.messages)) {
    return NextResponse.json(
      { error: { message: 'model and messages[] required', type: 'invalid_request_error' } },
      { status: 400 },
    )
  }

  // Accept "zai/<id>" or bare upstream id from the live catalog
  const modelKey = body.model.includes('/')
    ? body.model.split('/').slice(1).join('/')
    : body.model

  const start = Date.now()
  try {
    const resp = await callZaiSdkDirectly(body, modelKey)
    const elapsed = Date.now() - start

    const openAiResponse: ChatCompletionResponse = {
      id: resp.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: resp.created || Math.floor(Date.now() / 1000),
      model: body.model,
      choices: resp.choices.map((c) => ({
        index: c.index,
        message: { role: 'assistant', content: c.message.content },
        finish_reason: c.finish_reason,
      })),
      usage: resp.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    }

    try {
      await db.requestLog.create({
        data: {
          apiKeyId: keyRecord.id,
          providerId: null,
          sessionLabel: 'zai-sdk-direct',
          model: body.model,
          endpoint: '/api/test/zai',
          method: 'POST',
          status: 200,
          upstreamStatus: 200,
          stream: false,
          durationMs: elapsed,
        },
      })
    } catch {
      // never fail on logging
    }

    return NextResponse.json(openAiResponse)
  } catch (e) {
    return NextResponse.json(
      {
        error: {
          message: `Upstream z.ai call failed: ${(e as Error).message}`,
          type: 'upstream_error',
        },
      },
      { status: 502 },
    )
  }
}
