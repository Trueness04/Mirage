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

export function wrapProviderAdapter(
  adapter: ProviderAdapter,
): ProviderAdapter {
  const breaker = new CircuitBreaker()
  const health = new ModelHealth()

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
        breaker.recordFailure()
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
        breaker.recordFailure()
        throw e
      }
    },

    async refresh(session: AdapterSessionContext): Promise<RefreshResult> {
      return adapter.refresh(session)
    },

    async ping(
      session: AdapterSessionContext,
    ): Promise<{ ok: boolean; error?: string }> {
      // Instead of an active ping, we can use the passive health checker
      // If we need an active ping, we send a natural prompt.
      // For now, if we haven't had a recent success, we fallback to adapter.ping
      if (!health.shouldProbe()) {
        return { ok: true }
      }
      const res = await adapter.ping(session)
      if (res.ok) {
        health.recordPassiveSuccess()
      } else {
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
