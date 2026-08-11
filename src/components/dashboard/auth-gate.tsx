'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/dashboard/types'
import { ForgeIcon } from '@/components/ui/forge-icon'
import { toast } from 'sonner'

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'loading' | 'ok' | 'locked'>('loading')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  const check = async () => {
    try {
      const s = await api<{ ok: boolean; secretConfigured: boolean }>(
        '/api/auth/status',
      )
      if (s.ok) setState('ok')
      else {
        setState('locked')
        setHint(
          s.secretConfigured
            ? 'Enter MIRAGE_ADMIN_SECRET from your server .env'
            : 'Set MIRAGE_ADMIN_SECRET in .env (required in production)',
        )
      }
    } catch {
      setState('locked')
      setHint('Unable to reach auth status endpoint')
    }
  }

  useEffect(() => {
    check()
  }, [])

  const login = async () => {
    setBusy(true)
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ secret }),
      })
      toast.success('Unlocked')
      setSecret('')
      setState('ok')
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground gap-3">
        <span className="mirage-icon-btn">
          <ForgeIcon name="refresh" size={18} />
        </span>
        Checking access…
      </div>
    )
  }

  if (state === 'locked') {
    return (
      <div className="max-w-md mx-auto mt-10 neo-surface rounded-3xl p-8 space-y-5">
        <div className="flex items-center gap-3">
          <div className="mirage-logo-tile">
            <img src="/logo.png" alt="" width={40} height={40} />
          </div>
          <div>
            <div className="font-semibold text-lg">Unlock Mirage</div>
            <p className="text-sm text-muted-foreground">{hint}</p>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Admin secret</Label>
          <Input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') login()
            }}
            placeholder="MIRAGE_ADMIN_SECRET"
            className="font-mono text-xs neo-inset border-0 rounded-xl"
          />
        </div>
        <Button
          className="w-full btn-brand border-0 rounded-xl h-11"
          onClick={login}
          disabled={busy || !secret.trim()}
        >
          Unlock dashboard
        </Button>
      </div>
    )
  }

  return <>{children}</>
}
