import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeeded } from '@/lib/providers/seed'
import { ensureSchedulerStarted } from '@/lib/scheduler/token-refresh'
import { syncRuntimeAdaptersFromDb } from '@/lib/providers/runtime'
import {
  generateDeviceSecret,
  hashDeviceSecret,
} from '@/lib/auth/extension'
import {
  extensionFallbackHint,
  listExtensionProviders,
} from '@/lib/extension/providers'

/**
 * Extension registers itself on install / startup.
 * Body: { deviceId, displayName?, version?, browser?, deviceSecret?, rotateSecret? }
 * Returns deviceSecret when newly issued or rotated (store in extension local storage).
 */
export async function POST(req: Request) {
  await ensureSeeded()
  await syncRuntimeAdaptersFromDb()
  ensureSchedulerStarted()

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const deviceId = String(body.deviceId || '').trim()
  if (!deviceId) {
    return NextResponse.json({ error: 'deviceId is required' }, { status: 400 })
  }

  const browser = normalizeBrowser(body.browser)
  const displayName =
    (body.displayName ? String(body.displayName) : undefined) ||
    `Mirage · ${browser}`

  const existing = await db.extensionDevice.findUnique({ where: { deviceId } })
  const providedSecret =
    typeof body.deviceSecret === 'string' ? body.deviceSecret.trim() : ''
  const providedOk =
    Boolean(providedSecret) &&
    Boolean(existing?.secretHash) &&
    hashDeviceSecret(providedSecret) === existing!.secretHash

  const shared = (process.env.MIRAGE_EXTENSION_SECRET || '').trim()
  const sharedOk =
    Boolean(shared) &&
    (req.headers.get('x-mirage-extension-secret')?.trim() === shared ||
      String(body.extensionSecret || '').trim() === shared)

  let deviceSecret: string | undefined
  let secretHash = existing?.secretHash ?? null

  if (!existing || !secretHash) {
    // First registration (or legacy device without a secret)
    deviceSecret = generateDeviceSecret()
    secretHash = hashDeviceSecret(deviceSecret)
  } else if (body.rotateSecret === true) {
    if (!providedOk && !sharedOk) {
      return NextResponse.json(
        {
          error:
            'rotateSecret requires the current deviceSecret (or MIRAGE_EXTENSION_SECRET)',
        },
        { status: 401 },
      )
    }
    deviceSecret = generateDeviceSecret()
    secretHash = hashDeviceSecret(deviceSecret)
  } else if (providedSecret && !providedOk && !sharedOk) {
    return NextResponse.json({ error: 'Invalid deviceSecret' }, { status: 401 })
  }

  const device = await db.extensionDevice.upsert({
    where: { deviceId },
    update: {
      displayName,
      browser,
      version: body.version ? String(body.version) : undefined,
      lastSeenAt: new Date(),
      enabled: true,
      ...(deviceSecret ? { secretHash } : {}),
    },
    create: {
      deviceId,
      displayName,
      browser,
      version: body.version ? String(body.version) : undefined,
      secretHash: secretHash!,
      lastSeenAt: new Date(),
    },
  })

  const providers = await listExtensionProviders()
  const fallbackHint = await extensionFallbackHint()

  return NextResponse.json({
    device: {
      id: device.id,
      deviceId: device.deviceId,
      displayName: device.displayName,
      browser: device.browser,
      enabled: device.enabled,
    },
    deviceSecret: deviceSecret || undefined,
    providers,
    fallbackHint,
    capabilities: ['tools', 'capture', 'test'],
    tip: 'Install Mirage on Chrome AND Edge, log into each AI site once per browser — primary + fallback sessions unlock automatic failover.',
  })
}

function normalizeBrowser(v: unknown): string {
  const s = String(v || '')
    .toLowerCase()
    .trim()
  if (s.includes('edg')) return 'edge'
  if (s.includes('firefox')) return 'firefox'
  if (s.includes('chrome') || s.includes('chromium')) return 'chrome'
  return s || 'chrome'
}
