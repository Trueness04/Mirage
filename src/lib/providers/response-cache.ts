/**
 * Response Cache (LRU in-memory cache for completion responses)
 * --------------------------------------------------------------------
 * Reduces duplicate requests to upstream AI providers, mitigating bot detection
 * and rate-limit triggers. Non-streaming responses only.
 */

import { createHash } from 'node:crypto'
import type { ChatCompletionResponse, ChatMessage } from './base'

interface CacheEntry {
  response: ChatCompletionResponse
  expiresAt: number
}

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes
const MAX_CACHE_SIZE = 500

class ResponseCache {
  private cache = new Map<string, CacheEntry>()

  private computeKey(providerKey: string, model: string, messages: ChatMessage[]): string {
    const raw = `${providerKey}:${model}:${JSON.stringify(messages)}`
    return createHash('sha256').update(raw).digest('hex')
  }

  get(providerKey: string, model: string, messages: ChatMessage[]): ChatCompletionResponse | null {
    const key = this.computeKey(providerKey, model, messages)
    const entry = this.cache.get(key)
    if (!entry) return null

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }

    // Refresh LRU ordering
    this.cache.delete(key)
    this.cache.set(key, entry)

    // Return cloned response with fresh timestamp/id if needed, but original object structure is clean
    return {
      ...entry.response,
      id: `chatcmpl-cache-${Date.now()}`,
    }
  }

  set(
    providerKey: string,
    model: string,
    messages: ChatMessage[],
    response: ChatCompletionResponse,
    ttlMs: number = DEFAULT_TTL_MS,
  ): void {
    const key = this.computeKey(providerKey, model, messages)

    // Evict oldest entry if size exceeded
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) this.cache.delete(firstKey)
    }

    this.cache.set(key, {
      response,
      expiresAt: Date.now() + ttlMs,
    })
  }

  clear(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }
}

export const responseCache = new ResponseCache()
