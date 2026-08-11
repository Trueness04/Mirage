import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth/admin'

/** DELETE /api/devices?id=<cuid> — unregister an extension device from the dashboard. */
export async function DELETE(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const device = await db.extensionDevice.findUnique({ where: { id } })
  if (!device) {
    return NextResponse.json({ error: 'Device not found' }, { status: 404 })
  }

  // Drop pending/running jobs for this device so they don't linger.
  await db.extensionToolJob.deleteMany({
    where: {
      deviceId: device.deviceId,
      status: { in: ['pending', 'running'] },
    },
  })
  await db.extensionDevice.delete({ where: { id } })

  return NextResponse.json({ ok: true, deviceId: device.deviceId })
}
