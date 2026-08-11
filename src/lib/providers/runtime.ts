/**
 * Runtime adapter registration from DB rows.
 * Lets users add platforms from the dashboard without shipping a new adapter file.
 */

import { db } from '@/lib/db'
import { getAdapter, listAdapters } from './base'
import { createGenericAdapter, type GenericAdapterConfig } from './generic'

const registeredRuntimeKeys = new Set<string>()

/** Dedicated reverse-engineered chat adapters — never replace with generic. */
const DEDICATED_CHAT = new Set([
  'kimi',
  'zai',
  'deepseek',
  'claude',
  'qwen',
  'arena',
  'dola',
  'gemini',
  'huggingface',
])

function slugKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function normalizeProviderKey(raw: string): string {
  const s = slugKey(raw)
  if (!s) throw new Error('Provider key must contain letters or digits')
  return s
}

/** Ensure a DB-backed provider has an in-memory adapter (idempotent overwrite). */
export function ensureRuntimeAdapter(cfg: {
  key: string
  displayName: string
  websiteUrl: string
  adapterKind?: string | null
  apiBaseUrl?: string | null
  models?: Array<{
    modelKey: string
    displayName: string
    upstreamName?: string | null
    contextWindow?: number | null
    isDefault?: boolean
    supportsStream?: boolean
  }>
}): void {
  const models =
    cfg.models && cfg.models.length > 0
      ? cfg.models.map((m) => ({
          modelKey: m.modelKey,
          displayName: m.displayName,
          upstreamName: m.upstreamName || undefined,
          contextWindow: m.contextWindow ?? 128_000,
          isDefault: m.isDefault ?? false,
          supportsStream: m.supportsStream ?? true,
        }))
      : []

  const hasApi = Boolean(cfg.apiBaseUrl?.trim())
  const adapterCfg: GenericAdapterConfig = {
    key: cfg.key,
    displayName: cfg.displayName,
    websiteUrl: cfg.websiteUrl,
    adapterKind:
      cfg.adapterKind === 'openai_compat' || hasApi
        ? 'openai_compat'
        : 'cookie',
    apiBaseUrl: cfg.apiBaseUrl || undefined,
    models,
  }

  createGenericAdapter(adapterCfg)
  registeredRuntimeKeys.add(cfg.key)
}

/**
 * Sync adapters from DB.
 * Dedicated builtins keep their code adapters (not overwritten by generic).
 * Everything else is (re)registered from DB so apiBaseUrl / openai_compat
 * from live import actually enables chat — not the empty seed stub.
 */
export async function syncRuntimeAdaptersFromDb(): Promise<number> {
  const rows = await db.provider.findMany({
    include: { models: { where: { enabled: true } } },
  })
  let n = 0
  for (const p of rows) {
    if (DEDICATED_CHAT.has(p.key)) continue

    ensureRuntimeAdapter({
      key: p.key,
      displayName: p.displayName,
      websiteUrl: p.websiteUrl,
      adapterKind: p.adapterKind,
      apiBaseUrl: p.apiBaseUrl,
      models: p.models,
    })
    n++
  }
  // Touch listAdapters so tree-shaking / import order stays happy
  void listAdapters
  void getAdapter
  return n
}

export { registeredRuntimeKeys, DEDICATED_CHAT }
