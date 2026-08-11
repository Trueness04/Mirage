/**
 * Types + fetch helpers shared across the dashboard.
 */

export interface ProviderModelInfo {
  modelKey: string
  displayName: string
}

export interface ProviderStat {
  key: string
  displayName: string
  websiteUrl: string
  enabled: boolean
  sessionCount: number
  activeSessions: number
  models: number
  modelsList: ProviderModelInfo[]
  adapterKind?: string | null
  apiBaseUrl?: string | null
  captureRequestedAt?: string | null
  waitingForExtension?: boolean
  missingWebsiteUrl?: boolean
  /** true = dedicated/openai_compat chat; false = cookie keep-alive only */
  chatCapable?: boolean
  /** Why models are empty / what to do next (when known) */
  modelsHint?: string | null
  hasAuthToken?: boolean
}

export interface SessionRow {
  id: string
  label: string | null
  status: string
  browser?: string | null
  priority?: number
  deviceId?: string | null
  lastRefreshAt: string | null
  lastPingAt: string | null
  expiresAt: string | null
  requestCount: number
  errorMessage: string | null
  provider: { key: string; displayName: string }
  providerId: string
}

export interface DeviceRow {
  id: string
  deviceId: string
  displayName: string | null
  browser?: string | null
  version: string | null
  lastSeenAt: string | null
  enabled: boolean
}

export interface ApiKeyRow {
  id: string
  keyPrefix: string
  label: string | null
  sessionIds: string
  rateLimitRpm: number
  enabled: boolean
  createdAt: string
}

export interface LogRow {
  id: string
  endpoint: string
  method: string
  status: number
  upstreamStatus: number | null
  stream: boolean
  durationMs: number | null
  model: string | null
  sessionLabel: string | null
  errorMessage: string | null
  createdAt: string
  apiKey: { keyPrefix: string; label: string | null } | null
}

export interface DashboardData {
  stats: {
    providers: number
    activeSessions: number
    expiredSessions: number
    errorSessions: number
    apiKeys: number
    devices: number
    onlineDevices?: number
    totalRequests: number
  }
  providers: ProviderStat[]
  sessions: SessionRow[]
  devices: DeviceRow[]
  apiKeys: ApiKeyRow[]
  recentLogs: LogRow[]
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    const err = new Error(`${url} ${r.status}: ${t}`) as Error & { status?: number }
    err.status = r.status
    throw err
  }
  return r.json() as Promise<T>
}

export function timeAgo(d: string | null): string {
  if (!d) return 'never'
  const ms = Date.now() - new Date(d).getTime()
  if (ms < 60_000) return Math.max(1, Math.floor(ms / 1000)) + 's ago'
  if (ms < 3600_000) return Math.floor(ms / 60_000) + 'm ago'
  if (ms < 86400_000) return Math.floor(ms / 3600_000) + 'h ago'
  return Math.floor(ms / 86400_000) + 'd ago'
}

export function timeLeft(d: string | null): string {
  if (!d) return '—'
  const ms = new Date(d).getTime() - Date.now()
  if (ms < 0) return 'expired'
  if (ms < 60_000) return Math.floor(ms / 1000) + 's'
  if (ms < 3600_000) return Math.floor(ms / 60_000) + 'm'
  if (ms < 86400_000) return Math.floor(ms / 3600_000) + 'h'
  return Math.floor(ms / 86400_000) + 'd'
}
