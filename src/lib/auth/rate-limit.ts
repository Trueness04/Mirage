/**
 * Simple in-process sliding-window rate limiter for API keys (rpm).
 * `limitRpm <= 0` disables the limiter for that key.
 */

type Bucket = number[] // timestamps (ms)

const buckets = new Map<string, Bucket>()

export function checkRateLimit(
  keyId: string,
  limitRpm: number,
): { ok: true } | { ok: false; retryAfterSec: number } {
  // 0 / negative = unlimited (local gateway / Playground testing)
  if (!Number.isFinite(limitRpm) || limitRpm <= 0) {
    return { ok: true }
  }
  const limit = Math.max(1, Math.floor(limitRpm))
  const now = Date.now()
  const windowMs = 60_000
  let hits = buckets.get(keyId) || []
  hits = hits.filter((t) => now - t < windowMs)
  if (hits.length >= limit) {
    const oldest = hits[0]
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000))
    buckets.set(keyId, hits)
    return { ok: false, retryAfterSec }
  }
  hits.push(now)
  buckets.set(keyId, hits)
  return { ok: true }
}
