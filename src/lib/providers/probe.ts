/**
 * Probe a candidate AI platform URL before registering it.
 * Checks website reachability and optional OpenAI-compatible /models + /chat/completions.
 */

import { browserHeaders } from './base'

export interface ProbeResult {
  ok: boolean
  websiteReachable: boolean
  websiteStatus?: number
  openaiCompat: boolean
  modelsEndpoint?: 'ok' | 'missing' | 'unauthorized' | 'error'
  detectedModels: string[]
  suggestedApiBaseUrl?: string
  error?: string
  hints: string[]
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function candidatesFromWebsite(websiteUrl: string, apiBaseUrl?: string): string[] {
  const out: string[] = []
  if (apiBaseUrl) out.push(normalizeBase(apiBaseUrl))
  try {
    const u = new URL(websiteUrl)
    out.push(`${u.origin}/v1`)
    out.push(`${u.origin}/api/v1`)
    out.push(`${websiteUrl.replace(/\/+$/, '')}/v1`)
  } catch {
    // ignore
  }
  return Array.from(new Set(out))
}

export async function probePlatform(opts: {
  websiteUrl: string
  apiBaseUrl?: string
}): Promise<ProbeResult> {
  const hints: string[] = []
  let websiteReachable = false
  let websiteStatus: number | undefined

  const timeoutSignal = (ms: number) => {
    if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
      return AbortSignal.timeout(ms)
    }
    const c = new AbortController()
    setTimeout(() => c.abort(), ms)
    return c.signal
  }

  try {
    const resp = await fetch(opts.websiteUrl, {
      method: 'GET',
      headers: { ...browserHeaders(), Accept: 'text/html,application/json' },
      redirect: 'follow',
      signal: timeoutSignal(12_000),
    })
    websiteStatus = resp.status
    websiteReachable = resp.status < 500
    if (!websiteReachable) {
      return {
        ok: false,
        websiteReachable: false,
        websiteStatus,
        openaiCompat: false,
        detectedModels: [],
        error: `Website returned ${resp.status}`,
        hints: ['Check the URL and try again.'],
      }
    }
  } catch (e) {
    return {
      ok: false,
      websiteReachable: false,
      openaiCompat: false,
      detectedModels: [],
      error: (e as Error).message,
      hints: ['URL must be publicly reachable from the Mirage server.'],
    }
  }

  const bases = candidatesFromWebsite(opts.websiteUrl, opts.apiBaseUrl)
  let openaiCompat = false
  let modelsEndpoint: ProbeResult['modelsEndpoint']
  let detectedModels: string[] = []
  let suggestedApiBaseUrl: string | undefined

  for (const base of bases) {
    try {
      const resp = await fetch(`${base}/models`, {
        headers: {
          ...browserHeaders(),
          Accept: 'application/json',
        },
        signal: timeoutSignal(10_000),
      })
      if (resp.ok) {
        const text = await resp.text()
        const looksJson =
          text.trimStart().startsWith('{') || text.trimStart().startsWith('[')
        if (!looksJson) {
          // SPA sites often return HTML 200 for /v1/models — that is NOT OpenAI-compat.
          hints.push(
            `${base}/models returned HTML (not JSON) — not a real OpenAI /models endpoint.`,
          )
          continue
        }
        try {
          const j = JSON.parse(text) as {
            data?: Array<{ id?: string }>
            models?: Array<{ id?: string }>
          }
          detectedModels = (j.data || j.models || [])
            .map((m) => m.id)
            .filter((id): id is string => Boolean(id))
            .slice(0, 30)
        } catch {
          hints.push(`${base}/models was not valid JSON`)
          continue
        }
        openaiCompat = true
        modelsEndpoint = 'ok'
        suggestedApiBaseUrl = base
        hints.push(`OpenAI-compatible /models found at ${base}/models`)
        break
      }
      if (resp.status === 401 || resp.status === 403) {
        openaiCompat = true
        modelsEndpoint = 'unauthorized'
        suggestedApiBaseUrl = base
        hints.push(
          `${base}/models needs auth — capture a login with the extension, then chat will work.`,
        )
        break
      }
      if (resp.status === 404) {
        modelsEndpoint = modelsEndpoint || 'missing'
        suggestedApiBaseUrl = suggestedApiBaseUrl || base
        hints.push(
          `${base}/models missing — you can still add the platform and enter Model IDs manually.`,
        )
      }
    } catch {
      modelsEndpoint = modelsEndpoint || 'error'
    }
  }

  // If /models is missing but user gave an API base, probe /chat/completions
  // with a tiny request so OpenAI-compat gateways without /models still pass.
  if (!openaiCompat && opts.apiBaseUrl) {
    const base = normalizeBase(opts.apiBaseUrl)
    try {
      const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          ...browserHeaders(),
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: timeoutSignal(12_000),
      })
      // 401/403/400 all prove the route exists (auth/model errors ≠ missing route)
      if (resp.status !== 404 && resp.status < 500) {
        openaiCompat = true
        modelsEndpoint = modelsEndpoint || 'missing'
        suggestedApiBaseUrl = base
        hints.push(
          `${base}/chat/completions responds (${resp.status}) — /models missing is OK; enter Model IDs manually when connecting.`,
        )
      }
    } catch {
      // ignore
    }
  }

  if (!openaiCompat && suggestedApiBaseUrl) {
    if (opts.apiBaseUrl) {
      openaiCompat = true
      hints.push('Using your API Base URL even though /models was not found.')
    }
  }

  if (!openaiCompat) {
    hints.push(
      'No OpenAI-compatible API detected. Platform will be added as a cookie session holder; implement a dedicated adapter later for chat, or paste an API Base URL (/v1).',
    )
  }

  return {
    ok: websiteReachable,
    websiteReachable,
    websiteStatus,
    openaiCompat,
    modelsEndpoint,
    detectedModels,
    suggestedApiBaseUrl,
    hints,
  }
}
