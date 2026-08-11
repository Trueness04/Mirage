'use client'

import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StatsGrid } from '@/components/dashboard/stats-grid'
import { ProvidersTable } from '@/components/dashboard/providers-table'
import { SessionsTable } from '@/components/dashboard/sessions-table'
import { KeysTable } from '@/components/dashboard/keys-table'
import { LogsTable } from '@/components/dashboard/logs-table'
import { ExtensionCard } from '@/components/dashboard/extension-card'
import { QuickStartCard } from '@/components/dashboard/quick-start-card'
import { PlaygroundCard } from '@/components/dashboard/playground-card'
import { AuthGate } from '@/components/dashboard/auth-gate'
import { ForgeIcon, type ForgeIconName } from '@/components/ui/forge-icon'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

type Panel =
  | 'home'
  | 'playground'
  | 'providers'
  | 'sessions'
  | 'keys'
  | 'extension'
  | 'guide'
  | 'logs'

const NAV: {
  id: Panel
  label: string
  icon: ForgeIconName
  blurb: string
}[] = [
  { id: 'home', label: 'Home', icon: 'home', blurb: 'Gateway pulse' },
  { id: 'playground', label: 'Play', icon: 'chat', blurb: 'Live chat' },
  { id: 'providers', label: 'Providers', icon: 'plug', blurb: 'OAuth connect' },
  { id: 'sessions', label: 'Sessions', icon: 'user', blurb: 'Captured logins' },
  { id: 'keys', label: 'Keys', icon: 'key', blurb: 'API access' },
  { id: 'extension', label: 'Extension', icon: 'puzzle', blurb: 'Token refresh' },
  { id: 'guide', label: 'Guide', icon: 'list', blurb: 'Quick start' },
  { id: 'logs', label: 'Logs', icon: 'list', blurb: 'Request trail' },
]

export default function HomePage() {
  const [panel, setPanel] = useState<Panel>('home')
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const origin = mounted ? window.location.origin : ''
  const active = NAV.find((n) => n.id === panel) ?? NAV[0]

  return (
    <QueryClientProvider client={queryClient}>
      <div className="mirage-shell min-h-screen">
        <div className="mirage-shell-inner">
          {/* Brand rail — not a top tab bar */}
          <aside className="mirage-rail">
            <div className="mirage-rail-brand">
              <div className="mirage-logo-tile animate-neo-pulse">
                <img src="/logo.png" alt="" width={36} height={36} />
              </div>
              <div className="mirage-wordmark">
                <span className="mirage-wordmark-title">Mirage</span>
                <span className="mirage-wordmark-sub">Gateway</span>
              </div>
            </div>

            <nav className="mirage-rail-nav" aria-label="Primary">
              {NAV.map((item) => {
                const on = panel === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setPanel(item.id)}
                    className={on ? 'mirage-nav-item is-active' : 'mirage-nav-item'}
                    title={item.blurb}
                  >
                    <span className="mirage-nav-icon">
                      <ForgeIcon name={item.icon} size={18} />
                    </span>
                    <span className="mirage-nav-meta">
                      <span className="mirage-nav-label">{item.label}</span>
                      <span className="mirage-nav-blurb">{item.blurb}</span>
                    </span>
                  </button>
                )
              })}
            </nav>

            <div className="mirage-rail-foot">
              <div className="mirage-endpoint">
                <ForgeIcon name="external" size={14} />
                <code>{origin ? `${origin}/v1` : '/v1'}</code>
              </div>
            </div>
          </aside>

          {/* Stage */}
          <div className="mirage-stage">
            <header className="mirage-stage-head">
              <div>
                <p className="mirage-kicker">{active.blurb}</p>
                <h1 className="mirage-stage-title">{active.label}</h1>
              </div>
              <div className="mirage-stage-actions">
                <button
                  type="button"
                  className="mirage-icon-btn"
                  onClick={() => setPanel('providers')}
                  title="Connect provider"
                >
                  <ForgeIcon name="login" size={18} />
                </button>
                <button
                  type="button"
                  className="mirage-icon-btn"
                  onClick={() => setPanel('logs')}
                  title="Logs"
                >
                  <ForgeIcon name="list" size={18} />
                </button>
              </div>
            </header>

            <AuthGate>
              <div className="mirage-stage-body animate-rise" key={panel}>
                {panel === 'home' && (
                  <section className="mirage-home">
                    <div className="mirage-hero neo-surface">
                      <p className="mirage-hero-brand">Mirage</p>
                      <h2 className="mirage-hero-line">
                        One OpenAI-compatible gate.
                        <br />
                        Every web AI behind it.
                      </h2>
                      <p className="mirage-hero-copy">
                        Connect platforms with OAuth login from this app. The
                        extension only refreshes tokens — every ~12 minutes, in
                        a short burst.
                      </p>
                      <div className="mirage-hero-cta">
                        <button
                          type="button"
                          className="btn-brand mirage-pill"
                          onClick={() => setPanel('providers')}
                        >
                          <ForgeIcon name="login" size={16} />
                          Connect provider
                        </button>
                        <button
                          type="button"
                          className="mirage-pill mirage-pill-ghost"
                          onClick={() => setPanel('playground')}
                        >
                          <ForgeIcon name="chat" size={16} />
                          Open playground
                        </button>
                      </div>
                    </div>
                    <StatsGrid />
                    <div className="mirage-home-grid">
                      <SessionsTable />
                      <KeysTable />
                    </div>
                  </section>
                )}

                {panel === 'playground' && (
                  <div className="mirage-panel-wide">
                    <PlaygroundCard />
                  </div>
                )}

                {panel === 'providers' && (
                  <section className="space-y-5">
                    <StatsGrid />
                    <ProvidersTable />
                  </section>
                )}

                {panel === 'sessions' && <SessionsTable />}
                {panel === 'keys' && <KeysTable />}
                {panel === 'extension' && <ExtensionCard />}
                {panel === 'guide' && (
                  <div className="mirage-home-grid">
                    <QuickStartCard />
                    <SessionsTable />
                  </div>
                )}
                {panel === 'logs' && <LogsTable />}
              </div>
            </AuthGate>
          </div>
        </div>
      </div>
    </QueryClientProvider>
  )
}
