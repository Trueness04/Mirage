import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  isDeviceAuthOk,
  requireExtensionDevice,
} from '@/lib/auth/extension'
import { clearCaptureRequest } from '@/lib/extension/providers'

/**
 * POST /api/extension/capture-result
 * Extension reports a capture attempt outcome (e.g. no_cookies).
 * Body: { deviceId, deviceSecret, providerKey, status, detail? }
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const auth = await requireExtensionDevice(req, body)
  if (!isDeviceAuthOk(auth)) return auth

  const providerKey = String(body.providerKey || '').trim()
  if (!providerKey) {
    return NextResponse.json({ error: 'providerKey is required' }, { status: 400 })
  }

  const status = String(body.status || '').trim()
  // Keep waiting when the user still needs to log in; clear on hard failures.
  if (status === 'captured' || status === 'validated') {
    await clearCaptureRequest(providerKey)
  }

  await db.extensionDevice.updateMany({
    where: { deviceId: auth.device.deviceId },
    data: { lastSeenAt: new Date() },
  })

  return NextResponse.json({ ok: true, providerKey, status })
}
