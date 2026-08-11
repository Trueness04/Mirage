const BACKOFF_MS = [1, 5, 15, 30].map((m) => m * 60_000) // max 30 min
const HALF_OPEN_PROBE_INTERVAL_MS = 60_000 // 1 min between half-open probes

export class CircuitBreaker {
  private fails = 0
  private downUntil = 0
  private lastProbe = 0

  recordSuccess() {
    this.fails = 0
    this.downUntil = 0
  }

  recordFailure() {
    const idx = Math.min(this.fails, BACKOFF_MS.length - 1)
    this.fails += 1
    this.downUntil = Date.now() + BACKOFF_MS[idx]
    console.warn(
      `[breaker] fail #${this.fails}, down for ${Math.ceil(BACKOFF_MS[idx] / 1000)}s`,
    )
  }

  canAttempt(): boolean {
    if (Date.now() >= this.downUntil) {
      if (
        this.fails > 0 &&
        Date.now() - this.lastProbe < HALF_OPEN_PROBE_INTERVAL_MS
      ) {
        return false // prevent hammering during half-open
      }
      this.lastProbe = Date.now()
      return true
    }
    return false
  }

  msUntilRetry(): number {
    return Math.max(0, this.downUntil - Date.now())
  }

  /** Force-reset from admin endpoint — immediately re-opens the breaker. */
  forceReset() {
    this.fails = 0
    this.downUntil = 0
    this.lastProbe = 0
    console.log('[breaker] force reset')
  }

  getFailCount(): number {
    return this.fails
  }
}
