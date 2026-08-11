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
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, type DashboardData } from '@/lib/dashboard/types'
import { ForgeIcon } from '@/components/ui/forge-icon'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

interface ProbeResult {
  ok: boolean
  websiteReachable: boolean
  websiteStatus?: number
  openaiCompat: boolean
  modelsEndpoint?: string
  detectedModels: string[]
  suggestedApiBaseUrl?: string
  error?: string
  hints: string[]
}

export function ProvidersTable() {
  const qc = useQueryClient()
  const [waitingKey, setWaitingKey] = useState<string | null>(null)
  const { data, refetch } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => api('/api/dashboard'),
    refetchInterval: waitingKey ? 2000 : 5000,
  })
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [showAdd, setShowAdd] = useState(false)
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [apiBaseUrl, setApiBaseUrl] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [key, setKey] = useState('')
  const [modelsText, setModelsText] = useState('')
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [busy, setBusy] = useState<'probe' | 'create' | null>(null)
  const [editKey, setEditKey] = useState<string | null>(null)
  const [manageKey, setManageKey] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const [editApiBase, setEditApiBase] = useState('')

  useEffect(() => {
    if (!waitingKey || !data) return
    const provider = data.providers.find((p) => p.key === waitingKey)
    if (provider && provider.activeSessions > 0) {
      toast.success(`Extension connected ${provider.displayName}`)
      setWaitingKey(null)
    }
  }, [waitingKey, data])

  // Clear waiting UI if OAuth wait exceeds ~5 min without an active session.
  useEffect(() => {
    if (!waitingKey) return
    const t = window.setTimeout(() => {
      setWaitingKey((k) => {
        if (k) {
          toast.error(
            `Still no session for ${k}. Sign in in the extension tab, then click OAuth login again.`,
          )
        }
        return null
      })
    }, 5 * 60 * 1000)
    return () => window.clearTimeout(t)
  }, [waitingKey])

  if (!data) return null

  const onlineDevices = data.stats.onlineDevices ?? 0

  const importModels = async (providerKey: string) => {
    setPending((p) => ({ ...p, [providerKey]: true }))
    const t = toast.loading(`Importing models from ${providerKey} API…`)
    try {
      const r = await api<{ ok: boolean; count?: number; models?: unknown[]; error?: string }>(
        '/api/providers/models/import',
        {
          method: 'POST',
          body: JSON.stringify({ providerKey }),
        },
      )
      await qc.invalidateQueries({ queryKey: ['dashboard'] })
      if (r.ok) {
        toast.success(`Imported ${r.count ?? (r.models as unknown[])?.length ?? 0} models`, {
          id: t,
        })
      } else {
        toast.error(r.error || 'Import failed', { id: t })
      }
    } catch (e) {
      toast.error(String(e), { id: t })
    } finally {
      setPending((p) => ({ ...p, [providerKey]: false }))
    }
  }

  const retryCapture = async (providerKey: string, websiteUrl?: string) => {
    setPending((p) => ({ ...p, [providerKey]: true }))
    const t = toast.loading(`Asking extension to open OAuth for ${providerKey}…`)
    try {
      const r = await api<{
        ok: boolean
        notified: number
        online?: number
        websiteUrl?: string
        loginUrl?: string
        message?: string
      }>('/api/providers', {
        method: 'POST',
        body: JSON.stringify({
          action: 'connect',
          key: providerKey,
          websiteUrl: websiteUrl || undefined,
        }),
      })
      // Extension opens + focuses the login tab and waits for auth.
      // Only open from the web app as fallback when no extension is online.
      const loginUrl = r.loginUrl || r.websiteUrl
      if (loginUrl && !(r.online && r.online > 0)) {
        window.open(loginUrl, '_blank', 'noopener,noreferrer')
      }
      setWaitingKey(providerKey)
      toast.success(
        r.message ||
          'Sign in in the tab Mirage opened — session will appear here after login',
        { id: t, duration: 8000 },
      )
      await refetch()
    } catch (e) {
      toast.error(String(e), { id: t })
    } finally {
      setPending((p) => ({ ...p, [providerKey]: false }))
    }
  }

  const deleteOne = async (providerKey: string, display: string) => {
    if (
      !confirm(
        `Delete provider “${display}” (${providerKey}) and all its sessions/models?`,
      )
    ) {
      return
    }
    setPending((p) => ({ ...p, [providerKey]: true }))
    const t = toast.loading(`Deleting ${providerKey}…`)
    try {
      await api(`/api/providers?key=${encodeURIComponent(providerKey)}`, {
        method: 'DELETE',
      })
      toast.success(`Deleted ${providerKey}`, { id: t })
      if (editKey === providerKey) setEditKey(null)
      if (manageKey === providerKey) setManageKey(null)
      await qc.invalidateQueries({ queryKey: ['dashboard'] })
    } catch (e) {
      toast.error(String(e), { id: t })
    } finally {
      setPending((p) => ({ ...p, [providerKey]: false }))
    }
  }

  const clearSessions = async (providerKey: string) => {
    if (!confirm(`Clear all sessions/tokens for ${providerKey}?`)) return
    setPending((p) => ({ ...p, [providerKey]: true }))
    const t = toast.loading(`Clearing sessions…`)
    try {
      const r = await api<{ clearedSessions?: number }>('/api/providers', {
        method: 'PATCH',
        body: JSON.stringify({ key: providerKey, action: 'clearSessions' }),
      })
      toast.success(`Cleared ${r.clearedSessions ?? 0} sessions`, { id: t })
      await qc.invalidateQueries({ queryKey: ['dashboard'] })
    } catch (e) {
      toast.error(String(e), { id: t })
    } finally {
      setPending((p) => ({ ...p, [providerKey]: false }))
    }
  }

  const clearSiteChats = async (providerKey: string, display: string) => {
    const mirageOnly = providerKey === 'kimi'
    const msg = mirageOnly
      ? `Delete Mirage-named chats on kimi.com for “${display}”? (provider site — not Mirage logs)`
      : `Delete chat history ON the provider website for “${display}” (${providerKey})?\n\nThis uses your captured login and removes conversations on their site — not Mirage request logs.`
    if (!confirm(msg)) return
    setPending((p) => ({ ...p, [providerKey]: true }))
    const t = toast.loading(`Clearing chats on ${providerKey}…`)
    try {
      const r = await api<{
        ok: boolean
        deleted?: number
        listed?: number
        detail?: string
        error?: string
      }>('/api/providers', {
        method: 'PATCH',
        body: JSON.stringify({
          key: providerKey,
          action: 'clearRemoteChats',
          mirageOnly,
        }),
      })
      if (!r.ok) throw new Error(r.error || 'Clear failed')
      toast.success(
        r.detail ||
          `Deleted ${r.deleted ?? 0} remote chat(s)` +
            (r.listed != null ? ` (listed ${r.listed})` : ''),
        { id: t },
      )
    } catch (e) {
      toast.error(String(e), { id: t })
    } finally {
      setPending((p) => ({ ...p, [providerKey]: false }))
    }
  }

  const openEdit = (p: {
    key: string
    displayName: string
    websiteUrl: string
    apiBaseUrl?: string | null
  }) => {
    setManageKey(null)
    setEditKey(p.key)
    setEditName(p.displayName)
    setEditUrl(p.websiteUrl || '')
    setEditApiBase(p.apiBaseUrl || '')
  }

  const saveEdit = async (providerKey: string) => {
    setPending((p) => ({ ...p, [providerKey]: true }))
    const t = toast.loading('Saving…')
    try {
      await api('/api/providers', {
        method: 'PATCH',
        body: JSON.stringify({
          key: providerKey,
          displayName: editName.trim() || undefined,
          websiteUrl: editUrl.trim() || undefined,
          apiBaseUrl: editApiBase.trim(),
        }),
      })
      toast.success('Saved', { id: t })
      setEditKey(null)
      await qc.invalidateQueries({ queryKey: ['dashboard'] })
    } catch (e) {
      toast.error(String(e), { id: t })
    } finally {
      setPending((p) => ({ ...p, [providerKey]: false }))
    }
  }

  const restoreDefaults = async () => {
    const t = toast.loading('Restoring default providers…')
    try {
      await api('/api/providers?restoreDefaults=1', { method: 'DELETE' })
      toast.success('Defaults restored', { id: t })
      await qc.invalidateQueries({ queryKey: ['dashboard'] })
    } catch (e) {
      toast.error(String(e), { id: t })
    }
  }

  const toggle = async (providerKey: string, enabled: boolean) => {
    setPending((p) => ({ ...p, [providerKey]: true }))
    try {
      await api('/api/providers', {
        method: 'PATCH',
        body: JSON.stringify({ key: providerKey, enabled }),
      })
      await refetch()
    } finally {
      setPending((p) => ({ ...p, [providerKey]: false }))
    }
  }

  const runProbe = async () => {
    if (!websiteUrl.trim()) {
      toast.error('Website URL is required')
      return
    }
    setBusy('probe')
    setProbe(null)
    const t = toast.loading('Checking platform…')
    try {
      const r = await api<{ probe: ProbeResult }>('/api/providers', {
        method: 'POST',
        body: JSON.stringify({
          action: 'probe',
          websiteUrl: websiteUrl.trim(),
          apiBaseUrl: apiBaseUrl.trim() || undefined,
        }),
      })
      setProbe(r.probe)
      if (r.probe.suggestedApiBaseUrl && !apiBaseUrl.trim()) {
        setApiBaseUrl(r.probe.suggestedApiBaseUrl)
      }
      if (r.probe.detectedModels.length && !modelsText.trim()) {
        setModelsText(r.probe.detectedModels.slice(0, 8).join(', '))
      }
      if (r.probe.ok) {
        toast.success('Platform reachable — ready to connect', { id: t })
      } else {
        toast.error(r.probe.error || 'Probe failed', { id: t })
      }
    } catch (e) {
      toast.error(String(e), { id: t })
    } finally {
      setBusy(null)
    }
  }

  const createPlatform = async () => {
    if (!websiteUrl.trim()) {
      toast.error('Website URL is required')
      return
    }
    setBusy('create')
    const t = toast.loading('Adding platform…')
    try {
      const models = modelsText
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
      const r = await api<{
        ok: boolean
        message?: string
        devicesNotified?: number
        loginUrl?: string
        provider: { key: string; displayName: string }
      }>('/api/providers', {
        method: 'POST',
        body: JSON.stringify({
          action: 'create',
          websiteUrl: websiteUrl.trim(),
          apiBaseUrl: apiBaseUrl.trim() || undefined,
          displayName: displayName.trim() || undefined,
          key: key.trim() || undefined,
          models: models.length ? models : undefined,
        }),
      })
      toast.success(r.message || `Added ${r.provider.displayName}`, { id: t })
      // Create already notified the extension (sync + capture). Only re-connect
      // when no device was reached on create.
      if (!(r.devicesNotified && r.devicesNotified > 0)) {
        const connected = await api<{
          ok: boolean
          online?: number
          loginUrl?: string
          websiteUrl?: string
          message?: string
        }>('/api/providers', {
          method: 'POST',
          body: JSON.stringify({
            action: 'connect',
            key: r.provider.key,
            websiteUrl: websiteUrl.trim(),
          }),
        })
        if (
          connected.loginUrl &&
          !(connected.online && connected.online > 0)
        ) {
          window.open(connected.loginUrl, '_blank', 'noopener,noreferrer')
        }
        if (connected.message) {
          toast.message(connected.message, { duration: 8000 })
        }
      }
      setWaitingKey(r.provider.key)
      setShowAdd(false)
      setWebsiteUrl('')
      setApiBaseUrl('')
      setDisplayName('')
      setKey('')
      setModelsText('')
      setProbe(null)
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    } catch (e) {
      toast.error(String(e), { id: t })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="border-0 bg-surface shadow-neo rounded-2xl">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ForgeIcon name="plug" neo size={18} />
            Providers
          </CardTitle>
          <CardDescription>
            Paste a platform URL → Mirage probes it and builds an OAuth login
            link. Sign in in the browser; the extension only refreshes tokens
            every ~12 minutes.
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            className="shadow-neo border-0 bg-surface"
            onClick={restoreDefaults}
          >
            Restore defaults
          </Button>
          <Button
            size="sm"
            className="btn-brand border-0"
            onClick={() => setShowAdd((v) => !v)}
          >
            <ForgeIcon name="plug" size={14} />
            <span className="ml-1">Add platform</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {showAdd && (
          <div className="rounded-2xl neo-inset p-4 space-y-3">
            <div className="text-sm font-medium text-foreground flex items-center gap-2">
              <ForgeIcon name="login" size={16} />
              Add platform & OAuth login
            </div>
            <p className="text-xs text-muted-foreground">
              Only the website URL is required. Check probes the site, then
              Connect creates the provider, opens the OAuth login link, and
              asks the extension for a one-shot capture after you sign in.
            </p>
            {waitingKey && (
              <div className="flex items-center gap-2 text-xs text-warning">
                <ForgeIcon name="refresh" size={14} />
                Waiting for OAuth connect of{' '}
                <code className="font-mono">{waitingKey}</code>…
              </div>
            )}
            <div className="grid md:grid-cols-2 gap-3">
              <div className="space-y-1.5 md:col-span-2">
                <Label className="text-xs">Website URL *</Label>
                <Input
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                  placeholder="https://chat.example.com"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">API Base URL (optional, …/v1)</Label>
                <Input
                  value={apiBaseUrl}
                  onChange={(e) => setApiBaseUrl(e.target.value)}
                  placeholder="https://chat.example.com/v1"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Display name</Label>
                <Input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="My Free AI"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Key (slug)</Label>
                <Input
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="my-free-ai"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Model IDs (comma-separated)</Label>
                <Input
                  value={modelsText}
                  onChange={(e) => setModelsText(e.target.value)}
                  placeholder="gpt-4o-mini, llama-3.3-70b"
                  className="font-mono text-xs"
                />
              </div>
            </div>

            {probe && (
              <div className="rounded-xl neo-surface p-3 text-xs space-y-1.5">
                <div className="flex items-center gap-2 font-medium">
                  {probe.ok ? (
                    <ForgeIcon name="check" size={14} />
                  ) : (
                    <ForgeIcon name="alert" size={14} />
                  )}
                  Probe result
                </div>
                <div className="text-muted-foreground">
                  Website: {probe.websiteReachable ? 'reachable' : 'down'}
                  {probe.websiteStatus != null ? ` (${probe.websiteStatus})` : ''}
                  {' · '}
                  OpenAI-compat: {probe.openaiCompat ? 'yes' : 'no'}
                  {probe.modelsEndpoint ? ` · /models: ${probe.modelsEndpoint}` : ''}
                </div>
                {probe.detectedModels.length > 0 && (
                  <div>
                    Models:{' '}
                    <code className="text-[10px]">
                      {probe.detectedModels.slice(0, 8).join(', ')}
                    </code>
                  </div>
                )}
                {probe.hints.map((h) => (
                  <div key={h} className="text-muted-foreground">
                    • {h}
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                className="shadow-neo border-0 bg-surface"
                onClick={runProbe}
                disabled={busy !== null}
              >
                <ForgeIcon name="refresh" size={14} />
                <span className="ml-1">Check</span>
              </Button>
              <Button
                size="sm"
                className="btn-brand border-0"
                onClick={createPlatform}
                disabled={busy !== null}
              >
                <ForgeIcon name="login" size={14} />
                <span className="ml-1">Create + OAuth login</span>
              </Button>
            </div>
          </div>
        )}

        <div className="rounded-2xl neo-inset p-3 text-xs text-muted-foreground space-y-1">
          <div>
            <strong className="text-foreground">Extension:</strong>{' '}
            {onlineDevices > 0 ? (
              <span className="text-success">{onlineDevices} online · refresh ~12m</span>
            ) : (
              <span className="text-warning">
                none online — download Mirage extension and set Backend URL
              </span>
            )}
          </div>
          <div>
            <strong className="text-foreground">Connect:</strong> Extension
            opens OAuth, waits for login, then posts the session here.
          </div>
        </div>

        <div className="grid gap-3">
          {data.providers.map((p) => {
            const waiting =
              p.waitingForExtension ||
              (waitingKey === p.key && p.activeSessions === 0)
            const editing = editKey === p.key
            const managing = manageKey === p.key
            return (
            <div
              key={p.key}
              className="rounded-2xl bg-surface shadow-neo p-3 space-y-3"
            >
              <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{p.displayName}</span>
                  <code className="text-[11px] text-muted-foreground">{p.key}</code>
                  {p.chatCapable ? (
                    <Badge className="text-[10px] bg-muted text-foreground shadow-neo border-0">
                      chat
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      session only
                    </Badge>
                  )}
                  {waiting && (
                    <Badge
                      variant="outline"
                      className="text-[10px] border-amber-500/40 text-amber-300"
                    >
                      {onlineDevices > 0
                        ? 'waiting for extension'
                        : 'extension offline'}
                    </Badge>
                  )}
                  <Badge variant={p.activeSessions > 0 ? 'default' : 'secondary'}>
                    {p.activeSessions > 0 ? 'live' : 'idle'}
                  </Badge>
                </div>
                <a
                  href={p.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mt-1"
                >
                  {p.websiteUrl}
                  <ForgeIcon name="external" size={12} />
                </a>
                <div className="text-[11px] text-muted-foreground mt-1">
                  {p.activeSessions}/{p.sessionCount} sessions · {p.models} models
                  {p.hasAuthToken === false && p.activeSessions > 0
                    ? ' · no token'
                    : ''}
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  className="mirage-icon-btn"
                  title="Edit"
                  disabled={pending[p.key]}
                  onClick={() =>
                    editing
                      ? setEditKey(null)
                      : openEdit(p)
                  }
                >
                  <ForgeIcon name="list" size={16} />
                </button>
                <button
                  type="button"
                  className="mirage-icon-btn"
                  title="Manage"
                  disabled={pending[p.key]}
                  onClick={() => {
                    setEditKey(null)
                    setManageKey(managing ? null : p.key)
                  }}
                >
                  <ForgeIcon name="puzzle" size={16} />
                </button>
                <button
                  type="button"
                  className="mirage-icon-btn"
                  title="Delete this provider"
                  disabled={pending[p.key]}
                  onClick={() => void deleteOne(p.key, p.displayName)}
                >
                  <ForgeIcon name="trash" size={16} />
                </button>
                <Switch
                  checked={p.enabled}
                  onCheckedChange={(v) => toggle(p.key, v)}
                  disabled={pending[p.key]}
                />
              </div>
              </div>

              {editing && (
                <div className="neo-inset rounded-xl p-3 space-y-3">
                  <div className="text-xs font-medium text-foreground">Edit provider</div>
                  <div className="grid md:grid-cols-3 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[10px]">Display name</Label>
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px]">Website / OAuth URL</Label>
                      <Input
                        value={editUrl}
                        onChange={(e) => setEditUrl(e.target.value)}
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px]">API Base (optional)</Label>
                      <Input
                        value={editApiBase}
                        onChange={(e) => setEditApiBase(e.target.value)}
                        className="h-8 text-xs font-mono"
                        placeholder="https://…/v1"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="btn-brand border-0"
                      disabled={pending[p.key]}
                      onClick={() => void saveEdit(p.key)}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditKey(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {managing && (
                <div className="neo-inset rounded-xl p-3 space-y-2">
                  <div className="text-xs font-medium text-foreground">Manage</div>
                  {p.modelsHint && (
                    <div className="text-[10px] text-warning">{p.modelsHint}</div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="btn-brand border-0"
                      disabled={pending[p.key]}
                      onClick={() => retryCapture(p.key, p.websiteUrl || undefined)}
                    >
                      <ForgeIcon name="login" size={14} />
                      <span className="ml-1">OAuth login</span>
                    </Button>
                    {p.chatCapable && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={pending[p.key]}
                        onClick={() => importModels(p.key)}
                      >
                        <ForgeIcon name="list" size={14} />
                        <span className="ml-1">Import models</span>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending[p.key]}
                      onClick={() => void clearSessions(p.key)}
                    >
                      <ForgeIcon name="clear" size={14} />
                      <span className="ml-1">Clear sessions</span>
                    </Button>
                    {['kimi', 'qwen', 'deepseek', 'claude'].includes(p.key) && (
                      <Button
                        size="sm"
                        className="btn-destructive-neo border-0"
                        disabled={pending[p.key] || p.activeSessions === 0}
                        onClick={() => void clearSiteChats(p.key, p.displayName)}
                        title="Delete conversations on the provider website"
                      >
                        <ForgeIcon name="trash" size={14} />
                        <span className="ml-1">Clear site chats</span>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      className="btn-destructive-neo border-0"
                      disabled={pending[p.key]}
                      onClick={() => void deleteOne(p.key, p.displayName)}
                    >
                      <ForgeIcon name="trash" size={14} />
                      <span className="ml-1">Delete provider</span>
                    </Button>
                  </div>
                </div>
              )}
            </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
