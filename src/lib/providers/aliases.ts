/**
 * Provider id aliases used by other web-cookie gateways (e.g. ds-web → deepseek).
 * Clients may call models as `ds-web/deepseek-reasoner`.
 */

const PROVIDER_ALIASES: Record<string, string> = {
  'ds-web': 'deepseek',
  'deepseek-web': 'deepseek',
  'cgpt-web': 'chatgpt',
  'chatgpt-web': 'chatgpt',
  cw: 'claude',
  'claude-web': 'claude',
  gweb: 'gemini',
  'gemini-web': 'gemini',
  'kimi-web': 'kimi',
  'qwen-web': 'qwen',
  // chat-qwen-ai stays its own DB provider key; completions swaps in the qwen adapter.
  lma: 'arena',
  lmarena: 'arena',
  ven: 'venice',
  'venice-web': 'venice',
  t3chat: 't3',
  't3-web': 't3',
  huggingchat: 'huggingface',
  hc: 'huggingface',
  'hf-chat': 'huggingface',
}

/** Canonical Mirage provider key for a client-facing id/alias. */
export function resolveProviderAlias(key: string): string {
  const k = String(key || '')
    .trim()
    .toLowerCase()
  return PROVIDER_ALIASES[k] || k
}

/** Extra ids to advertise in GET /v1/models for a canonical provider key. */
export function providerPublicAliases(canonicalKey: string): string[] {
  const key = canonicalKey.toLowerCase()
  const out: string[] = []
  for (const [alias, canon] of Object.entries(PROVIDER_ALIASES)) {
    if (canon === key) out.push(alias)
  }
  return out
}

/** Map legacy Instant/Expert keys → OmniRoute / ds-web model ids. */
export function normalizeDeepSeekModelKey(modelKey: string): string {
  const k = String(modelKey || '')
    .trim()
  const lower = k.toLowerCase()
  if (lower === 'instant' || lower === 'default' || lower === 'chat') {
    return 'deepseek-chat'
  }
  if (lower === 'expert') return 'deepseek-v4-pro'
  if (lower === 'reasoner' || lower === 'r1') return 'deepseek-reasoner'
  return k
}
