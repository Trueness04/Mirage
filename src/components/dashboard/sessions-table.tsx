'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api, type DashboardData, timeAgo, timeLeft } from '@/lib/dashboard/types'
import { RefreshCw, AlertTriangle, CheckCircle2, FlaskConical } from 'lucide-react'
import { toast } from 'sonner'

function deviceOnline(
  devices: DashboardData['devices'],
  deviceId: string | null | undefined,
): boolean {
  if (!deviceId) return devices.some(isFresh)
  const d = devices.find((x) => x.deviceId === deviceId)
  return d ? isFresh(d) : false
}

function isFresh(d: { lastSeenAt: string | null; enabled: boolean }): boolean {
  if (!d.enabled || !d.lastSeenAt) return false
  return Date.now() - new Date(d.lastSeenAt).getTime() < 90_000
}

export function SessionsTable() {
  const qc = useQueryClient()
  const { data } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => api('/api/dashboard'),
    refetchInterval: 5000,
  })

  if (!data) return null

  const refresh = async (id: string, label: string | null) => {
    const t = toast.loading(`Refreshing ${label || 'session'}…`)
    try {
      const r = await api<{ ok: boolean; error?: string }>(
        `/api/refresh?id=${id}`,
        { method: 'POST' },
      )
      if (r.ok) {
        toast.success('Session refreshed', { id: t })
        qc.invalidateQueries({ queryKey: ['dashboard'] })
      } else {
        toast.error('Refresh failed: ' + (r.error || 'unknown'), { id: t })
      }
    } catch (e) {
      toast.error(String(e), { id: t })
    }
  }

  const testSession = async (
    id: string,
    label: string | null,
    deviceId: string | null | undefined,
  ) => {
    const viaExt = deviceOnline(data.devices, deviceId)
    const t = toast.loading(
      viaExt
        ? `Testing ${label || 'session'} via extension…`
        : `Testing ${label || 'session'} on server…`,
    )
    try {
      const r = await api<{
        result: { valid: boolean; reason?: string }
        via?: string
      }>(
        `/api/sessions?action=${viaExt ? 'test_via_extension' : 'test'}&id=${id}`,
        { method: 'POST' },
      )
      if (r.result?.valid) {
        toast.success(`Valid (${r.via || 'server'})`, { id: t })
      } else {
        toast.error(r.result?.reason || 'Invalid credentials', { id: t })
      }
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    } catch (e) {
      toast.error(String(e), { id: t })
    }
  }

  const del = async (id: string) => {
    if (!confirm('Delete this session?')) return
    await api(`/api/sessions?id=${id}`, { method: 'DELETE' })
    qc.invalidateQueries({ queryKey: ['dashboard'] })
    toast.success('Session deleted')
  }

  return (
    <Card className="border-0 bg-surface shadow-neo">
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
        <CardDescription>
          Captured logins per provider. Primary (Chrome) runs first; fallback
          (Edge) takes over on auth failures. Keep-alive refreshes them automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.sessions.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            No sessions yet. Install Mirage on Chrome and Edge, then log into AI sites.
          </div>
        ) : (
          <div className="max-h-[420px] overflow-y-auto pr-2 -mr-2">
            <table className="w-full text-sm">
              <thead className="text-[11px] text-muted-foreground uppercase tracking-wide">
                <tr className="border-b border-border/40">
                  <th className="text-left py-2 px-2">Provider</th>
                  <th className="text-left py-2 px-2">Role</th>
                  <th className="text-left py-2 px-2">Browser</th>
                  <th className="text-left py-2 px-2">Status</th>
                  <th className="text-left py-2 px-2">Last Ping</th>
                  <th className="text-left py-2 px-2">Expires in</th>
                  <th className="text-right py-2 px-2">Reqs</th>
                  <th className="text-right py-2 px-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((s) => {
                  const statusIcon =
                    s.status === 'active' ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                    ) : s.status === 'error' ? (
                      <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                    )
                  const role =
                    (s.priority ?? 0) === 0 ? 'primary' : 'fallback'
                  return (
                    <tr
                      key={s.id}
                      className="border-b border-border/20 hover:bg-background/40 transition-colors"
                      title={s.errorMessage || s.label || ''}
                    >
                      <td className="py-2 px-2">
                        <div className="font-medium">{s.provider.displayName}</div>
                        <code className="text-[10px] text-muted-foreground">
                          {s.provider.key}
                        </code>
                      </td>
                      <td className="py-2 px-2">
                        <Badge
                          variant={role === 'primary' ? 'default' : 'outline'}
                          className="text-[10px]"
                        >
                          {role}
                        </Badge>
                      </td>
                      <td className="py-2 px-2 text-xs capitalize text-muted-foreground">
                        {s.browser || '—'}
                      </td>
                      <td className="py-2 px-2">
                        <div className="flex items-center gap-1.5">
                          {statusIcon}
                          <span className="text-xs">{s.status}</span>
                        </div>
                      </td>
                      <td className="py-2 px-2 text-xs text-muted-foreground">
                        {timeAgo(s.lastPingAt)}
                      </td>
                      <td className="py-2 px-2 text-xs">
                        {s.status === 'error' ? (
                          <span className="text-rose-400">failed</span>
                        ) : (
                          timeLeft(s.expiresAt)
                        )}
                      </td>
                      <td className="py-2 px-2 text-right">
                        <Badge variant="secondary" className="font-mono text-[10px]">
                          {s.requestCount}
                        </Badge>
                      </td>
                      <td className="py-2 px-2 text-right whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          title="Test cookies/token"
                          onClick={() => testSession(s.id, s.label, s.deviceId)}
                        >
                          <FlaskConical className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          title="Refresh"
                          onClick={() => refresh(s.id, s.label)}
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-rose-400 hover:text-rose-300"
                          onClick={() => del(s.id)}
                        >
                          ×
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
