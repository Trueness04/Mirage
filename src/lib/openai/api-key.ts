/**
 * API key utilities — generate, hash, verify.
 */

import { createHash, randomBytes } from 'crypto'

const PREFIX = 'sk-mg-' // sk-mg = "mirage"

export function generateApiKey(): { fullKey: string; keyPrefix: string; keyHash: string } {
  const raw = randomBytes(32).toString('hex')
  const fullKey = `${PREFIX}${raw}`
  const keyPrefix = fullKey.slice(0, 12)
  const keyHash = hashKey(fullKey)
  return { fullKey, keyPrefix, keyHash }
}

export function hashKey(fullKey: string): string {
  return createHash('sha256').update(fullKey).digest('hex')
}

export async function findApiKey(rawKey: string) {
  const { db } = await import('@/lib/db')
  const keyHash = hashKey(rawKey)
  return db.apiKey.findUnique({
    where: { keyHash },
    include: { logs: false },
  })
}
