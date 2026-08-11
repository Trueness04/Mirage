import { NextResponse } from 'next/server'
import { ensureSeeded } from '@/lib/providers/seed'
import { syncRuntimeAdaptersFromDb } from '@/lib/providers/runtime'
import {
  isDeviceAuthOk,
  requireExtensionDevice,
} from '@/lib/auth/extension'
import {
  extensionFallbackHint,
  listExtensionProviders,
} from '@/lib/extension/providers'

/**
 * GET /api/extension/providers
 * Auth via X-Mirage-Device-Id + X-Mirage-Device-Secret headers.
 */
export async function GET(req: Request) {
  await ensureSeeded()
  await syncRuntimeAdaptersFromDb()

  const auth = await requireExtensionDevice(req, {})
  if (!isDeviceAuthOk(auth)) return auth

  const providers = await listExtensionProviders()
  const fallbackHint = await extensionFallbackHint()
  return NextResponse.json({
    ok: true,
    providers,
    fallbackHint,
  })
}
