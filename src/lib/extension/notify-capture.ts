import { db } from '@/lib/db'
import { enqueueToolJob } from '@/lib/tools/local'
import { listExtensionProviders } from '@/lib/extension/providers'

const ONLINE_MS = 90_000

async function listTargetDevices(): Promise<{
  devices: { deviceId: string }[]
  online: number
}> {
  const since = new Date(Date.now() - ONLINE_MS)
  let devices = await db.extensionDevice.findMany({
    where: { enabled: true, lastSeenAt: { gte: since } },
    select: { deviceId: true },
  })
  const online = devices.length
  if (devices.length === 0) {
    devices = await db.extensionDevice.findMany({
      where: { enabled: true },
      select: { deviceId: true },
    })
  }
  return { devices, online }
}

/**
 * Push latest provider list to extensions so new platforms refresh immediately
 * (domain map, content scripts, refresh window) without waiting for the next
 * opportunistic heartbeat.
 */
export async function notifyDevicesToSyncProviders(opts?: {
  reason?: string
  providerKey?: string
  websiteUrl?: string
}): Promise<{ notified: number; online: number; deviceIds: string[] }> {
  const { devices, online } = await listTargetDevices()
  const providers = await listExtensionProviders()
  const websiteUrl = opts?.websiteUrl
    ? normalizeWebsiteUrl(opts.websiteUrl)
    : undefined

  const deviceIds: string[] = []
  for (const d of devices) {
    await enqueueToolJob({
      deviceId: d.deviceId,
      toolName: 'mirage_sync_providers',
      arguments: {
        reason: opts?.reason || 'providers_changed',
        providerKey: opts?.providerKey || undefined,
        websiteUrl: websiteUrl || undefined,
        providers,
      },
    })
    deviceIds.push(d.deviceId)
  }

  return { notified: deviceIds.length, online, deviceIds }
}

/**
 * Ask extension devices to capture a provider.
 * Prefers recently-seen devices; if none, fans out to every enabled device
 * so the next heartbeat/register picks the job up.
 */
export async function notifyDevicesToCapture(opts: {
  providerKey: string
  websiteUrl: string
}): Promise<{ notified: number; online: number; deviceIds: string[] }> {
  const websiteUrl = normalizeWebsiteUrl(opts.websiteUrl)
  if (!websiteUrl || !opts.providerKey) {
    return { notified: 0, online: 0, deviceIds: [] }
  }

  // Always refresh catalog first so the new origin is in PROVIDER_DOMAINS.
  await notifyDevicesToSyncProviders({
    reason: 'before_capture',
    providerKey: opts.providerKey,
    websiteUrl,
  })

  const { devices, online } = await listTargetDevices()

  // Drop stale capture jobs for this provider so offline ghosts don't block UX
  const stale = await db.extensionToolJob.findMany({
    where: {
      toolName: 'mirage_capture_provider',
      status: { in: ['pending', 'running'] },
    },
    select: { id: true, arguments: true },
  })
  for (const job of stale) {
    try {
      const args = JSON.parse(job.arguments || '{}') as { providerKey?: string }
      if (args.providerKey === opts.providerKey) {
        await db.extensionToolJob.update({
          where: { id: job.id },
          data: {
            status: 'error',
            error: 'superseded',
            completedAt: new Date(),
          },
        })
      }
    } catch {
      // ignore
    }
  }

  const deviceIds: string[] = []
  for (const d of devices) {
    await enqueueToolJob({
      deviceId: d.deviceId,
      toolName: 'mirage_capture_provider',
      arguments: {
        providerKey: opts.providerKey,
        websiteUrl,
        waitForLogin: true,
        mode: 'oauth_connect',
      },
    })
    deviceIds.push(d.deviceId)
  }

  return { notified: deviceIds.length, online, deviceIds }
}

export function normalizeWebsiteUrl(raw: string): string {
  const t = String(raw || '').trim()
  if (!t) return ''
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`
  try {
    const u = new URL(withScheme)
    if (!u.hostname) return ''
    // Reject scheme-only / invalid hosts
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return ''
    return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''))
  } catch {
    return ''
  }
}

/** Best-effort repair: hooshemasnoei-com → https://hooshemasnoei.com */
export function websiteUrlFromProviderKey(key: string): string {
  const host = String(key || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  if (!host || !host.includes('-')) return ''
  // Only treat as domain-like if it looks like name-tld
  const parts = host.split('-')
  if (parts.length < 2) return ''
  const tld = parts[parts.length - 1]
  if (!/^[a-z]{2,24}$/.test(tld)) return ''
  const name = parts.slice(0, -1).join('-')
  if (!name) return ''
  return normalizeWebsiteUrl(`${name}.${tld}`)
}
