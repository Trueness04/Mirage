import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth/admin'

export async function GET(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const url = new URL(req.url)
  const limit = Math.min(200, Number(url.searchParams.get('limit') || 100))
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0))

  const logs = await db.requestLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
    include: { apiKey: { select: { keyPrefix: true, label: true } } },
  })
  const total = await db.requestLog.count()

  return NextResponse.json({ logs, total, limit, offset })
}

/** DELETE /api/logs?all=1 — clear RequestLog rows created via web app / API. */
export async function DELETE(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const url = new URL(req.url)
  if (url.searchParams.get('all') !== '1') {
    return NextResponse.json(
      { error: 'Pass all=1 to clear chat/request logs' },
      { status: 400 },
    )
  }
  const result = await db.requestLog.deleteMany({})
  return NextResponse.json({ ok: true, deleted: result.count })
}
