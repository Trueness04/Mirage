'use client'

import { Fragment, useMemo, useState } from 'react'
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
import { api, type LogRow, timeAgo } from '@/lib/dashboard/types'
import { ChevronDown, ChevronRight, Copy, Filter } from 'lucide-react'
import { toast } from 'sonner'

function formatMs(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function statusVariant(
  status: number,
): 'default' | 'secondary' | 'destructive' {
  if (status >= 200 && status < 300) return 'default'
  if (status >= 400 && status < 500) return 'secondary'
  return 'destructive'
}

export function LogsTable() {
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data, refetch } = useQuery<{ logs: LogRow[]; total: number }>({
    queryKey: ['logs'],
    queryFn: () => api('/api/logs?limit=100'),
    refetchInterval: 4000,
  })

  const logs = useMemo(() => {
    const rows = data?.logs ?? []
    if (!errorsOnly) return rows
    return rows.filter((l) => l.status >= 400 || Boolean(l.errorMessage))
  }, [data?.logs, errorsOnly])

  const copyError = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Copied')
    } catch {
      toast.error('Copy failed')
    }
  }

  const clearChats = async () => {
    if (!confirm('Clear all Mirage request logs? (Does not delete chats on provider sites)')) return
    try {
      const r = await api<{ deleted?: number }>('/api/logs?all=1', {
        method: 'DELETE',
      })
      toast.success(`Cleared ${r.deleted ?? 0} logs`)
      await refetch()
      await qc.invalidateQueries({ queryKey: ['dashboard'] })
    } catch (e) {
      toast.error(String(e))
    }
  }

  return (
    <Card className="border-0 bg-surface shadow-neo rounded-2xl">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Request Logs</CardTitle>
          <CardDescription>
            Live <code className="font-mono">/v1/*</code> traffic — click a row for
            the full error.
          </CardDescription>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            type="button"
            size="sm"
            className="btn-destructive-neo border-0"
            onClick={() => void clearChats()}
          >
            Clear logs
          </Button>
          <Button
            type="button"
            size="sm"
            variant={errorsOnly ? 'default' : 'outline'}
            className={errorsOnly ? 'btn-brand border-0' : 'shadow-neo border-0 bg-surface'}
            onClick={() => setErrorsOnly((v) => !v)}
          >
            <Filter className="w-3.5 h-3.5 mr-1" />
            Errors only
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!data || logs.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            {data && errorsOnly
              ? 'No error logs in the latest batch.'
              : 'No requests logged yet.'}
          </div>
        ) : (
          <div className="max-h-[520px] overflow-y-auto pr-2 -mr-2">
            <table className="w-full text-sm">
              <thead className="text-[11px] text-muted-foreground uppercase tracking-wide sticky top-0 bg-card/95 backdrop-blur z-10">
                <tr className="border-b border-border/40">
                  <th className="text-left py-2 px-2 w-8" />
                  <th className="text-left py-2 px-2">Time</th>
                  <th className="text-left py-2 px-2">Model</th>
                  <th className="text-left py-2 px-2">Status</th>
                  <th className="text-left py-2 px-2">ms</th>
                  <th className="text-left py-2 px-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => {
                  const open = expanded === l.id
                  const err = (l.errorMessage || '').trim()
                  return (
                    <Fragment key={l.id}>
                      <tr
                        className="border-b border-border/20 hover:bg-background/40 cursor-pointer"
                        onClick={() => setExpanded(open ? null : l.id)}
                      >
                        <td className="py-2 px-2 text-muted-foreground">
                          {open ? (
                            <ChevronDown className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5" />
                          )}
                        </td>
                        <td className="py-2 px-2 text-xs text-muted-foreground whitespace-nowrap">
                          {timeAgo(l.createdAt)}
                        </td>
                        <td className="py-2 px-2">
                          <code className="text-xs break-all">
                            {l.model || '—'}
                          </code>
                        </td>
                        <td className="py-2 px-2">
                          <Badge variant={statusVariant(l.status)}>
                            {l.status}
                            {l.upstreamStatus != null &&
                            l.upstreamStatus !== l.status
                              ? ` ← ${l.upstreamStatus}`
                              : ''}
                          </Badge>
                        </td>
                        <td className="py-2 px-2 text-xs text-muted-foreground whitespace-nowrap">
                          {formatMs(l.durationMs)}
                        </td>
                        <td className="py-2 px-2 text-xs max-w-[280px]">
                          {err ? (
                            <span
                              className="text-destructive/90 line-clamp-2"
                              title={err}
                            >
                              {err}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                      {open ? (
                        <tr className="border-b border-border/30 bg-background/30">
                          <td colSpan={6} className="p-3">
                            <div className="grid gap-2 text-xs sm:grid-cols-2">
                              <div>
                                <div className="text-muted-foreground uppercase tracking-wide mb-1">
                                  Request
                                </div>
                                <div className="space-y-1 font-mono">
                                  <div>
                                    {l.method} {l.endpoint}
                                  </div>
                                  <div>stream: {l.stream ? 'yes' : 'no'}</div>
                                  <div>
                                    session: {l.sessionLabel || '—'}
                                  </div>
                                  <div>
                                    api key:{' '}
                                    {l.apiKey
                                      ? `${l.apiKey.label || 'key'} (${l.apiKey.keyPrefix}…)`
                                      : '—'}
                                  </div>
                                  <div>
                                    upstream: {l.upstreamStatus ?? '—'}
                                  </div>
                                  <div>
                                    duration: {formatMs(l.durationMs)}
                                  </div>
                                </div>
                              </div>
                              <div>
                                <div className="flex items-center justify-between gap-2 mb-1">
                                  <div className="text-muted-foreground uppercase tracking-wide">
                                    Error detail
                                  </div>
                                  {err ? (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 px-2"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        void copyError(err)
                                      }}
                                    >
                                      <Copy className="w-3 h-3 mr-1" />
                                      Copy
                                    </Button>
                                  ) : null}
                                </div>
                                <pre className="whitespace-pre-wrap break-words rounded-md border border-border/40 bg-card/50 p-2 max-h-48 overflow-auto text-[11px] leading-relaxed">
                                  {err || '(no errorMessage stored for this row)'}
                                </pre>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
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
