/**
 * Which providers can actually proxy chat (vs cookie keep-alive holders).
 */

const ALWAYS_CHAT_KEYS = new Set([
  'kimi',
  'zai',
  'deepseek',
  'claude',
  'qwen',
  'arena',
  'dola',
  'gemini',
  'huggingface',
  'chat-qwen-ai',
  'qwen-international',
  'qwen-intl',
  'qwen-ai',
])

export function isChatCapableProvider(p: {
  adapterKind?: string | null
  apiBaseUrl?: string | null
  key?: string
  websiteUrl?: string | null
}): boolean {
  const key = (p.key || '').toLowerCase()
  if (ALWAYS_CHAT_KEYS.has(key)) return true
  if (/chat\.qwen\.ai/i.test(p.websiteUrl || '')) return true
  const kind = (p.adapterKind || '').toLowerCase()
  if (kind === 'builtin') return true
  // Need a real API base — kind alone is not enough (SPA /v1 HTML traps).
  if (
    (kind === 'openai_compat' || Boolean(p.apiBaseUrl?.trim())) &&
    p.apiBaseUrl?.trim()
  ) {
    // Dead Qwen v1 openai_compat bases must not look "chat-ready" via generic.
    if (/chat\.qwen\.ai/i.test(p.apiBaseUrl || '')) return true
    return true
  }
  return false
}

export function chatNotReadyMessage(providerKey: string): string {
  return (
    `[${providerKey}] Session captured, but chat is not implemented for this site yet. ` +
    'Mirage only keeps the login alive. Use a chat-ready provider (builtin adapters) ' +
    'or add the platform with an OpenAI-compatible API Base URL.'
  )
}
