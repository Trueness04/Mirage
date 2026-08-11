/**
 * Provider registry — single import point.
 *
 * Importing this module registers all built-in adapters. Model catalogs are
 * imported from each provider's live URL/API after session capture — never
 * seeded from hardcoded lists here.
 */

import './kimi'
import './zai'
import './deepseek'
import './claude'
import './qwen'
import './dola'
import './gemini'
import './huggingchat'

import { createGenericAdapter } from './generic'

// Cookie keep-alive holders (chat when openai_compat apiBaseUrl is set).
// models: [] — catalogs come from live /api/models import, not seed data.
createGenericAdapter({
  key: 'venice',
  displayName: 'Venice AI',
  websiteUrl: 'https://venice.ai',
  validationPath: '/chat/agent',
  models: [],
})

createGenericAdapter({
  key: 't3',
  displayName: 'T3 Chat',
  websiteUrl: 'https://t3.chat',
  validationPath: '/',
  models: [],
})

createGenericAdapter({
  key: 'meta',
  displayName: 'Meta AI',
  websiteUrl: 'https://www.meta.ai',
  validationPath: '/',
  models: [],
})

// ─── Export the registration list (used by db seed) ───────────────────
import { listAdapters } from './base'

export interface ProviderSeedSpec {
  key: string
  displayName: string
  websiteUrl: string
  refreshEndpoint?: string
  refreshTtlSec?: number
  sessionTtlSec?: number
  pingIntervalSec?: number
  models: AdapterModelSpecImport[]
}

interface AdapterModelSpecImport {
  modelKey: string
  displayName: string
  upstreamName?: string
  contextWindow?: number
  isDefault?: boolean
  supportsStream?: boolean
}

const BUILTIN_WEBSITE_URLS: Record<string, string> = {
  kimi: 'https://www.kimi.com',
  zai: 'https://chat.z.ai',
  deepseek: 'https://chat.deepseek.com', // client aliases: ds-web, deepseek-web
  claude: 'https://claude.ai',
  gemini: 'https://gemini.google.com',
  qwen: 'https://tongyi.aliyun.com/qianwen',
  huggingface: 'https://huggingface.co/chat',
  dola: 'https://www.dola.com/chat',
  venice: 'https://venice.ai/chat/agent',
  t3: 'https://t3.chat/',
  meta: 'https://www.meta.ai',
}

export function getProviderSeedSpecs(): ProviderSeedSpec[] {
  // Only built-ins — never include runtime/user-added adapters (their
  // websiteUrl would seed as "" and wipe the DB row on every ensureSeeded).
  return listAdapters()
    .filter((a) => Boolean(BUILTIN_WEBSITE_URLS[a.key]))
    .map((a) => {
      const refreshEndpoints: Record<string, string> = {
        kimi: 'https://www.kimi.com/api/auth/token/refresh',
        zai: 'https://chat.z.ai/api/v1/auths/',
      }
      return {
        key: a.key,
        displayName: a.displayName,
        websiteUrl: BUILTIN_WEBSITE_URLS[a.key],
        refreshEndpoint: refreshEndpoints[a.key],
        refreshTtlSec:
          a.key === 'kimi' || a.key === 'gemini' ? 15 * 60 : 24 * 60 * 60,
        sessionTtlSec: 30 * 24 * 60 * 60,
        pingIntervalSec:
          a.key === 'kimi' || a.key === 'gemini' ? 10 * 60 : 60 * 60,
        // Never seed model rows from adapter.listModels()
        models: [],
      }
    })
}
