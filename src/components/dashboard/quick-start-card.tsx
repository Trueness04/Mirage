'use client'

import { useQuery } from '@tanstack/react-query'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, type DashboardData } from '@/lib/dashboard/types'
import { Copy, Link2, KeyRound, Cpu } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

// Hook that returns true only after the component has mounted on the client.
// Used to gate rendering of browser-only values (window.location, Date.now, etc.)
// so SSR HTML matches the first client render and hydration doesn't break.
function useMounted() {
  const [mounted, setMounted] = useState(false)
  // setState inside an effect is the standard pattern for "did we mount yet";
  // eslint's set-state-in-effect rule is intentionally silenced here.
  useEffect(() => {
    setMounted(true)
  }, [])
  return mounted
}

export function QuickStartCard() {
  const { data } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => api('/api/dashboard'),
    refetchInterval: 8000,
  })

  const mounted = useMounted()
  // Use a stable placeholder during SSR & first client render,
  // then swap to the real origin once mounted.
  const baseUrl = mounted
    ? window.location.origin
    : 'http://localhost:3000'
  const [selectedKey, setSelectedKey] = useState<string>('')
  const [selectedModel, setSelectedModel] = useState<string>('')

  // Live imported models only — never a hardcoded catalog in the UI.
  const liveModels = useMemo(() => {
    if (!data?.providers) return [] as string[]
    const out: string[] = []
    for (const p of data.providers) {
      if (!p.enabled) continue
      for (const m of p.modelsList || []) {
        out.push(`${p.key}/${m.modelKey}`)
      }
    }
    return out
  }, [data?.providers])

  useEffect(() => {
    if (!liveModels.length) return
    setSelectedModel((prev) =>
      prev && liveModels.includes(prev) ? prev : liveModels[0],
    )
  }, [liveModels])

  if (!data) return null

  const modelForExample = selectedModel || '<provider/modelKey from /v1/models>'

  const exampleCurl = `curl ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer ${selectedKey || '<YOUR_API_KEY>'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelForExample}",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": true
  }'`

  const examplePython = `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}/v1",
    api_key="${selectedKey || '<YOUR_API_KEY>'}",
)

resp = client.chat.completions.create(
    model="${modelForExample}",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)`

  const copy = (text: string) => {
    navigator.clipboard.writeText(text)
    toast.success('Copied to clipboard')
  }

  return (
    <Card className="border-0 bg-surface shadow-neo">
      <CardHeader>
        <CardTitle>OpenAI-Compatible Endpoint</CardTitle>
        <CardDescription>
          Use Mirage as a drop-in replacement for the OpenAI API. The three values
          below are everything a client needs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Base URL */}
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1.5">
            <Link2 className="w-3 h-3" /> Base URL
          </Label>
          <div className="flex gap-2">
            <Input
              value={baseUrl + '/v1'}
              readOnly
              className="font-mono text-xs"
            />
            <Button size="sm" variant="secondary" onClick={() => copy(baseUrl + '/v1')}>
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* API key */}
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1.5">
            <KeyRound className="w-3 h-3" /> API Key
          </Label>
          <div className="flex gap-2">
            <Input
              value={selectedKey}
              onChange={(e) => setSelectedKey(e.target.value)}
              placeholder="sk-mg-..."
              className="font-mono text-xs"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Paste the <span className="text-foreground">full</span> key from API Keys → New Key
            (shown once). The short prefix like <code>sk-mg-5707bd</code> will always return
            Invalid API key.
          </p>
          {data.apiKeys.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              Saved prefixes:{' '}
              {data.apiKeys.map((k) => k.keyPrefix).join(', ')}… — regenerate if you lost the rest.
            </p>
          )}
        </div>

        {/* Model ID — from live import only */}
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1.5">
            <Cpu className="w-3 h-3" /> Model ID (from live import)
          </Label>
          <Input
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            placeholder="Connect a provider → models appear here"
            className="font-mono text-xs"
          />
          <div className="flex flex-wrap gap-1 mt-1">
            {liveModels.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No imported models yet. Capture a login, then models load from that site&apos;s API.
              </p>
            ) : (
              liveModels.slice(0, 24).map((m) => (
                <Badge
                  key={m}
                  variant="outline"
                  className="cursor-pointer hover:bg-accent/20"
                  onClick={() => setSelectedModel(m)}
                >
                  {m}
                </Badge>
              ))
            )}
          </div>
        </div>

        {/* cURL */}
        <div className="space-y-1.5">
          <Label className="text-xs">cURL</Label>
          <pre className="text-[11px] font-mono p-3 rounded-md bg-background/70 border border-border/40 overflow-x-auto whitespace-pre-wrap break-all">
            {exampleCurl}
          </pre>
          <Button size="sm" variant="secondary" onClick={() => copy(exampleCurl)}>
            <Copy className="w-3.5 h-3.5 mr-1" /> Copy
          </Button>
        </div>

        {/* Python */}
        <div className="space-y-1.5">
          <Label className="text-xs">Python (openai SDK)</Label>
          <pre className="text-[11px] font-mono p-3 rounded-md bg-background/70 border border-border/40 overflow-x-auto whitespace-pre-wrap break-all">
            {examplePython}
          </pre>
          <Button size="sm" variant="secondary" onClick={() => copy(examplePython)}>
            <Copy className="w-3.5 h-3.5 mr-1" /> Copy
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
