const MAX_CONV_AGE_MS = 20 * 60_000 // 20 minutes conservative max age

interface CachedConversation {
  convId: string
  createdAt: number
}

export class ConversationPool {
  private cache = new Map<string, CachedConversation>()

  private key(providerId: string, sessionId: string): string {
    return `${providerId}:${sessionId}`
  }

  get(providerId: string, sessionId: string): CachedConversation | null {
    const k = this.key(providerId, sessionId)
    const conv = this.cache.get(k)
    if (!conv) return null
    if (Date.now() - conv.createdAt > MAX_CONV_AGE_MS) {
      this.cache.delete(k)
      return null
    }
    return conv
  }

  set(providerId: string, sessionId: string, convId: string): void {
    if (!convId) return
    this.cache.set(this.key(providerId, sessionId), {
      convId,
      createdAt: Date.now(),
    })
  }

  clear(providerId: string, sessionId: string): void {
    this.cache.delete(this.key(providerId, sessionId))
  }
}
