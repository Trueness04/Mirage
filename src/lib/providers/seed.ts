/**
 * Seeds the DB with built-in provider definitions + model catalog.
 * Called on dashboard/extension requests. Safe to call repeatedly.
 * Never overwrites user-added platforms (only the known built-in keys).
 * Honors AppSetting skipBuiltinSeed after a full provider wipe.
 */

import { db } from '@/lib/db'
import { getProviderSeedSpecs } from '@/lib/providers'
import { syncRuntimeAdaptersFromDb } from '@/lib/providers/runtime'

const BUILTIN_KEYS = new Set([
  'kimi',
  'zai',
  'deepseek',
  'claude',
  'gemini',
  'qwen',
  'arena',
  'huggingface',
  'dola',
  'venice',
  't3',
  'meta',
])

const BUILTIN_CHAT = new Set([
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

const SKIP_SEED_KEY = 'skipBuiltinSeed'
const DELETED_BUILTINS_KEY = 'deletedBuiltins'

const globalSeed = globalThis as unknown as {
  __mirageSeedAt?: number
  __mirageSeedPromise?: Promise<void>
}

/** Re-run cleanup at most this often (dashboard polls every few seconds). */
const SEED_TTL_MS = 60_000

export async function ensureSeeded() {
  const now = Date.now()
  if (
    globalSeed.__mirageSeedAt &&
    now - globalSeed.__mirageSeedAt < SEED_TTL_MS
  ) {
    return
  }
  if (globalSeed.__mirageSeedPromise) {
    await globalSeed.__mirageSeedPromise
    return
  }

  globalSeed.__mirageSeedPromise = runSeed()
    .then(() => {
      globalSeed.__mirageSeedAt = Date.now()
    })
    .finally(() => {
      globalSeed.__mirageSeedPromise = undefined
    })

  await globalSeed.__mirageSeedPromise
}

export async function setSkipBuiltinSeed(skip: boolean) {
  await db.appSetting.upsert({
    where: { key: SKIP_SEED_KEY },
    update: { value: skip ? '1' : '0' },
    create: { key: SKIP_SEED_KEY, value: skip ? '1' : '0' },
  })
  globalSeed.__mirageSeedAt = undefined
}

async function getDeletedBuiltins(): Promise<Set<string>> {
  const row = await db.appSetting.findUnique({
    where: { key: DELETED_BUILTINS_KEY },
  })
  if (!row?.value) return new Set()
  try {
    const arr = JSON.parse(row.value) as unknown
    return new Set(
      Array.isArray(arr) ? arr.map((x) => String(x)).filter(Boolean) : [],
    )
  } catch {
    return new Set()
  }
}

export async function rememberDeletedBuiltin(key: string) {
  if (!BUILTIN_KEYS.has(key)) return
  const set = await getDeletedBuiltins()
  set.add(key)
  await db.appSetting.upsert({
    where: { key: DELETED_BUILTINS_KEY },
    update: { value: JSON.stringify([...set]) },
    create: { key: DELETED_BUILTINS_KEY, value: JSON.stringify([...set]) },
  })
  globalSeed.__mirageSeedAt = undefined
}

export async function wipeAllProviders() {
  await db.providerSession.deleteMany({})
  await db.providerModel.deleteMany({})
  await db.provider.deleteMany({})
  await setSkipBuiltinSeed(true)
  await db.appSetting.upsert({
    where: { key: DELETED_BUILTINS_KEY },
    update: { value: JSON.stringify([...BUILTIN_KEYS]) },
    create: {
      key: DELETED_BUILTINS_KEY,
      value: JSON.stringify([...BUILTIN_KEYS]),
    },
  })
}

export async function restoreBuiltinProviders() {
  await setSkipBuiltinSeed(false)
  await db.appSetting.upsert({
    where: { key: DELETED_BUILTINS_KEY },
    update: { value: '[]' },
    create: { key: DELETED_BUILTINS_KEY, value: '[]' },
  })
  globalSeed.__mirageSeedAt = undefined
  await ensureSeeded()
}

async function runSeed() {
  const skip = await db.appSetting.findUnique({ where: { key: SKIP_SEED_KEY } })
  if (skip?.value === '1') {
    await syncRuntimeAdaptersFromDb()
    return
  }

  const deleted = await getDeletedBuiltins()
  const specs = getProviderSeedSpecs().filter(
    (s) => BUILTIN_KEYS.has(s.key) && !deleted.has(s.key),
  )
  for (const spec of specs) {
    // Skip empty websiteUrl — never clobber a good DB row with blank data
    if (!spec.websiteUrl) continue

    const existing = await db.provider.findUnique({ where: { key: spec.key } })
    // Never demote a live openai_compat row (with apiBaseUrl) back to cookie.
    let adapterKind: string
    if (BUILTIN_CHAT.has(spec.key)) {
      adapterKind = 'builtin'
    } else if (existing?.apiBaseUrl?.trim()) {
      adapterKind = 'openai_compat'
    } else if (existing?.adapterKind === 'openai_compat') {
      adapterKind = 'openai_compat'
    } else {
      adapterKind = 'cookie'
    }

    // Only write when something actually drifted — avoids UPDATE spam.
    const needsWrite =
      !existing ||
      existing.displayName !== spec.displayName ||
      existing.websiteUrl !== spec.websiteUrl ||
      existing.refreshEndpoint !== (spec.refreshEndpoint ?? null) ||
      existing.refreshTtlSec !== (spec.refreshTtlSec ?? 900) ||
      existing.sessionTtlSec !== (spec.sessionTtlSec ?? 2592000) ||
      existing.pingIntervalSec !== (spec.pingIntervalSec ?? 3600) ||
      existing.adapterKind !== adapterKind

    if (!needsWrite) continue

    await db.provider.upsert({
      where: { key: spec.key },
      update: {
        displayName: spec.displayName,
        websiteUrl: spec.websiteUrl,
        refreshEndpoint: spec.refreshEndpoint,
        refreshTtlSec: spec.refreshTtlSec ?? 900,
        sessionTtlSec: spec.sessionTtlSec ?? 2592000,
        pingIntervalSec: spec.pingIntervalSec ?? 3600,
        adapterKind,
      },
      create: {
        key: spec.key,
        displayName: spec.displayName,
        websiteUrl: spec.websiteUrl,
        refreshEndpoint: spec.refreshEndpoint,
        refreshTtlSec: spec.refreshTtlSec ?? 900,
        sessionTtlSec: spec.sessionTtlSec ?? 2592000,
        pingIntervalSec: spec.pingIntervalSec ?? 3600,
        authType: spec.key === 'kimi' ? 'bearer' : 'cookie',
        adapterKind,
      },
    })
  }

  await db.providerModel.updateMany({
    where: {
      modelKey: 'default',
      provider: { key: { in: [...BUILTIN_KEYS] } },
    },
    data: { enabled: false, isDefault: false },
  })

  await db.providerModel.updateMany({
    where: {
      provider: { key: 'deepseek' },
      modelKey: { in: ['instant', 'expert', 'vision', 'default'] },
    },
    data: { enabled: false, isDefault: false },
  })
  await db.provider.updateMany({
    where: { key: 'deepseek' },
    data: { displayName: 'DeepSeek Web' },
  })

  await db.provider.updateMany({
    where: { key: 'huggingface' },
    data: {
      adapterKind: 'builtin',
      apiBaseUrl: null,
      displayName: 'HuggingChat',
    },
  })

  await db.provider.updateMany({
    where: { key: 'qwen' },
    data: {
      adapterKind: 'builtin',
      apiBaseUrl: null,
      displayName: 'Qwen (Tongyi)',
      websiteUrl: 'https://tongyi.aliyun.com/qianwen',
    },
  })

  await syncRuntimeAdaptersFromDb()
}
