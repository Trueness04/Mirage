/**
 * Rate Limiter
 * --------------------------------------------------------------------
 * Sliding window in-memory rate limiter per API key.
 * Enforces rateLimitRpm set on ApiKey in DB.
 */

interface RateLimitWindow {
  timestamps: number[]
}

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000 // Clean up stale keys every 5 mins
const WINDOW_MS = 60 * 1000 // 1 minute window

class RateLimiter {
  private windows = new Map<string, RateLimitWindow>()
  private lastCleanup = Date.now()

  /**
   * Check if a request is allowed under limitRpm for keyId.
   * If limitRpm <= 0, rate limiting is disabled (unlimited).
   */
  check(
    keyId: string,
    limitRpm: number,
  ): { allowed: boolean; remaining: number; resetMs: number } {
    if (limitRpm <= 0) {
      return { allowed: true, remaining: Infinity, resetMs: 0 }
    }

    const now = Date.now()
    this.maybeCleanup(now)

    let entry = this.windows.get(keyId)
    if (!entry) {
      entry = { timestamps: [] }
      this.windows.set(keyId, entry)
    }

    // Remove timestamps older than 60s
    const cutoff = now - WINDOW_MS
    entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff)

    if (entry.timestamps.length >= limitRpm) {
      const oldest = entry.timestamps[0]
      const resetMs = Math.max(0, oldest + WINDOW_MS - now)
      return {
        allowed: false,
        remaining: 0,
        resetMs,
      }
    }

    // Record this request
    entry.timestamps.push(now)
    return {
      allowed: true,
      remaining: limitRpm - entry.timestamps.length,
      resetMs: 0,
    }
  }

  private maybeCleanup(now: number) {
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) return
    this.lastCleanup = now
    const cutoff = now - WINDOW_MS

    for (const [keyId, entry] of this.windows.entries()) {
      entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff)
      if (entry.timestamps.length === 0) {
        this.windows.delete(keyId)
      }
    }
  }
}

export const rateLimiter = new RateLimiter()
