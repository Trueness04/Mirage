'use client'

import { useState } from 'react'
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
import { api, type DashboardData, timeAgo } from '@/lib/dashboard/types'
import {
  Download,
  Cpu,
  Zap,
  Activity,
  Globe,
  Clock,
  Loader2,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

async function downloadExtensionZip() {
  // 1) Prefer static file (no API / no ZIP-at-request-time)
  // 2) Fall back to API route
  // 3) Always trigger via blob URL so the SPA never navigates away
  const urls = ['/mirage-extension.zip', '/api/extension/download']
  let lastError = 'Download failed'
  for (const url of urls) {
    try {
      const resp = await fetch(url, { cache: 'no-store' })
      if (!resp.ok) {
        lastError = `${url} → HTTP ${resp.status}`
        continue
      }
      const type = resp.headers.get('content-type') || ''
      if (type.includes('application/json')) {
        const j = (await resp.json().catch(() => ({}))) as { error?: string }
        lastError = j.error || lastError
        continue
      }
      const blob = await resp.blob()
      if (blob.size < 100) {
        lastError = `${url} returned empty file`
        continue
      }
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = 'mirage-extension.zip'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
      return
    } catch (e) {
      lastError = String((e as Error).message || e)
    }
  }
  throw new Error(lastError)
}

export function ExtensionCard() {
  const [downloading, setDownloading] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const qc = useQueryClient()
  const { data } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => api('/api/dashboard'),
    refetchInterval: 5000,
  })

  if (!data) return null

  const onDownload = async () => {
    setDownloading(true)
    const t = toast.loading('Preparing extension zip…')
    try {
      await downloadExtensionZip()
      toast.success('Download started', { id: t })
    } catch (e) {
      toast.error(String(e), { id: t })
    } finally {
      setDownloading(false)
    }
  }

  const onRemoveDevice = async (id: string, label: string) => {
    if (!confirm(`Remove device ${label}? It can re-register on next heartbeat.`)) {
      return
    }
    setRemovingId(id)
    const t = toast.loading('Removing device…')
    try {
      await api(`/api/devices?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      await qc.invalidateQueries({ queryKey: ['dashboard'] })
      toast.success('Device removed', { id: t })
    } catch (e) {
      toast.error(String(e), { id: t })
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <Card className="border-0 bg-surface shadow-neo">
      <CardHeader>
        <CardTitle>Chrome Extension</CardTitle>
        <CardDescription>
          Capture &amp; refresh sessions from the browser. Download and load it as an
          unpacked extension.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-2xl neo-surface p-4">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="w-4 h-4" style={{ color: '#1902c5' }} />
            <span className="text-sm font-semibold text-foreground">
              Automatic capture — no buttons to press
            </span>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Once installed, the extension watches for login activity on every
            supported AI site and forwards sessions automatically:
          </p>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="flex items-start gap-2">
              <Activity className="w-3 h-3 mt-0.5 shrink-0" style={{ color: '#1902c5' }} />
              <div>
                <div className="font-medium">Cookie change</div>
                <div className="text-muted-foreground">Fires instantly when login cookies are set</div>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Globe className="w-3 h-3 mt-0.5 shrink-0" style={{ color: '#1902c5' }} />
              <div>
                <div className="font-medium">Tab load</div>
                <div className="text-muted-foreground">On navigation to AI sites</div>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Cpu className="w-3 h-3 text-violet-400 mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">Token observed</div>
                <div className="text-muted-foreground">In Authorization header or localStorage</div>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Clock className="w-3 h-3 text-amber-400 mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">Periodic</div>
                <div className="text-muted-foreground">Every 5 min safety-net tick</div>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-md bg-background/60 border border-border/30 p-4">
          <div className="text-xs text-muted-foreground mb-2">Installation steps</div>
          <ol className="text-sm space-y-1 list-decimal list-inside">
            <li>
              Download the extension .zip (below) and unzip into a folder.
            </li>
            <li>
              Open <code className="font-mono text-xs">chrome://extensions</code>.
            </li>
            <li>
              Enable <strong>Developer mode</strong> (top-right).
            </li>
            <li>
              Click <strong>Load unpacked</strong> and select the folder.
            </li>
            <li>
              Open the extension popup, set the Backend URL to point at this server.
            </li>
            <li>
              Log into each AI site (kimi.com, claude.ai, …) as usual — the
              extension auto-captures the session.
            </li>
          </ol>
        </div>

        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">Download</div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onDownload} disabled={downloading}>
              {downloading ? (
                <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5 mr-1" />
              )}
              Download extension .zip
            </Button>
            <a
              href="/mirage-extension.zip"
              download="mirage-extension.zip"
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              direct link
            </a>
          </div>
        </div>

        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide mb-2">
            Registered devices ({data.devices.length})
          </div>
          {data.devices.length === 0 ? (
            <div className="text-sm text-muted-foreground italic">
              No devices registered yet.
            </div>
          ) : (
            <div className="space-y-1">
              {data.devices.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between gap-3 text-sm p-2 rounded bg-background/50 border border-border/20"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Cpu className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                    <span className="font-mono text-xs truncate">
                      {d.deviceId.slice(0, 24)}
                    </span>
                    {d.displayName && (
                      <span className="text-xs text-muted-foreground">
                        ({d.displayName})
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground">
                      seen {timeAgo(d.lastSeenAt)}
                    </span>
                    <Badge variant={d.enabled ? 'default' : 'secondary'}>
                      {d.enabled ? 'live' : 'paused'}
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      title="Remove device"
                      disabled={removingId === d.id}
                      onClick={() =>
                        onRemoveDevice(
                          d.id,
                          d.displayName || d.deviceId.slice(0, 16),
                        )
                      }
                    >
                      {removingId === d.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
