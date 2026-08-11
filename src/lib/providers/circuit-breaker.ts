const BACKOFF_MS = [5, 25, 120, 360].map((m) => m * 60_000)
const HALF_OPEN_PROBE_INTERVAL_MS = 15_000

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
}
