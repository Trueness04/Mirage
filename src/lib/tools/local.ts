/**
 * Mirage local tools executed by the browser extension.
 */

import { db } from '@/lib/db'
import type { ChatMessage, OpenAIChatRequest } from '@/lib/providers/base'

export const MIRAGE_LOCAL_TOOLS = [
  'mirage_browser_fetch',
  'mirage_read_tab',
  'mirage_list_tabs',
  'mirage_test_provider',
  'mirage_zai_captcha',
  'mirage_qwen_warmup',
] as const

export type MirageLocalToolName = (typeof MIRAGE_LOCAL_TOOLS)[number]

export function isMirageLocalTool(name: string): boolean {
  return name.startsWith('mirage_')
}

export interface OpenAIToolDef {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export function splitTools(tools: unknown): {
  local: OpenAIToolDef[]
  upstream: OpenAIToolDef[]
} {
  const list = Array.isArray(tools) ? (tools as OpenAIToolDef[]) : []
  const local: OpenAIToolDef[] = []
  const upstream: OpenAIToolDef[] = []
  for (const t of list) {
    const name = t?.function?.name || ''
    if (isMirageLocalTool(name)) local.push(t)
    else upstream.push(t)
  }
  return { local, upstream }
}

export function requestHasMirageTools(req: OpenAIChatRequest): boolean {
  return splitTools(req.tools).local.length > 0
}

export interface ToolCall {
  id: string
  type?: string
  function: { name: string; arguments: string }
}

export function extractToolCalls(message: ChatMessage | undefined): ToolCall[] {
  const raw = message?.tool_calls
  if (!Array.isArray(raw)) return []
  const out: ToolCall[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const fn = o.function as Record<string, unknown> | undefined
    const name = String(fn?.name || '')
    if (!name) continue
    out.push({
      id: String(o.id || `call_${name}_${out.length}`),
      type: typeof o.type === 'string' ? o.type : 'function',
      function: {
        name,
        arguments:
          typeof fn?.arguments === 'string'
            ? fn.arguments
            : JSON.stringify(fn?.arguments ?? {}),
      },
    })
  }
  return out
}

const ONLINE_MS = 90_000

export async function pickOnlineDeviceId(
  preferredDeviceId?: string | null,
): Promise<string | null> {
  const since = new Date(Date.now() - ONLINE_MS)
  if (preferredDeviceId) {
    const preferred = await db.extensionDevice.findFirst({
      where: {
        deviceId: preferredDeviceId,
        enabled: true,
        lastSeenAt: { gte: since },
      },
    })
    if (preferred) return preferred.deviceId
  }
  const any = await db.extensionDevice.findFirst({
    where: { enabled: true, lastSeenAt: { gte: since } },
    orderBy: { lastSeenAt: 'desc' },
  })
  return any?.deviceId ?? null
}

export async function enqueueToolJob(opts: {
  deviceId: string
  toolName: string
  arguments: Record<string, unknown>
}): Promise<string> {
  const job = await db.extensionToolJob.create({
    data: {
      deviceId: opts.deviceId,
      toolName: opts.toolName,
      arguments: JSON.stringify(opts.arguments || {}),
      status: 'pending',
    },
  })
  return job.id
}

export async function waitForToolJob(
  jobId: string,
  timeoutMs = 45_000,
  pollMs = 400,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await db.extensionToolJob.findUnique({ where: { id: jobId } })
    if (!job) return { ok: false, error: 'job not found' }
    if (job.status === 'done') {
      try {
        return { ok: true, result: job.result ? JSON.parse(job.result) : null }
      } catch {
        return { ok: true, result: job.result }
      }
    }
    if (job.status === 'error') {
      return { ok: false, error: job.error || 'tool failed' }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  await db.extensionToolJob.updateMany({
    where: { id: jobId, status: { in: ['pending', 'running'] } },
    data: {
      status: 'error',
      error: 'timeout waiting for extension',
      completedAt: new Date(),
    },
  })
  return { ok: false, error: 'timeout waiting for extension' }
}

export async function listPendingToolJobs(deviceId: string, limit = 10) {
  return db.extensionToolJob.findMany({
    where: { deviceId, status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
}

export async function markToolJobRunning(id: string) {
  await db.extensionToolJob.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'running' },
  })
}

export async function completeToolJob(
  id: string,
  opts: { ok: boolean; result?: unknown; error?: string },
) {
  await db.extensionToolJob.update({
    where: { id },
    data: {
      status: opts.ok ? 'done' : 'error',
      result:
        opts.result !== undefined ? JSON.stringify(opts.result) : undefined,
      error: opts.ok ? null : opts.error || 'failed',
      completedAt: new Date(),
    },
  })
}

/** OpenAI-style tool definitions advertised to clients / models. */
export const MIRAGE_TOOL_DEFINITIONS: OpenAIToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'mirage_browser_fetch',
      description:
        'Fetch a URL from the user browser context (cookies/session of open tabs).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
          headers: { type: 'object' },
          body: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mirage_read_tab',
      description: 'Read text content from a browser tab matching url or the active tab.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Optional URL prefix/host to match' },
          maxChars: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mirage_list_tabs',
      description: 'List open tabs for Mirage-monitored provider domains.',
      parameters: {
        type: 'object',
        properties: {
          providerKey: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mirage_zai_captcha',
      description:
        'Solve Aliyun traceless captcha on chat.z.ai and return captcha_verify_param.',
      parameters: {
        type: 'object',
        properties: {
          providerKey: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mirage_qwen_warmup',
      description:
        'Warm chat.qwen.ai in the browser so Alibaba WAF ssxmod_* cookies are set, then return the cookie jar.',
      parameters: {
        type: 'object',
        properties: {
          providerKey: { type: 'string' },
        },
      },
    },
  },
]
