import { NextResponse } from 'next/server'
import {
  isDeviceAuthOk,
  requireExtensionDevice,
} from '@/lib/auth/extension'
import { completeToolJob } from '@/lib/tools/local'
import { db } from '@/lib/db'

/**
 * POST /api/extension/tools/result
 * Body: { deviceId, deviceSecret, jobId, ok, result?, error? }
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const auth = await requireExtensionDevice(req, body)
  if (!isDeviceAuthOk(auth)) return auth

  const jobId = String(body.jobId || '').trim()
  if (!jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 })
  }

  const job = await db.extensionToolJob.findUnique({ where: { id: jobId } })
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }
  if (job.deviceId !== auth.device.deviceId) {
    return NextResponse.json({ error: 'Job belongs to another device' }, { status: 403 })
  }

  const ok = body.ok !== false && !body.error
  await completeToolJob(jobId, {
    ok,
    result: body.result,
    error: typeof body.error === 'string' ? body.error : undefined,
  })

  return NextResponse.json({ ok: true })
}
