import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeeded } from '@/lib/providers/seed'
import { hashKey } from '@/lib/openai/api-key'
import { syncRuntimeAdaptersFromDb } from '@/lib/providers/runtime'
import { isChatCapableProvider } from '@/lib/providers/chat-ready'
import { providerPublicAliases } from '@/lib/providers/aliases'

/**
 * GET /v1/models (also /api/v1/models)
 * OpenAI-compatible model list for clients (Open WebUI, Cursor, etc.).
 *
 * Only chat-capable providers are listed (builtin adapters + openai_compat
 * with apiBaseUrl). Cookie keep-alive holders (gemini, meta, …) are omitted
 * so clients do not show 0/N "working" models that can never answer.
 */
export async function GET(req: Request) {
  await ensureSeeded()
  await syncRuntimeAdaptersFromDb()

  const auth = req.headers.get('authorization') || ''
  const apiKey = auth.replace(/^Bearer\s+/i, '').trim()
  if (!apiKey) {
    return NextResponse.json(
      { error: { message: 'Missing Bearer API key', type: 'invalid_request_error' } },
      { status: 401 },
    )
  }

  const keyHash = hashKey(apiKey)
  const keyRecord = await db.apiKey.findUnique({ where: { keyHash } })
  if (!keyRecord || !keyRecord.enabled) {
    return NextResponse.json(
      {
        error: {
          message:
            'Invalid Mirage API key (sk-mg-…). Create or paste a full key from Dashboard → API Keys.',
          type: 'invalid_request_error',
        },
      },
      { status: 401 },
    )
  }

  const providers = await db.provider.findMany({
    where: { enabled: true },
    include: {
      models: { where: { enabled: true } },
      sessions: { where: { status: 'active' }, select: { id: true } },
    },
    orderBy: { key: 'asc' },
  })

  const now = Math.floor(Date.now() / 1000)

  const data = providers
    .filter((p) => isChatCapableProvider(p))
    .flatMap((p) => {
      const ready = p.sessions.length > 0
      const prefixes = [p.key, ...providerPublicAliases(p.key)]
      return p.models.flatMap((m) =>
        prefixes.map((prefix) => ({
          id: `${prefix}/${m.modelKey}`,
          object: 'model' as const,
          created: now,
          owned_by: prefix,
          permission: [],
          root: m.modelKey,
          parent: null,
          mirage: {
            provider: p.key,
            alias: prefix === p.key ? undefined : prefix,
            adapterKind: p.adapterKind,
            chatCapable: true,
            ready,
            activeSessions: p.sessions.length,
          },
        })),
      )
    })

  return NextResponse.json(
    { object: 'list', data },
    {
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    },
  )
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  })
}
