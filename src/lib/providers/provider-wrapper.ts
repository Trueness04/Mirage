import {
  type ProviderAdapter,
  type AdapterSessionContext,
  type OpenAIChatRequest,
  type UpstreamRequestSpec,
  type ChatCompletionResponse,
  type StreamChunk,
  type RefreshResult,
  type SessionValidationResult,
} from './base'
import { CircuitBreaker } from './circuit-breaker'
import { ModelHealth } from './model-health'
import { ConversationPool } from './conversation-pool'

export const globalConversationPool = new ConversationPool()

/**
 * Global registry of breaker instances keyed by adapter key.
 * Used by admin endpoints to inspect / force-reset individual breakers.
 */
const breakerRegistry = new Map<string, CircuitBreaker>()
const healthRegistry = new Map<string, ModelHealth>()

export function getAdapterBreaker(key: string): CircuitBreaker | undefined {
  return breakerRegistry.get(key)
}

export function getAllAdapterBreakers(): Map<string, CircuitBreaker> {
  return breakerRegistry
}

export function getAdapterHealth(key: string): ModelHealth | undefined {
  return healthRegistry.get(key)
}

/**
 * Determines whether an error represents a real upstream connectivity failure
 * (network down, TLS failure, hard timeout) versus an application-level error
 * (auth rejected, empty response, content parse fail, INVALID_TOKEN, PoW fail, etc.)
 *
 * Only connectivity failures should trip the circuit breaker — auth/content
 * errors mean the upstream *is* reachable, just refusing or mis-behaving for
 * this specific request.
 */
function isConnectivityFailure(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  // Network-level errors from Node.js fetch
  if (/fetch failed|econnrefused|enotfound|etimedout|econnreset|ehostunreach|network/i.test(msg)) {
    return true
  }
  // Upstream returned a server-side 5xx that isn't just "auth"
  if (/upstream .+ http 5\d\d/i.test(msg) && !/401|403|invalid_token|auth/i.test(msg)) {
    return true
  }
  return false
}

export function wrapProviderAdapter(
  adapter: ProviderAdapter,
): ProviderAdapter {
  const breaker = new CircuitBreaker()
  const health = new ModelHealth()

  // Register so admin & self-healing routes can access them by provider key
  breakerRegistry.set(adapter.key, breaker)
  healthRegistry.set(adapter.key, health)

  return {
    ...adapter,

    async buildUpstreamRequest(
      req: OpenAIChatRequest,
      session: AdapterSessionContext,
    ): Promise<UpstreamRequestSpec> {
      if (!breaker.canAttempt()) {
        throw new Error(
          `[${adapter.key}] Circuit breaker open, retry in ${Math.ceil(
            breaker.msUntilRetry() / 1000,
          )}s`,
        )
      }
      return adapter.buildUpstreamRequest(req, session)
    },

    async parseUpstreamResponse(
      raw: Response,
      session: AdapterSessionContext,
      model: string,
    ): Promise<ChatCompletionResponse> {
      try {
        const resp = await adapter.parseUpstreamResponse(raw, session, model)
        breaker.recordSuccess()
        health.recordPassiveSuccess()
        return resp
      } catch (e) {
        // Only network-level failures should count against the breaker.
        // Auth rejections, empty SSE, INVALID_TOKEN etc. do NOT mean the
        // provider is down — they need session fixes, not backoff.
        if (isConnectivityFailure(e)) {
          breaker.recordFailure()
        }
        throw e
      }
    },

    async *transformStream(
      upstreamStream: ReadableStream<Uint8Array>,
      session: AdapterSessionContext,
      model: string,
    ): AsyncGenerator<StreamChunk, void, unknown> {
      try {
        if (adapter.transformStream) {
          yield* adapter.transformStream(upstreamStream, session, model)
        }
        breaker.recordSuccess()
        health.recordPassiveSuccess()
      } catch (e) {
        if (isConnectivityFailure(e)) {
          breaker.recordFailure()
        }
        throw e
      }
    },

    async refresh(session: AdapterSessionContext): Promise<RefreshResult> {
      return adapter.refresh(session)
    },

    async ping(
      session: AdapterSessionContext,
    ): Promise<{ ok: boolean; error?: string }> {
      if (!health.shouldProbe()) {
        return { ok: true }
      }
      const res = await adapter.ping(session)
      if (res.ok) {
        health.recordPassiveSuccess()
      } else {
        // ping failing means the session is unreachable — count as connectivity
        breaker.recordFailure()
      }
      return res
    },

    async validate(
      session: AdapterSessionContext,
    ): Promise<SessionValidationResult> {
      return adapter.validate(session)
    },
  }
}
