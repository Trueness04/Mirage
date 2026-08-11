/**
 * Live model import from provider URLs / APIs → ProviderModel rows.
 * Never invents "default" placeholders when a real list is available.
 */

import { db } from '@/lib/db'
import { getAdapter, type CookieJarEntry } from './base'
import { resolveProviderAlias } from './aliases'
import { loadSessionContext } from './session-loader'
export interface ImportedModel {
  modelKey: string
  displayName: string
  upstreamName?: string
  contextWindow?: number
  isDefault?: boolean
}

export interface ImportModelsResult {
  ok: boolean
  source?: string
  models: ImportedModel[]
  error?: string
}

function isJsonResponse(resp: Response, text: string): boolean {
  const ct = resp.headers.get('content-type') || ''
  if (ct.includes('application/json')) return true
  const t = text.trimStart()
  return t.startsWith('{') || t.startsWith('[')
}

function parseOpenAIModelsPayload(j: unknown): ImportedModel[] {
  // HuggingChat /chat/api/models returns a bare JSON array
  if (Array.isArray(j)) return parseOpenAIModelsPayload({ data: j })
  if (!j || typeof j !== 'object') return []
  const root = j as Record<string, unknown>
  // HuggingChat v2 wraps as { json: [...] }; OpenAI as { data: [...] }
  const arr = (root.data ||
    root.models ||
    root.result ||
    root.items ||
    root.json) as unknown
  if (!Array.isArray(arr)) return []
  const out: ImportedModel[] = []
  for (const item of arr) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ modelKey: item.trim(), displayName: item.trim(), upstreamName: item.trim() })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    const id = String(m.id || m.model || m.name || m.model_name || '').trim()
    if (!id) continue
    if (/\.(jpe?g|png|gif|webp|svg|ico)$/i.test(id)) continue
    const info =
      m.info && typeof m.info === 'object'
        ? (m.info as Record<string, unknown>)
        : null
    const display = String(
      m.display_name ||
        m.displayName ||
        m.name ||
        info?.name ||
        m.title ||
        id,
    ).trim()
    // Keep slashes for org/model ids (Hugging Face)
    out.push({
      modelKey: sanitizeModelKey(id),
      displayName: display || id,
      upstreamName: id,
      contextWindow:
        typeof m.context_window === 'number'
          ? m.context_window
          : typeof m.context_length === 'number'
            ? m.context_length
            : undefined,
    })
  }
  return out
}

function sanitizeModelKey(id: string): string {
  // Keep OpenAI-style ids (gpt-4o, claude-sonnet-5, provider/model)
  return id.trim().slice(0, 120)
}

function bearerCandidates(session: {
  accessToken?: string | null
  cookies: CookieJarEntry[]
}): string[] {
  const out: string[] = []
  if (session.accessToken?.trim()) {
    out.push(session.accessToken.replace(/^Bearer\s+/i, '').trim())
  }
  for (const name of [
    '_token',
    'token',
    'access_token',
    'accessToken',
    'userToken',
    'auth_token',
    'api_key',
  ]) {
    const c = session.cookies.find(
      (x) => x.name.toLowerCase() === name.toLowerCase(),
    )
    if (c?.value?.trim()) {
      let v = c.value.trim()
      // unwrap localStorage JSON
      if (v.startsWith('{')) {
        try {
          const j = JSON.parse(v) as { value?: string }
          if (typeof j.value === 'string') v = j.value
        } catch {
          // keep
        }
      }
      out.push(v.replace(/^Bearer\s+/i, ''))
    }
  }
  return Array.from(new Set(out.filter(Boolean)))
}

function apiBaseCandidates(provider: {
  apiBaseUrl?: string | null
  websiteUrl: string
}): string[] {
  const out: string[] = []
  if (provider.apiBaseUrl) out.push(provider.apiBaseUrl.replace(/\/+$/, ''))
  try {
    const u = new URL(provider.websiteUrl)
    // Prefer paths that real web UIs expose (Z.AI: /api/models, HF: /chat/api)
    out.push(`${u.origin}/api`)
    out.push(`${u.origin}/chat/api/v2`)
    out.push(`${u.origin}/chat/api`)
    out.push(`${u.origin}/v1`)
    out.push(`${u.origin}/api/v1`)
    out.push(`${u.origin}/api/openai/v1`)
    out.push(`${u.origin}/api/paas/v4`)
    out.push(`${u.origin}/backend/v1`)
    out.push(`${u.origin}/backend-api/v2`)
    // Hugging Face Inference router (separate host from huggingface.co/chat)
    // HuggingChat is cookie/web (hf-chat), not router.huggingface.co — skip.
    if (u.hostname === 'venice.ai' || u.hostname.endsWith('.venice.ai')) {
      // Website /api/v1/models may list models; chat lives on api.venice.ai.
      out.unshift('https://api.venice.ai/api/v1')
    }
  } catch {
    // ignore
  }
  return Array.from(new Set(out))
}

/** Cap huge OpenAI /models dumps (e.g. HF router) so sync cannot hang the server. */
const MAX_IMPORT_MODELS = 80

/** Persist imported models; disable stale rows not in the live list. */
export async function syncImportedModelsToDb(
  providerId: string,
  models: ImportedModel[],
  opts?: { disableMissing?: boolean },
): Promise<void> {
  if (!models.length) return
  const disableMissing = opts?.disableMissing !== false
  const capped = models.slice(0, MAX_IMPORT_MODELS)
  const keep = new Set(capped.map((m) => m.modelKey))

  const defaultKey =
    capped.find((m) => m.isDefault)?.modelKey || capped[0]?.modelKey
  for (const m of capped) {
    const isDefault = m.modelKey === defaultKey
    await db.providerModel.upsert({
      where: {
        providerId_modelKey: { providerId, modelKey: m.modelKey },
      },
      update: {
        displayName: m.displayName,
        upstreamName: m.upstreamName || m.modelKey,
        enabled: true,
        isDefault,
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      },
      create: {
        providerId,
        modelKey: m.modelKey,
        displayName: m.displayName,
        upstreamName: m.upstreamName || m.modelKey,
        enabled: true,
        isDefault,
        contextWindow: m.contextWindow ?? 128000,
        supportsStream: true,
      },
    })
  }

  if (disableMissing) {
    await db.providerModel.updateMany({
      where: {
        providerId,
        modelKey: { notIn: [...keep] },
      },
      data: { enabled: false, isDefault: false },
    })
  }
}

/** Fetch OpenAI-compatible /models using session credentials. */
export async function fetchOpenAICompatibleModels(opts: {
  apiBaseUrl?: string | null
  websiteUrl: string
  accessToken?: string | null
  cookies: CookieJarEntry[]
}): Promise<ImportModelsResult> {
  const bases = apiBaseCandidates(opts)
  const tokens = bearerCandidates(opts)
  const cookieStr = opts.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  const errors: string[] = []

  for (const base of bases) {
    const headerVariants: Record<string, string>[] = []
    if (tokens.length === 0) {
      headerVariants.push({})
    } else {
      for (const t of tokens) headerVariants.push({ Authorization: `Bearer ${t}` })
    }

    for (const auth of headerVariants) {
      try {
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Origin: opts.websiteUrl,
          Referer: opts.websiteUrl.replace(/\/?$/, '/'),
          ...auth,
        }
        if (cookieStr) headers.Cookie = cookieStr

        const resp = await fetch(`${base}/models`, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(15_000),
        })
        const text = await resp.text()
        if (!resp.ok) {
          errors.push(`${base}/models → ${resp.status}`)
          continue
        }
        if (!isJsonResponse(resp, text)) {
          errors.push(`${base}/models → non-JSON`)
          continue
        }
        const models = parseOpenAIModelsPayload(JSON.parse(text))
        if (models.length === 0) {
          errors.push(`${base}/models → empty list`)
          continue
        }
        return { ok: true, source: `${base}/models`, models }
      } catch (e) {
        errors.push(`${base}/models → ${(e as Error).message}`)
      }
    }
  }

  return {
    ok: false,
    models: [],
    error: errors.slice(0, 6).join('; ') || 'No /models endpoint returned JSON',
  }
}

/**
 * Import models for one provider using its active session + adapter/API.
 * Writes into ProviderModel.
 */
export async function importModelsForProvider(
  providerKeyRaw: string,
): Promise<ImportModelsResult> {
  const providerKey = resolveProviderAlias(providerKeyRaw)
  const provider = await db.provider.findUnique({
    where: { key: providerKey },
    include: {
      sessions: {
        // Include soft-failed jars (status error with cookies) so Import
        // does not die with "No active session" when ping flipped status.
        where: { status: { in: ['active', 'error', 'refreshing'] } },
        orderBy: [
          { priority: 'asc' },
          { lastPingAt: 'desc' },
          { lastRefreshAt: 'desc' },
        ],
        take: 5,
      },
    },
  })
  if (!provider) return { ok: false, models: [], error: 'Provider not found' }

  // HuggingChat: NEVER route to router.huggingface.co (that wants hf_ API tokens).
  // Use hf-chat cookie + /chat/api/v2/models (OmniRoute huggingchat).
  if (providerKey === 'huggingface') {
    const {
      getHuggingChatCatalog,
      importHuggingChatModels,
    } = await import('./huggingchat')
    // Demote mistaken openai_compat/router wiring from older imports.
    if (
      provider.adapterKind === 'openai_compat' ||
      /router\.huggingface\.co/i.test(provider.apiBaseUrl || '')
    ) {
      await db.provider.update({
        where: { id: provider.id },
        data: { adapterKind: 'builtin', apiBaseUrl: null },
      })
    }
    for (const session of provider.sessions) {
      const loaded = await loadSessionContext(session.id)
      if (!loaded) continue
      const cookie =
        loaded.ctx.cookies.map((c) => `${c.name}=${c.value}`).join('; ') ||
        (loaded.ctx.accessToken ? `hf-chat=${loaded.ctx.accessToken}` : '')
      if (!/hf-chat=/i.test(cookie)) continue
      try {
        const live = await importHuggingChatModels(cookie)
        if (!live.length) continue
        await syncImportedModelsToDb(
          provider.id,
          live.map((m) => ({
            modelKey: m.modelKey,
            displayName: m.displayName,
            upstreamName: m.upstreamName || m.modelKey,
            contextWindow: m.contextWindow,
            isDefault: m.isDefault,
          })),
        )
        return {
          ok: true,
          source: 'huggingchat:/chat/api/v2/models',
          models: live.map((m) => ({
            modelKey: m.modelKey,
            displayName: m.displayName,
            upstreamName: m.upstreamName || m.modelKey,
            contextWindow: m.contextWindow,
            isDefault: m.isDefault,
          })),
        }
      } catch {
        // next session
      }
    }
    const catalog = getHuggingChatCatalog()
    await syncImportedModelsToDb(
      provider.id,
      catalog.map((m) => ({
        modelKey: m.modelKey,
        displayName: m.displayName,
        upstreamName: m.upstreamName || m.modelKey,
        contextWindow: m.contextWindow,
        isDefault: m.isDefault,
      })),
    )
    return {
      ok: true,
      source: 'catalog:omniroute-huggingchat',
      models: catalog.map((m) => ({
        modelKey: m.modelKey,
        displayName: m.displayName,
        upstreamName: m.upstreamName || m.modelKey,
        contextWindow: m.contextWindow,
        isDefault: m.isDefault,
      })),
    }
  }

  // Qwen: LIVE chat.qwen.ai /api/v2/models (+ /api/models), Free-API static fallback.
  if (providerKey === 'qwen') {
    if (
      provider.adapterKind === 'openai_compat' ||
      provider.apiBaseUrl?.trim()
    ) {
      await db.provider.update({
        where: { id: provider.id },
        data: { adapterKind: 'builtin', apiBaseUrl: null },
      })
    }
    const { importQwenModelsWithFallback } = await import('./qwen-catalog')
    let cookie = ''
    let bearer = ''
    for (const session of provider.sessions) {
      const loaded = await loadSessionContext(session.id)
      if (!loaded) continue
      cookie =
        loaded.ctx.cookies.map((c) => `${c.name}=${c.value}`).join('; ') ||
        cookie
      if (loaded.ctx.accessToken?.trim()) {
        bearer = loaded.ctx.accessToken.trim()
        break
      }
    }
    const { models: catalog, source } = await importQwenModelsWithFallback({
      cookie: cookie || undefined,
      bearer: bearer || undefined,
    })
    const models = catalog.map((m) => ({
      modelKey: m.modelKey,
      displayName: m.displayName,
      upstreamName: m.upstreamName || m.modelKey,
      contextWindow: m.contextWindow,
      isDefault: m.isDefault,
    }))
    await syncImportedModelsToDb(provider.id, models)
    return {
      ok: true,
      source,
      models,
    }
  }

  // Kimi web: allowlist catalog (+ live discovery when possible).
  if (providerKey === 'kimi') {
    const { getKimiWebCatalog, resolveKimiUpstreamModel } = await import('./kimi')
    const { getAdapter } = await import('./base')
    const adapter = getAdapter('kimi')
    const errors: string[] = []
    for (const session of provider.sessions) {
      const loaded = await loadSessionContext(session.id)
      if (!loaded || !adapter) continue
      try {
        const v = await adapter.validate(loaded.ctx)
        if (v.valid && v.detectedModels?.length) {
          const models = v.detectedModels.map((id) => {
            const upstream = resolveKimiUpstreamModel(id)
            return {
              modelKey: sanitizeModelKey(id),
              displayName: id,
              upstreamName: upstream,
              contextWindow: 256_000,
              isDefault: upstream === 'k2',
            }
          })
          await syncImportedModelsToDb(provider.id, models)
          return {
            ok: true,
            source: 'adapter:kimi',
            models,
          }
        }
        if (v.reason) errors.push(v.reason)
      } catch (e) {
        errors.push((e as Error).message)
      }
    }
    const catalog = getKimiWebCatalog()
    await syncImportedModelsToDb(
      provider.id,
      catalog.map((m) => ({
        modelKey: m.modelKey,
        displayName: m.displayName,
        upstreamName: resolveKimiUpstreamModel(m.upstreamName || m.modelKey),
        contextWindow: m.contextWindow,
        isDefault: m.isDefault,
      })),
    )
    return {
      ok: true,
      source: 'catalog:kimi-web-allowlist',
      models: catalog.map((m) => ({
        modelKey: m.modelKey,
        displayName: m.displayName,
        upstreamName: resolveKimiUpstreamModel(m.upstreamName || m.modelKey),
        contextWindow: m.contextWindow,
        isDefault: m.isDefault,
      })),
      ...(errors.length ? { error: errors[0] } : {}),
    }
  }

  // Claude web: OmniRoute cw / claude-web static catalog (same as ds-web pattern).
  // Live bootstrap may be Cloudflare-blocked from Node; Validate refreshes via browser.
  if (providerKey === 'claude') {
    const { getClaudeWebCatalog } = await import('./claude')
    const catalog = getClaudeWebCatalog()
    await syncImportedModelsToDb(
      provider.id,
      catalog.map((m) => ({
        modelKey: m.modelKey,
        displayName: m.displayName,
        upstreamName: m.upstreamName || m.modelKey,
        contextWindow: m.contextWindow,
        isDefault: m.isDefault,
      })),
    )
    return {
      ok: true,
      source: 'catalog:omniroute-claude-web',
      models: catalog.map((m) => ({
        modelKey: m.modelKey,
        displayName: m.displayName,
        upstreamName: m.upstreamName || m.modelKey,
        contextWindow: m.contextWindow,
        isDefault: m.isDefault,
      })),
    }
  }

  // DeepSeek web: OmniRoute-style static catalog (ds-web), not Instant/Expert scrape.
  if (providerKey === 'deepseek') {
    const { getDeepSeekWebCatalog, importDeepSeekLiveModels } = await import(
      './deepseek'
    )
    // Prefer validating with a live session; catalog itself is static.
    if (provider.sessions.length === 0) {
      const catalog = getDeepSeekWebCatalog()
      await syncImportedModelsToDb(
        provider.id,
        catalog.map((m) => ({
          modelKey: m.modelKey,
          displayName: m.displayName,
          upstreamName: m.upstreamName || m.modelKey,
          contextWindow: m.contextWindow,
          isDefault: m.isDefault,
        })),
      )
      return {
        ok: true,
        source: 'catalog:omniroute-deepseek-web',
        models: catalog.map((m) => ({
          modelKey: m.modelKey,
          displayName: m.displayName,
          upstreamName: m.upstreamName || m.modelKey,
          contextWindow: m.contextWindow,
          isDefault: m.isDefault,
        })),
      }
    }
    for (const session of provider.sessions) {
      const loaded = await loadSessionContext(session.id)
      if (!loaded) continue
      try {
        const catalog = await importDeepSeekLiveModels(loaded.ctx)
        if (!catalog.length) continue
        const models = catalog.map((m) => ({
          modelKey: m.modelKey,
          displayName: m.displayName,
          upstreamName: m.upstreamName || m.modelKey,
          contextWindow: m.contextWindow,
          isDefault: m.isDefault,
        }))
        await syncImportedModelsToDb(provider.id, models)
        return {
          ok: true,
          source: 'catalog:omniroute-deepseek-web',
          models,
        }
      } catch {
        // try next session
      }
    }
    // Token may be dead — still write the static catalog so UI matches ds-web.
    const catalog = getDeepSeekWebCatalog()
    await syncImportedModelsToDb(
      provider.id,
      catalog.map((m) => ({
        modelKey: m.modelKey,
        displayName: m.displayName,
        upstreamName: m.upstreamName || m.modelKey,
        contextWindow: m.contextWindow,
        isDefault: m.isDefault,
      })),
    )
    return {
      ok: true,
      source: 'catalog:omniroute-deepseek-web',
      models: catalog.map((m) => ({
        modelKey: m.modelKey,
        displayName: m.displayName,
        upstreamName: m.upstreamName || m.modelKey,
        contextWindow: m.contextWindow,
        isDefault: m.isDefault,
      })),
    }
  }

  // Catalogs that do not need an active session (static or public HTML).
  if (providerKey === 'dola') {
    try {
      const { getDolaCatalog } = await import('./dola')
      const catalog = getDolaCatalog()
      await syncImportedModelsToDb(
        provider.id,
        catalog.map((m) => ({
          modelKey: m.modelKey,
          displayName: m.displayName,
          upstreamName: m.upstreamName || m.modelKey,
          contextWindow: m.contextWindow,
        })),
      )
      return {
        ok: true,
        source: 'catalog:dola',
        models: catalog.map((m) => ({
          modelKey: m.modelKey,
          displayName: m.displayName,
          upstreamName: m.upstreamName || m.modelKey,
          contextWindow: m.contextWindow,
        })),
      }
    } catch (e) {
      return { ok: false, models: [], error: (e as Error).message }
    }
  }
  if (providerKey === 'gemini') {
    try {
      const { getGeminiCatalog } = await import('./gemini')
      const catalog = getGeminiCatalog()
      await syncImportedModelsToDb(
        provider.id,
        catalog.map((m) => ({
          modelKey: m.modelKey,
          displayName: m.displayName,
          upstreamName: m.upstreamName || m.modelKey,
          contextWindow: m.contextWindow,
        })),
      )
      return {
        ok: true,
        source: 'catalog:gemini-web',
        models: catalog.map((m) => ({
          modelKey: m.modelKey,
          displayName: m.displayName,
          upstreamName: m.upstreamName || m.modelKey,
          contextWindow: m.contextWindow,
        })),
      }
    } catch (e) {
      return { ok: false, models: [], error: (e as Error).message }
    }
  }

  if (provider.sessions.length === 0) {
    // Arena catalog is public HTML — still import without a login session.
    if (providerKey === 'arena') {
      try {
        const { scrapeArenaModels } = await import('./arena')
        const scraped = await scrapeArenaModels([])
        if (scraped.length) {
          await syncImportedModelsToDb(
            provider.id,
            scraped.map((m) => ({
              modelKey: m.modelKey,
              displayName: m.displayName,
              upstreamName: m.upstreamName || m.modelKey,
              contextWindow: m.contextWindow,
            })),
          )
          return {
            ok: true,
            source: 'html:arena.ai/text/direct',
            models: scraped.map((m) => ({
              modelKey: m.modelKey,
              displayName: m.displayName,
              upstreamName: m.upstreamName || m.modelKey,
              contextWindow: m.contextWindow,
            })),
          }
        }
      } catch (e) {
        return {
          ok: false,
          models: [],
          error: (e as Error).message,
        }
      }
    }
    return {
      ok: false,
      models: [],
      error:
        'No active session — capture login first, then models can be imported from the API',
    }
  }

  // 0) Arena HTML catalog (when a session exists — also works without above)
  if (providerKey === 'arena') {
    try {
      const { scrapeArenaModels } = await import('./arena')
      let cookies: CookieJarEntry[] = []
      try {
        cookies = JSON.parse(provider.sessions[0].cookies || '[]')
      } catch {
        cookies = []
      }
      const scraped = await scrapeArenaModels(cookies)
      if (scraped.length) {
        await syncImportedModelsToDb(
          provider.id,
          scraped.map((m) => ({
            modelKey: m.modelKey,
            displayName: m.displayName,
            upstreamName: m.upstreamName || m.modelKey,
            contextWindow: m.contextWindow,
          })),
        )
        return {
          ok: true,
          source: 'html:arena.ai/text/direct',
          models: scraped.map((m) => ({
            modelKey: m.modelKey,
            displayName: m.displayName,
            upstreamName: m.upstreamName || m.modelKey,
            contextWindow: m.contextWindow,
          })),
        }
      }
      return {
        ok: false,
        models: [],
        error:
          'Arena scrape returned 0 models — open https://arena.ai/text/direct and retry Import',
      }
    } catch (e) {
      return { ok: false, models: [], error: (e as Error).message }
    }
  }

  // 1) Always try OpenAI-compatible /models on the provider URL first
  for (const session of provider.sessions) {
    let cookies: CookieJarEntry[] = []
    try {
      cookies = JSON.parse(session.cookies || '[]')
    } catch {
      cookies = []
    }
    const live = await fetchOpenAICompatibleModels({
      apiBaseUrl: provider.apiBaseUrl,
      websiteUrl: provider.websiteUrl,
      accessToken: session.accessToken,
      cookies,
    })
    if (live.ok && live.models.length) {
      await syncImportedModelsToDb(provider.id, live.models)
      if (live.source?.endsWith('/models')) {
        let base = live.source.slice(0, -'/models'.length)
        // Prefer chat-capable hosts when the catalog host has no /chat/completions.
        if (/^https?:\/\/(www\.)?venice\.ai\//i.test(base)) {
          base = 'https://api.venice.ai/api/v1'
        }
        // Never auto-wire HuggingChat sessions to Inference Router.
        const isHfRouter =
          /huggingface\.co/i.test(base) || /router\.huggingface\.co/i.test(base)
        if (!isHfRouter && base && base !== provider.apiBaseUrl) {
          await db.provider.update({
            where: { id: provider.id },
            data: {
              apiBaseUrl: base,
              adapterKind:
                provider.adapterKind === 'builtin'
                  ? provider.adapterKind
                  : 'openai_compat',
            },
          })
        }
      }
      return live
    }
  }

  // 2) Adapter validate that performs live discovery (e.g. Claude bootstrap)
  const adapter = getAdapter(provider.key)
  for (const session of provider.sessions) {
    const loaded = await loadSessionContext(session.id)
    if (!loaded || !adapter) continue
    try {
      const v = await adapter.validate(loaded.ctx)
      if (v.valid && v.detectedModels?.length) {
        // Prefer richer specs when adapter already synced (e.g. Claude bootstrap names)
        const existing = await db.providerModel.findMany({
          where: {
            providerId: provider.id,
            enabled: true,
            modelKey: { in: v.detectedModels.map(sanitizeModelKey) },
          },
        })
        if (existing.length >= v.detectedModels.length) {
          const models = existing.map((m) => ({
            modelKey: m.modelKey,
            displayName: m.displayName,
            upstreamName: m.upstreamName || m.modelKey,
          }))
          return {
            ok: true,
            source: `adapter:${provider.key}`,
            models,
          }
        }
        const models: ImportedModel[] = v.detectedModels
          .filter((id) => Boolean(id && String(id).trim()))
          .map((id) => ({
            modelKey: sanitizeModelKey(id),
            displayName: id,
            upstreamName: id,
          }))
        if (!models.length) continue
        await syncImportedModelsToDb(provider.id, models)
        return {
          ok: true,
          source: `adapter:${provider.key}`,
          models,
        }
      }
    } catch {
      // next session
    }
  }

  return {
    ok: false,
    models: [],
    error: provider.sessions.length
      ? `Could not import models for ${providerKey}: session present but live API/catalog failed. Capture again or check tokens.`
      : `Could not import models for ${providerKey}: no session. Capture login first (builtins like kimi/qwen/claude use web catalogs after capture).`,
  }
}

/** Refresh models for all enabled providers that have an active session. */
export async function importModelsForAllActiveProviders(): Promise<{
  providers: Record<string, ImportModelsResult>
}> {
  const providers = await db.provider.findMany({
    where: {
      enabled: true,
      OR: [
        { sessions: { some: { status: { in: ['active', 'error', 'refreshing'] } } } },
        // Public/static catalogs (arena/dola/gemini) import without a session.
        {
          key: {
            in: [
              'arena',
              'dola',
              'gemini',
              'claude',
              'deepseek',
              'kimi',
              'qwen',
              'huggingface',
            ],
          },
        },
      ],
    },
    select: { key: true },
  })
  const out: Record<string, ImportModelsResult> = {}
  for (const p of providers) {
    out[p.key] = await importModelsForProvider(p.key)
  }
  return { providers: out }
}

export async function applyDetectedModels(
  providerId: string,
  detected: string[] | undefined,
): Promise<void> {
  if (!detected?.length) return
  const provider = await db.provider.findUnique({
    where: { id: providerId },
    select: { key: true },
  })
  // DeepSeek catalog must come from model_configs (switchable only) —
  // never materialize Vision / raw model_type rows from detectedModels.
  if (provider?.key === 'deepseek') return

  const cleaned = detected.filter((d) => Boolean(d && String(d).trim()))
  if (!cleaned.length) return
  await syncImportedModelsToDb(
    providerId,
    cleaned.map((id) => ({
      modelKey: sanitizeModelKey(id),
      displayName: id,
      upstreamName: id,
    })),
  )
}
