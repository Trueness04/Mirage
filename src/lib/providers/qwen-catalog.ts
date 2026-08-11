/**
 * Qwen model catalog — LIVE first (chat.qwen.ai), static Free-API fallback.
 *
 * Live endpoints (same as OmniRoute qwen-web / Qwen2API):
 *   GET https://chat.qwen.ai/api/v2/models
 *   GET https://chat.qwen.ai/api/models
 *
 * Static fallback mirrors xiaoY233/Qwen-Free-API models.ts for Tongyi dialog.
 */

import type { AdapterModelSpec } from './base'

export const QWEN_DEFAULT_MODEL = 'qwen3.8-max'

const QWEN_MODELS_V2 = 'https://chat.qwen.ai/api/v2/models'
const QWEN_MODELS_V1 = 'https://chat.qwen.ai/api/models'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

/** Free-API / Tongyi dialog allowlist — used only when live fetch fails. */
export const QWEN_FREE_API_MODELS: AdapterModelSpec[] = [
  {
    modelKey: 'qwen3-235b-a22b',
    displayName: 'Qwen3-235B-A22B-2507',
    upstreamName: 'qwen3-235b-a22b',
    isDefault: true,
    supportsStream: true,
  },
  {
    modelKey: 'qwen3-coder-plus',
    displayName: 'Qwen3-Coder',
    upstreamName: 'qwen3-coder-plus',
    supportsStream: true,
  },
  {
    modelKey: 'qwen3-30b-a3b',
    displayName: 'Qwen3-30B-A3B-2507',
    upstreamName: 'qwen3-30b-a3b',
    supportsStream: true,
  },
  {
    modelKey: 'qwen3-coder-30b-a3b-instruct',
    displayName: 'Qwen3-Coder-Flash',
    upstreamName: 'qwen3-coder-30b-a3b-instruct',
    supportsStream: true,
  },
  {
    modelKey: 'qwen-max-latest',
    displayName: 'Qwen2.5-Max',
    upstreamName: 'qwen-max-latest',
    supportsStream: true,
  },
]

export function getQwenWebCatalog(): AdapterModelSpec[] {
  return QWEN_FREE_API_MODELS.map((m) => ({ ...m }))
}

export function isValidQwenWebModel(modelId: string): boolean {
  const id = stripProvider(modelId)
  if (!id) return false
  if (/^qwen/i.test(id)) return true
  return QWEN_FREE_API_MODELS.some(
    (m) => m.modelKey === id || m.upstreamName === id,
  )
}

export function resolveQwenUpstreamModel(model: string): string {
  const id = stripProvider(model)
  if (!id || id === 'qwen' || id === 'qwen-web') return QWEN_DEFAULT_MODEL
  return id
}

function stripProvider(model: string): string {
  const raw = String(model || '').trim()
  if (!raw.includes('/')) return raw
  return raw.split('/').slice(1).join('/').trim()
}

/**
 * Live model discovery — OmniRoute / Qwen2API style.
 * Optional cookie/Authorization from a captured session (public list works without).
 */
export async function importQwenLiveModels(opts?: {
  cookie?: string
  bearer?: string
}): Promise<{ models: AdapterModelSpec[]; source: string }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': UA,
    Referer: 'https://chat.qwen.ai/',
    Origin: 'https://chat.qwen.ai',
  }
  if (opts?.cookie?.trim()) headers.Cookie = opts.cookie.trim()
  if (opts?.bearer?.trim()) {
    headers.Authorization = `Bearer ${opts.bearer.replace(/^Bearer\s+/i, '').trim()}`
  }

  for (const url of [QWEN_MODELS_V2, QWEN_MODELS_V1]) {
    try {
      const models = await fetchQwenModelsUrl(url, headers)
      if (models.length) {
        return {
          models,
          source: url.includes('/v2/')
            ? 'live:chat.qwen.ai/api/v2/models'
            : 'live:chat.qwen.ai/api/models',
        }
      }
    } catch {
      // try next
    }
  }

  return { models: [], source: 'live:empty' }
}

async function fetchQwenModelsUrl(
  url: string,
  headers: Record<string, string>,
): Promise<AdapterModelSpec[]> {
  const resp = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  })
  if (!resp.ok) return []
  const text = await resp.text()
  const t = text.trimStart()
  if (!t.startsWith('{') && !t.startsWith('[')) return []
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return []
  }
  return parseQwenModelsPayload(j)
}

/** Handles OpenAI `{data:[…]}`, OmniRoute `{data:{data:[…]}}`, bare arrays. */
export function parseQwenModelsPayload(j: unknown): AdapterModelSpec[] {
  const rows = extractModelRows(j)
  const out: AdapterModelSpec[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const m = row as Record<string, unknown>
    const info =
      m.info && typeof m.info === 'object'
        ? (m.info as Record<string, unknown>)
        : null
    const meta =
      info?.meta && typeof info.meta === 'object'
        ? (info.meta as Record<string, unknown>)
        : null
    const id = String(m.id || m.name || info?.id || info?.name || '').trim()
    if (!id || seen.has(id)) continue
    if (/\.(jpe?g|png|gif|webp|svg|ico)$/i.test(id)) continue
    seen.add(id)
    const display = String(m.name || info?.name || id).trim()
    const ctx =
      typeof meta?.max_context_length === 'number'
        ? meta.max_context_length
        : typeof m.context_window === 'number'
          ? m.context_window
          : typeof m.context_length === 'number'
            ? m.context_length
            : 128_000
    out.push({
      modelKey: id.slice(0, 120),
      displayName: display || id,
      upstreamName: id,
      contextWindow: ctx > 1000 ? ctx : 128_000,
      isDefault: out.length === 0,
      supportsStream: true,
    })
  }
  return out
}

function extractModelRows(j: unknown): unknown[] {
  if (Array.isArray(j)) return j
  if (!j || typeof j !== 'object') return []
  const root = j as Record<string, unknown>
  // OmniRoute v2: { data: { data: [...] } }
  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
    const inner = root.data as Record<string, unknown>
    if (Array.isArray(inner.data)) return inner.data
    if (Array.isArray(inner.models)) return inner.models
  }
  if (Array.isArray(root.data)) return root.data
  if (Array.isArray(root.models)) return root.models
  if (Array.isArray(root.result)) return root.result
  return []
}

/** Live preferred; Free-API static appended for ids not returned live. */
export async function importQwenModelsWithFallback(opts?: {
  cookie?: string
  bearer?: string
}): Promise<{ models: AdapterModelSpec[]; source: string }> {
  const live = await importQwenLiveModels(opts)
  if (live.models.length) {
    const seen = new Set(live.models.map((m) => m.modelKey))
    const merged = [...live.models]
    for (const m of QWEN_FREE_API_MODELS) {
      if (seen.has(m.modelKey)) continue
      merged.push({ ...m, isDefault: false })
    }
    if (merged.length) merged[0] = { ...merged[0], isDefault: true }
    return { models: merged, source: live.source }
  }
  return {
    models: getQwenWebCatalog(),
    source: 'catalog:qwen-free-api-fallback',
  }
}
