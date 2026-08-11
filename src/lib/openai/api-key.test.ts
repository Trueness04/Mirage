import { describe, it, expect } from 'vitest'
import { generateApiKey, hashKey } from './api-key'
import { createHash } from 'crypto'

describe('API Key utilities', () => {
  describe('generateApiKey', () => {
    it('generates keys with the correct prefix', () => {
      const { fullKey, keyPrefix } = generateApiKey()
      expect(fullKey.startsWith('sk-mg-')).toBe(true)
      expect(keyPrefix).toBe(fullKey.slice(0, 12))
    })

    it('generates keys of the correct length', () => {
      const { fullKey } = generateApiKey()
      // 'sk-mg-' (6) + 32 bytes hex (64) = 70
      expect(fullKey.length).toBe(70)
    })

    it('returns a valid SHA-256 hash of the full key', () => {
      const { fullKey, keyHash } = generateApiKey()
      const expectedHash = createHash('sha256').update(fullKey).digest('hex')
      expect(keyHash).toBe(expectedHash)
    })

    it('generates unique keys', () => {
      const key1 = generateApiKey()
      const key2 = generateApiKey()
      expect(key1.fullKey).not.toBe(key2.fullKey)
    })
  })

  describe('hashKey', () => {
    it('returns a correct SHA-256 hex string for a known input', () => {
      const input = 'sk-mg-testkey'
      const expectedHash = createHash('sha256').update(input).digest('hex')
      expect(hashKey(input)).toBe(expectedHash)
    })

    it('is deterministic', () => {
      const input = 'sk-mg-1234567890abcdef'
      expect(hashKey(input)).toBe(hashKey(input))
    })
  })
})
