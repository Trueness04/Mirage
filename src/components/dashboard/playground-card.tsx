'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { api, type DashboardData } from '@/lib/dashboard/types'
import { MessageSquare, RefreshCw, Square, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

type ChatRole = 'user' | 'assistant' | 'system'

interface ChatMessage {
  id: string
  role: ChatRole
  content: string
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function PlaygroundCard() {
  const qc = useQueryClient()
  const { data } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => api('/api/dashboard'),
    refetchInterval: 8000,
  })

  // Chat-capable providers (builtin / openai_compat). Models come from live API import.
  const enabledProviders = (data?.providers ?? [])
    .filter((p) => p.enabled && p.chatCapable === true)
    .slice()
    .sort((a, b) => {
      if (b.activeSessions !== a.activeSessions) {
        return b.activeSessions - a.activeSessions
      }
      return a.displayName.localeCompare(b.displayName)
    })

  const [providerKey, setProviderKey] = useState('')
  const [modelKey, setModelKey] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  // Import ONE provider only — never "all" (HF/Venice catalogs hang the UI).
  const refreshModelsFromApi = async (key: string) => {
    if (!key) return
    setImporting(true)
    try {
      const r = await api<{
        ok: boolean
        count?: number
        error?: string
      }>('/api/providers/models/import', {
        method: 'POST',
        body: JSON.stringify({ providerKey: key }),
      })
      await qc.invalidateQueries({ queryKey: ['dashboard'] })
      if (r.ok) toast.success(`Imported ${r.count ?? 0} models from API`)
      else toast.error(r.error || 'Model import failed')
    } catch (e) {
      toast.error(String(e))
    } finally {
      setImporting(false)
    }
  }

  const providerSig = enabledProviders
    .map((p) => `${p.key}:${p.modelsList.length}:${p.activeSessions}`)
    .join(',')

  useEffect(() => {
    if (!enabledProviders.length) return
    setProviderKey((prev) => {
      if (prev && enabledProviders.some((p) => p.key === prev)) return prev
      // Prefer builtins with models already in DB — never block UI waiting on import.
      const preferred =
        enabledProviders.find(
          (p) =>
            [
              'kimi',
              'zai',
              'deepseek',
              'claude',
              'qwen',
              'arena',
              'dola',
              'gemini',
            ].includes(p.key) &&
            p.activeSessions > 0 &&
            p.modelsList.length,
        ) ||
        enabledProviders.find((p) => p.activeSessions > 0 && p.modelsList.length) ||
        enabledProviders.find((p) => p.activeSessions > 0) ||
        enabledProviders[0]
      setModelKey(preferred.modelsList[0]?.modelKey || '')
      return preferred.key
    })
    // providerSig captures list identity without unstable array deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerSig])

  const selectedProvider =
    enabledProviders.find((p) => p.key === providerKey) || null
  // Cap dropdown size — huge HF catalogs freeze the browser.
  const models = (selectedProvider?.modelsList ?? []).slice(0, 80)
  const modelKeysSig = models.map((m) => m.modelKey).join('|')

  useEffect(() => {
    if (!modelKeysSig) {
      setModelKey('')
      return
    }
    const keys = modelKeysSig.split('|')
    setModelKey((prev) => (keys.includes(prev) ? prev : keys[0]))
  }, [providerKey, modelKeysSig])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  const modelId =
    providerKey && modelKey ? `${providerKey}/${modelKey}` : ''

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
  }

  const clearChat = async () => {
    if (streaming) stop()
    setMessages([])
    setError(null)
    toast.message('Cleared playground UI (provider site chats are under Manage → Clear site chats)')
  }

  const send = async () => {
    const text = input.trim()
    if (!text || streaming) return
    if (!modelId) {
      toast.error('Select a provider and model')
      return
    }

    const userMsg: ChatMessage = { id: newId(), role: 'user', content: text }
    const assistantId = newId()
    const nextMessages = [...messages, userMsg]
    setMessages([...nextMessages, { id: assistantId, role: 'assistant', content: '' }])
    setInput('')
    setError(null)
    setStreaming(true)

    const payloadMessages: { role: ChatRole; content: string }[] = []
    if (systemPrompt.trim()) {
      payloadMessages.push({ role: 'system', content: systemPrompt.trim() })
    }
    for (const m of nextMessages) {
      if (m.role === 'user' || m.role === 'assistant') {
        payloadMessages.push({ role: m.role, content: m.content })
      }
    }

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const resp = await fetch('/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          messages: payloadMessages,
          stream: true,
        }),
      })

      if (!resp.ok) {
        const raw = await resp.text().catch(() => '')
        let message = raw || `HTTP ${resp.status}`
        try {
          const j = JSON.parse(raw) as { error?: { message?: string } }
          if (j.error?.message) message = j.error.message
        } catch {
          // keep text
        }
        throw new Error(message)
      }

      if (!resp.body) throw new Error('No response body')

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let assistantText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n')
        buf = parts.pop() ?? ''

        for (const line of parts) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            const chunk = JSON.parse(data) as {
              error?: { message?: string }
              choices?: {
                delta?: { content?: string; reasoning_content?: string }
              }[]
            }
            if (chunk.error?.message) {
              throw new Error(chunk.error.message)
            }
            const d = chunk.choices?.[0]?.delta
            const piece =
              (typeof d?.content === 'string' && d.content) ||
              (typeof d?.reasoning_content === 'string' && d.reasoning_content) ||
              ''
            if (piece) {
              assistantText += piece
              const snapshot = assistantText
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: snapshot } : m,
                ),
              )
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue
            throw e
          }
        }
      }

      if (!assistantText.trim()) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: m.content || '(empty response)' }
              : m,
          ),
        )
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        // stopped by user
      } else {
        const msg = (e as Error).message || 'Chat failed'
        setError(msg)
        toast.error(msg)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: m.content || `Error: ${msg}` }
              : m,
          ),
        )
      }
    } finally {
      abortRef.current = null
      setStreaming(false)
    }
  }

  return (
    <Card className="border-0 bg-surface shadow-neo">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="w-5 h-5" style={{ color: '#1902c5' }} />
          Playground
        </CardTitle>
        <CardDescription>
          Uses your dashboard login. Models come from each provider&apos;s live
          API after Connect.
          {enabledProviders.length > 0
            ? ` ${enabledProviders.length} chat-ready provider(s).`
            : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Provider</Label>
            <select
              className="w-full h-9 px-2 text-sm rounded-md border border-border bg-background"
              value={providerKey}
              onChange={(e) => {
                const key = e.target.value
                setProviderKey(key)
                const p = enabledProviders.find((x) => x.key === key)
                setModelKey(p?.modelsList[0]?.modelKey || '')
                // Do not auto-import here — Import button only (avoids UI freeze).
              }}
              disabled={streaming}
            >
              {enabledProviders.length === 0 && (
                <option value="">No chat-capable providers</option>
              )}
              {enabledProviders.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.displayName}
                  {p.activeSessions > 0
                    ? ` · ${p.activeSessions} active · ${p.modelsList.length} models`
                    : ' · no session'}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs">Model (from live API)</Label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                disabled={importing || !providerKey}
                onClick={() => void refreshModelsFromApi(providerKey)}
              >
                <RefreshCw
                  className={`w-3 h-3 mr-1 ${importing ? 'animate-spin' : ''}`}
                />
                Import
              </Button>
            </div>
            <select
              className="w-full h-9 px-2 text-sm rounded-md border border-border bg-background font-mono"
              value={modelKey}
              onChange={(e) => setModelKey(e.target.value)}
              disabled={streaming || !models.length}
            >
              {models.length === 0 && (
                <option value="">
                  {selectedProvider?.activeSessions
                    ? 'No models from API yet — click Import'
                    : 'Capture a session first'}
                </option>
              )}
              {models.map((m) => (
                <option key={m.modelKey} value={m.modelKey}>
                  {m.displayName} ({m.modelKey})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {modelId && (
            <Badge variant="outline" className="font-mono text-[11px]">
              {modelId}
            </Badge>
          )}
          {selectedProvider && selectedProvider.activeSessions === 0 && (
            <Badge variant="secondary" className="text-[11px]">
              Capture a session first
            </Badge>
          )}
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">System prompt (optional)</Label>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="You are a helpful assistant…"
            className="min-h-[72px] text-sm resize-y"
            disabled={streaming}
          />
        </div>

        <div className="rounded-md border border-border/40 bg-background/50 min-h-[320px] max-h-[520px] overflow-y-auto p-3 space-y-3">
          {messages.length === 0 && (
            <div className="h-full min-h-[280px] flex items-center justify-center text-sm text-muted-foreground">
              Pick a model and send a message.
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                  m.role === 'user'
                    ? 'neo-inset'
                    : 'bg-muted/40 border border-border/40'
                }`}
              >
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  {m.role}
                </div>
                {m.content || (streaming ? '…' : '')}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {error && (
          <p className="text-xs text-rose-400 break-words">{error}</p>
        )}

        <div className="flex gap-2 items-end">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message…"
            className="min-h-[64px] text-sm resize-none flex-1"
            disabled={streaming}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="flex flex-col gap-2">
            {streaming ? (
              <Button size="sm" variant="secondary" onClick={stop}>
                <Square className="w-3.5 h-3.5 mr-1" />
                Stop
              </Button>
            ) : (
              <Button size="sm" onClick={() => void send()} disabled={!input.trim()}>
                Send
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void clearChat()}
              disabled={messages.length === 0 && !streaming}
              title="Clear playground messages only"
              className="shadow-neo border-0 bg-surface"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span className="ml-1 hidden sm:inline">Clear UI</span>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
