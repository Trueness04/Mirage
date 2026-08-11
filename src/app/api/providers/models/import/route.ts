import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/admin'
import { ensureSeeded } from '@/lib/providers/seed'
import { syncRuntimeAdaptersFromDb } from '@/lib/providers/runtime'
import {
  importModelsForAllActiveProviders,
  importModelsForProvider,
} from '@/lib/providers/model-import'
import '@/lib/providers'

/**
 * POST /api/providers/models/import
 * Body: { providerKey?: string } — omit to refresh all providers with active sessions.
 * Imports model catalogs from each provider's live URL/API into ProviderModel.
 */
export async function POST(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  await ensureSeeded()
  await syncRuntimeAdaptersFromDb()

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const providerKey =
    typeof body.providerKey === 'string' ? body.providerKey.trim() : ''

  if (providerKey) {
    try {
      const result = await importModelsForProvider(providerKey)
      return NextResponse.json({
        ok: result.ok,
        providerKey,
        count: result.models.length,
        source: result.source,
        error: result.error,
        models: result.models,
      })
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          providerKey,
          count: 0,
          error: (e as Error).message || 'Import crashed',
          models: [],
        },
        { status: 500 },
      )
    }
  }

  const all = await importModelsForAllActiveProviders()
  const summary = Object.entries(all.providers).map(([key, r]) => ({
    key,
    ok: r.ok,
    count: r.models.length,
    source: r.source,
    error: r.error,
  }))
  return NextResponse.json({ ok: true, providers: summary })
}
