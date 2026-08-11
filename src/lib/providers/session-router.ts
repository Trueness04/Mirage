/**
 * Session Router
 * --------------------------------------------------------------------
 * Provides round-robin and least-used distribution for multi-session providers
 * to prevent single-account exhaustion/rate limits.
 */

export interface SessionWithMeta {
  id: string
  priority?: number | null
  requestCount?: number | null
  [key: string]: unknown
}

const providerCounters = new Map<string, number>()

/**
 * Reorders available sessions using round-robin per priority group while
 * prioritizing least-used sessions within the same priority rank.
 */
export function reorderForRoundRobin<T extends SessionWithMeta>(
  providerKey: string,
  sessions: T[],
): T[] {
  if (sessions.length <= 1) return sessions

  // Group by priority (defaulting priority to 0 if null/undefined)
  const groups = new Map<number, T[]>()
  for (const s of sessions) {
    const p = s.priority ?? 0
    if (!groups.has(p)) groups.set(p, [])
    groups.get(p)!.push(s)
  }

  const sortedPriorities = Array.from(groups.keys()).sort((a, b) => a - b)
  const result: T[] = []

  for (const prio of sortedPriorities) {
    const group = groups.get(prio)!
    if (group.length <= 1) {
      result.push(...group)
      continue
    }

    // Sort within group by least requestCount first
    const sortedGroup = [...group].sort(
      (a, b) => (a.requestCount ?? 0) - (b.requestCount ?? 0),
    )

    // Get & increment current round-robin offset for this provider
    const counter = providerCounters.get(providerKey) ?? 0
    const offset = counter % sortedGroup.length
    providerCounters.set(providerKey, counter + 1)

    // Rotate sorted group by offset
    const rotated = [
      ...sortedGroup.slice(offset),
      ...sortedGroup.slice(0, offset),
    ]
    result.push(...rotated)
  }

  return result
}
