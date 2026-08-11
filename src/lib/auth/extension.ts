/**
 * Extension device authentication.
 * On register the server issues a deviceSecret (shown once). Subsequent
 * extension calls must send deviceId + deviceSecret. Session mutations
 * are scoped to sessions owned by that deviceId.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function generateDeviceSecret(): string {
  return 'mds_' + randomBytes(24).toString('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ha = createHash('sha256').update(String(a).toLowerCase()).digest()
    const hb = createHash('sha256').update(String(b).toLowerCase()).digest()
    return timingSafeEqual(ha, hb)
  } catch {
    return false
  }
}

export function extractDeviceSecret(req: Request, body?: Record<string, unknown>): string | null {
  const header = req.headers.get('x-mirage-device-secret')?.trim()
  if (header) return header
  if (body && typeof body.deviceSecret === 'string') {
    const s = body.deviceSecret.trim()
    if (s) return s
  }
  // Optional shared fallback for all devices (ops / CI)
  const shared = (process.env.MIRAGE_EXTENSION_SECRET || '').trim()
  const providedShared =
    req.headers.get('x-mirage-extension-secret')?.trim() ||
    (typeof body?.extensionSecret === 'string' ? body.extensionSecret.trim() : '')
  if (shared && providedShared && providedShared === shared) {
    return '__shared__'
  }
  return null
}

export type DeviceAuthOk = {
  device: {
    id: string
    deviceId: string
    enabled: boolean
    secretHash: string | null
  }
  viaSharedSecret: boolean
}

/**
 * Verify deviceId + deviceSecret. Returns device row or an error response.
 */
export async function requireExtensionDevice(
  req: Request,
  body: Record<string, unknown>,
): Promise<DeviceAuthOk | NextResponse> {
  const deviceId = String(body.deviceId || req.headers.get('x-mirage-device-id') || '').trim()
  if (!deviceId) {
    return NextResponse.json({ error: 'deviceId is required' }, { status: 400 })
  }

  const secret = extractDeviceSecret(req, body)
  if (!secret) {
    return NextResponse.json(
      {
        error:
          'Missing deviceSecret. Re-register the extension (Save & Re-register) to receive a device secret.',
      },
      { status: 401 },
    )
  }

  const device = await db.extensionDevice.findUnique({ where: { deviceId } })
  if (!device) {
    return NextResponse.json(
      { error: 'Unknown device. Call /api/extension/register first.' },
      { status: 401 },
    )
  }
  if (!device.enabled) {
    return NextResponse.json({ error: 'Device disabled' }, { status: 403 })
  }

  if (secret === '__shared__') {
    return { device, viaSharedSecret: true }
  }

  if (!device.secretHash) {
    return NextResponse.json(
      {
        error:
          'Device has no secret yet. Call /api/extension/register again to rotate and receive one.',
      },
      { status: 401 },
    )
  }

  const incomingHash = hashDeviceSecret(secret)
  if (!safeEqualHex(incomingHash, device.secretHash)) {
    return NextResponse.json({ error: 'Invalid deviceSecret' }, { status: 401 })
  }

  return { device, viaSharedSecret: false }
}

export function isDeviceAuthOk(
  v: DeviceAuthOk | NextResponse,
): v is DeviceAuthOk {
  return !(v instanceof NextResponse) && 'device' in v
}
