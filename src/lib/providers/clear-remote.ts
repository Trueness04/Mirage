/**
 * Clear chat history on the upstream provider website (not Mirage DB).
 */

import { db } from '@/lib/db'
import {
  getAdapter,
  type AdapterSessionContext,
  type ClearRemoteChatsOptions,
  type ClearRemoteChatsResult,
} from '@/lib/providers/base'
import { loadSessionContext } from '@/lib/providers/session-loader'

export async function clearRemoteChatsForProvider(
  providerKey: string,
  opts: ClearRemoteChatsOptions = {},
): Promise<ClearRemoteChatsResult & { providerKey: string }> {
  const key = String(providerKey || '').trim()
  if (!key) {
    return { ok: false, deleted: 0, providerKey: key, error: 'providerKey required' }
  }

  const adapter = getAdapter(key)
  if (!adapter?.clearRemoteChats) {
    return {
      ok: false,
      deleted: 0,
      providerKey: key,
      error: `${key} does not support clearing chats on the provider site yet`,
    }
  }

  const provider = await db.provider.findUnique({ where: { key } })
  if (!provider) {
    return { ok: false, deleted: 0, providerKey: key, error: 'Provider not found' }
  }

  const session = await db.providerSession.findFirst({
    where: { providerId: provider.id, status: 'active' },
    orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }],
  })
  if (!session) {
    return {
      ok: false,
      deleted: 0,
      providerKey: key,
      error: 'No active session — connect OAuth first',
    }
  }

  const loaded = await loadSessionContext(session.id)
  if (!loaded) {
    return {
      ok: false,
      deleted: 0,
      providerKey: key,
      error: 'Failed to load session',
    }
  }

  try {
    const result = await adapter.clearRemoteChats(loaded.ctx, opts)
    return { ...result, providerKey: key }
  } catch (e) {
    return {
      ok: false,
      deleted: 0,
      providerKey: key,
      error: (e as Error).message || String(e),
    }
  }
}

/** Fire-and-forget cleanup after a Mirage chat.
 * Pass force=true for probes / failed creates. Sticky chats skip cleanup. */
export function scheduleRemoteChatCleanup(
  providerKey: string,
  session: AdapterSessionContext,
  remoteChatId: string | undefined,
  force = false,
): void {
  if (!remoteChatId) return
  if (!force) return
  const adapter = getAdapter(providerKey)
  if (!adapter?.cleanupRemoteChat) return
  void adapter.cleanupRemoteChat(session, remoteChatId).catch(() => {})
}
