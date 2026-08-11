/**
 * End-to-end test: prove Mirage can route a chat request to a live Z.AI model.
 *
 * Model id is NOT hardcoded — it is taken from GET /v1/models (zai/*) after
 * a real session/import, falling back to the first enabled zai model in the
 * Mirage DB via /api/dashboard when needed.
 */

import ZAI from 'z-ai-web-dev-sdk'

const PROBE_PROMPT =
  'What model are you? Reply in exactly this format on a single line: ' +
  'MODEL_NAME=<your model identifier>;VENDOR=<your vendor>. No other text.'

const BASE = process.env.MIRAGE_BASE_URL || 'http://localhost:3000'

async function resolveZaiModel(apiKey: string): Promise<{
  mirageId: string
  upstreamId: string
} | null> {
  // Prefer OpenAI-compatible catalog (live import)
  try {
    const resp = await fetch(`${BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (resp.ok) {
      const j = (await resp.json()) as {
        data?: Array<{ id?: string }>
      }
      const zai = (j.data || []).find((m) => String(m.id || '').startsWith('zai/'))
      if (zai?.id) {
        return {
          mirageId: zai.id,
          upstreamId: zai.id.slice('zai/'.length),
        }
      }
    }
  } catch {
    // fall through
  }

  // Dashboard admin list (imported ProviderModel rows)
  try {
    const resp = await fetch(`${BASE}/api/dashboard`)
    if (resp.ok) {
      const j = (await resp.json()) as {
        providers?: Array<{
          key: string
          modelsList?: Array<{ modelKey: string; upstreamName?: string }>
        }>
      }
      const zai = j.providers?.find((p) => p.key === 'zai')
      const m = zai?.modelsList?.[0]
      if (m?.modelKey) {
        return {
          mirageId: `zai/${m.modelKey}`,
          upstreamId: m.upstreamName || m.modelKey,
        }
      }
    }
  } catch {
    // fall through
  }

  return null
}

async function callDirect(upstreamId: string) {
  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  (A) DIRECT CALL via z-ai-web-dev-sdk')
  console.log('═══════════════════════════════════════════════════════')
  const zai = await ZAI.create()
  const start = Date.now()
  const resp = await zai.chat.completions.create({
    model: upstreamId,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
    thinking: { type: 'disabled' },
  })
  const elapsed = Date.now() - start
  const content = resp.choices?.[0]?.message?.content || '(no content)'
  console.log(`  ✓ Status:    success (${elapsed}ms)`)
  console.log(`  ✓ Model:     ${resp.model || 'unknown'}`)
  console.log(`  ✓ ID:        ${resp.id || 'unknown'}`)
  console.log(`  ✓ Response:  `)
  console.log('     ' + content.split('\n').join('\n     '))
  console.log(`  ✓ Usage:     ${JSON.stringify(resp.usage || {})}`)
  return { ok: true, content, model: resp.model, id: resp.id, elapsed }
}

async function callMirage(apiKey: string, mirageModelId: string) {
  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  (B) MIRAGE CALL via /v1/chat/completions')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  Using live model: ${mirageModelId}`)
  const start = Date.now()
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: mirageModelId,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      stream: false,
    }),
  })
  const elapsed = Date.now() - start
  const data = await resp.json()
  if (!resp.ok) {
    console.log(`  ✗ HTTP ${resp.status}`)
    console.log('  ✗ Body:', JSON.stringify(data, null, 2).split('\n').join('\n  '))
    return { ok: false, elapsed }
  }
  const content = data.choices?.[0]?.message?.content || '(no content)'
  console.log(`  ✓ Status:    HTTP ${resp.status} (${elapsed}ms)`)
  console.log(`  ✓ Model:     ${data.model || 'unknown'}`)
  console.log(`  ✓ ID:        ${data.id || 'unknown'}`)
  console.log(`  ✓ Object:    ${data.object}`)
  console.log(`  ✓ Response:  `)
  console.log('     ' + content.split('\n').join('\n     '))
  console.log(`  ✓ Usage:     ${JSON.stringify(data.usage || {})}`)
  return { ok: true, content, model: data.model, id: data.id, elapsed }
}

async function main() {
  console.log('Mirage End-to-End Verification')
  console.log('Model id is resolved from live /v1/models (not hardcoded).')
  console.log()

  let apiKey = process.env.MIRAGE_API_KEY || ''
  if (!apiKey) {
    try {
      const r = await fetch(`${BASE}/api/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'E2E Test' }),
      })
      if (r.ok) {
        const j = await r.json()
        apiKey = j.key
        console.log(`[setup] Generated test API key: ${apiKey.slice(0, 16)}…`)
      }
    } catch (e) {
      console.log('[setup] Failed to create API key:', e)
    }
  }

  if (!apiKey) {
    console.log('✗ No API key — set MIRAGE_API_KEY or start Mirage with /api/keys')
    process.exit(1)
  }

  const resolved = await resolveZaiModel(apiKey)
  if (!resolved) {
    console.log(
      '✗ No live zai/* model in /v1/models. Capture a Z.AI session so models import first.',
    )
    process.exit(1)
  }
  console.log(`[setup] Live Z.AI model: ${resolved.mirageId} (upstream ${resolved.upstreamId})`)

  const direct = await callDirect(resolved.upstreamId).catch((e) => {
    console.log('  ✗ Direct call failed:', e.message)
    return { ok: false, error: e.message, content: '' }
  })

  const routed = await callMirage(apiKey, resolved.mirageId).catch((e) => {
    console.log('  ✗ Mirage call failed:', e.message)
    return { ok: false, error: e.message, content: '' }
  })

  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  VERDICT')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  Direct (z.ai SDK):     ${direct.ok ? '✓ PASS' : '✗ FAIL'}`)
  console.log(`  Routed (Mirage /v1/*): ${routed.ok ? '✓ PASS' : '✗ FAIL'}`)
  console.log()
}

main()
