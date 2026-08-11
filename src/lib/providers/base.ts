/**
 * Provider Adapter Base Contract
 * --------------------------------------------------------------------
 * Each AI website (Kimi, Claude, DeepSeek, ...) implements this contract.
 * Mirage's core never hard-codes a specific provider — everything is
 * dispatched through this interface, so adding a new provider is just
 * "write an adapter + register it".
 */

export interface CookieJarEntry {
  name: string
  value: string
  domain: string
  path: string
  expires?: number // ms since epoch
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
}

export interface OpenAIChatRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  stream?: boolean
  stop?: string | string[]
  presence_penalty?: number
  frequency_penalty?: number
  user?: string
  tools?: unknown[]
  tool_choice?: unknown
  [k: string]: unknown
}

export interface ChatCompletionChoice {
  index: number
  message: ChatMessage
  finish_reason: string
}

export interface ChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface StreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: Partial<ChatMessage>
    finish_reason: string | null
  }>
}

export interface RefreshResult {
  ok: boolean
  accessToken?: string
  refreshToken?: string
  cookies?: CookieJarEntry[]
  expiresAt?: Date
  refreshExpiresAt?: Date
  error?: string
}

export interface SessionValidationResult {
  valid: boolean
  reason?: string
  detectedModels?: string[]
}

export interface ProviderAdapter {
  readonly key: string
  readonly displayName: string

  buildUpstreamRequest(
    req: OpenAIChatRequest,
    session: AdapterSessionContext,
  ): Promise<UpstreamRequestSpec>

  parseUpstreamResponse(
    raw: Response,
    session: AdapterSessionContext,
    model: string,
  ): Promise<ChatCompletionResponse>

  transformStream(
    upstreamStream: ReadableStream<Uint8Array>,
    session: AdapterSessionContext,
    model: string,
  ): AsyncGenerator<StreamChunk, void, unknown>

  refresh(session: AdapterSessionContext): Promise<RefreshResult>

  ping(session: AdapterSessionContext): Promise<{ ok: boolean; error?: string }>

  validate(session: AdapterSessionContext): Promise<SessionValidationResult>

  listModels?(): AdapterModelSpec[]

  /**
   * Delete conversations on the upstream website (not Mirage DB).
   * Used by dashboard “Clear site chats”.
   */
  clearRemoteChats?(
    session: AdapterSessionContext,
    opts?: ClearRemoteChatsOptions,
  ): Promise<ClearRemoteChatsResult>

  /** Delete one upstream conversation created by a Mirage request. */
  cleanupRemoteChat?(
    session: AdapterSessionContext,
    remoteChatId: string,
  ): Promise<void>
}

export interface ClearRemoteChatsOptions {
  /** Prefer Mirage-created chats only when the site exposes a name/title. */
  mirageOnly?: boolean
  /** Safety cap on deletes (default 200). */
  limit?: number
}

export interface ClearRemoteChatsResult {
  ok: boolean
  deleted: number
  listed?: number
  mirageOnly?: boolean
  error?: string
  detail?: string
}

export interface AdapterSessionContext {
  id?: string
  providerId: string
  providerKey: string
  cookies: CookieJarEntry[]
  accessToken?: string
  refreshToken?: string
  expiresAt?: Date
  refreshExpiresAt?: Date
  /** Online Mirage extension device that captured this session (for browser_fetch). */
  deviceId?: string
}

export interface AdapterModelSpec {
  modelKey: string
  displayName: string
  upstreamName?: string
  contextWindow?: number
  isDefault?: boolean
  supportsStream?: boolean
}

export interface UpstreamRequestSpec {
  url: string
  method: 'POST' | 'GET'
  headers: Record<string, string>
  body: unknown
  stream: boolean
  /** Run the request in the user's Chrome tab (Cloudflare-bound sites). */
  viaBrowser?: boolean
  /** Multipart form fields (chat route builds FormData; do not set Content-Type). */
  multipart?: Record<string, string>
  /**
   * After a successful Mirage completion, delete this upstream conversation
   * so playground traffic does not litter the provider sidebar.
   */
  remoteChatId?: string
  /**
   * When true, always delete remoteChatId after the request (success or fail).
   * Used for math probes / one-shots. Sticky chats omit this and are reused.
   */
  ephemeralRemoteChat?: boolean
}

import { wrapProviderAdapter } from './provider-wrapper'

const adapters = new Map<string, ProviderAdapter>()

export function registerAdapter(a: ProviderAdapter) {
  adapters.set(a.key, wrapProviderAdapter(a))
}

export function getAdapter(key: string): ProviderAdapter | undefined {
  return adapters.get(key)
}

export function listAdapters(): ProviderAdapter[] {
  return Array.from(adapters.values())
}

export function cookieHeader(cookies: CookieJarEntry[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

export function findCookie(
  cookies: CookieJarEntry[],
  name: string,
): CookieJarEntry | undefined {
  const lower = name.toLowerCase()
  return cookies.find((c) => c.name.toLowerCase() === lower)
}

export function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  h.forEach((v, k) => {
    out[k] = v
  })
  return out
}

/**
 * Browser-like headers — these are what makes the upstream AI website
 * think the request is "responding on the web" (per the user's request),
 * not coming from a third-party proxy.
 */
export const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Ch-Ua':
    '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  Origin: '',
  Referer: '',
}
