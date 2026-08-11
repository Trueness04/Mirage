/**
 * Sticky remote chat ids — one host-site conversation per Mirage session.
 * Stops create-chat spam that trips provider anti-bot (math probes, etc.).
 */

const sticky = new Map<string, { id: string; at: number }>()

/** Drop sticky entries older than this (ms). */
const STICKY_TTL_MS = 45 * 60_000

export function stickyRemoteKey(providerKey: string, sessionId?: string): string {
  return `${providerKey}:${sessionId || 'default'}`
}

export function getStickyRemoteChat(
  providerKey: string,
  sessionId?: string,
): string | null {
  const key = stickyRemoteKey(providerKey, sessionId)
  const row = sticky.get(key)
  if (!row) return null
  if (Date.now() - row.at > STICKY_TTL_MS) {
    sticky.delete(key)
    return null
  }
  return row.id
}

export function setStickyRemoteChat(
  providerKey: string,
  sessionId: string | undefined,
  remoteChatId: string,
): void {
  if (!remoteChatId) return
  sticky.set(stickyRemoteKey(providerKey, sessionId), {
    id: remoteChatId,
    at: Date.now(),
  })
}

export function clearStickyRemoteChat(
  providerKey: string,
  sessionId?: string,
): void {
  sticky.delete(stickyRemoteKey(providerKey, sessionId))
}

export function isProbeChatRequest(messages: any[]): boolean {
  if (!messages || messages.length === 0) return true

  const lastMsg = messages[messages.length - 1]
  if (lastMsg && lastMsg.role === 'user') {
    const text = typeof lastMsg.content === 'string' ? lastMsg.content : ''
    const t = text.trim().toLowerCase()

    // LibreChat and OpenRouter typically probe with these
    if (t === 'hi' || t === 'test' || t.startsWith('1+1') || t === 'hello' || t === 'ping') {
      return true
    }
  }

  return false
}
