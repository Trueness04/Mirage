'use client'

import { useQuery } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { api, type DashboardData } from '@/lib/dashboard/types'
import { ForgeIcon, type ForgeIconName } from '@/components/ui/forge-icon'

export function StatsGrid() {
  const { data } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => api('/api/dashboard'),
    refetchInterval: 5000,
  })

  if (!data) return null

  const s = data.stats
  const items: {
    label: string
    value: string | number
    icon: ForgeIconName
    hint: string
  }[] = [
    {
      label: 'Providers',
      value: s.providers,
      icon: 'plug',
      hint: 'registered adapters',
    },
    {
      label: 'Active Sessions',
      value: s.activeSessions,
      icon: 'user',
      hint: `${s.expiredSessions} expired · ${s.errorSessions} error`,
    },
    {
      label: 'API Keys',
      value: s.apiKeys,
      icon: 'key',
      hint: 'OpenAI-compatible keys',
    },
    {
      label: 'Devices',
      value: s.devices,
      icon: 'puzzle',
      hint: 'browser extensions',
    },
    {
      label: 'Total Requests',
      value: s.totalRequests,
      icon: 'list',
      hint: 'served via /v1/*',
    },
    {
      label: 'Coverage',
      value: `${data.providers.filter((p) => p.activeSessions > 0).length}/${s.providers}`,
      icon: 'check',
      hint: 'providers with sessions',
    },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {items.map((it) => (
        <Card
          key={it.label}
          className="p-4 hover:shadow-cta transition-shadow gap-2"
        >
          <div className="flex items-start justify-between mb-1">
            <span className="text-xs text-muted-foreground uppercase tracking-wide">
              {it.label}
            </span>
            <ForgeIcon name={it.icon} neo size={14} />
          </div>
          <div className="text-2xl font-bold text-foreground">{it.value}</div>
          <div className="text-[11px] text-muted-foreground">{it.hint}</div>
        </Card>
      ))}
    </div>
  )
}
