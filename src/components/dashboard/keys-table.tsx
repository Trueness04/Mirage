'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { api, type DashboardData } from '@/lib/dashboard/types'
import { Plus, Copy, Trash2, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

export function KeysTable() {
  const qc = useQueryClient()
  const { data } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => api('/api/dashboard'),
    refetchInterval: 8000,
  })

  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [createdKey, setCreatedKey] = useState<string | null>(null)

  if (!data) return null

  const create = async () => {
    try {
      const r = await api<{ key: string }>('/api/keys', {
        method: 'POST',
        body: JSON.stringify({ label: label || null }),
      })
      setCreatedKey(r.key)
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      toast.success('API key created')
    } catch (e) {
      toast.error(String(e))
    }
  }

  const toggle = async (id: string, enabled: boolean) => {
    await api('/api/keys', {
      method: 'PATCH',
      body: JSON.stringify({ id, enabled }),
    })
    qc.invalidateQueries({ queryKey: ['dashboard'] })
  }

  const del = async (id: string) => {
    if (!confirm('Delete this API key?')) return
    await api(`/api/keys?id=${id}`, { method: 'DELETE' })
    qc.invalidateQueries({ queryKey: ['dashboard'] })
    toast.success('Deleted')
  }

  return (
    <Card className="border-0 bg-surface shadow-neo">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>API Keys</CardTitle>
          <CardDescription>
            OpenAI-compatible keys. Plug into any client: base_url + bearer key.
          </CardDescription>
        </div>
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o)
            if (!o) {
              setCreatedKey(null)
              setLabel('')
            }
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="w-4 h-4 mr-1" />
              New Key
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create API Key</DialogTitle>
              <DialogDescription>
                The full key is shown only once. Copy it immediately.
              </DialogDescription>
            </DialogHeader>
            {createdKey ? (
              <div className="space-y-3">
                <Label>Your new API key</Label>
                <div className="flex gap-2">
                  <Input value={createdKey} readOnly className="font-mono text-xs" />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      navigator.clipboard.writeText(createdKey)
                      toast.success('Copied')
                    }}
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Use it as <code>Authorization: Bearer {createdKey.slice(0, 12)}...</code>
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="label">Label (optional)</Label>
                  <Input
                    id="label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. Personal laptop"
                  />
                </div>
                <DialogFooter>
                  <Button onClick={create}>Create</Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {data.apiKeys.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center flex flex-col items-center gap-2">
            <KeyRound className="w-6 h-6 opacity-30" />
            No API keys yet. Create one to start using Mirage.
          </div>
        ) : (
          <div className="space-y-2">
            {data.apiKeys.map((k) => (
              <div
                key={k.id}
                className="flex items-center justify-between gap-3 p-3 rounded-md bg-background/50 border border-border/30"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-xs">{k.keyPrefix}…</code>
                    {k.label && (
                      <span className="text-xs text-muted-foreground">{k.label}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {k.rateLimitRpm > 0 ? `${k.rateLimitRpm} RPM` : 'unlimited'} · created{' '}
                    {new Date(k.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={k.enabled ? 'default' : 'secondary'}>
                    {k.enabled ? 'active' : 'disabled'}
                  </Badge>
                  <Switch
                    checked={k.enabled}
                    onCheckedChange={(v) => toggle(k.id, v)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-rose-400 hover:text-rose-300 h-8 px-2"
                    onClick={() => del(k.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
