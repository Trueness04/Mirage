import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { generateApiKey } from '@/lib/openai/api-key'
import { requireAdmin } from '@/lib/auth/admin'

export async function GET(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const keys = await db.apiKey.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      keyPrefix: true,
      label: true,
      sessionIds: true,
      rateLimitRpm: true,
      enabled: true,
      createdAt: true,
    },
  })
  return NextResponse.json({ keys })
}

/** POST: create new API key. Body: { label?, sessionIds?: string[] } */
export async function POST(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const { fullKey, keyPrefix, keyHash } = generateApiKey()

  const created = await db.apiKey.create({
    data: {
      keyPrefix,
      keyHash,
      label: typeof body.label === 'string' ? body.label : null,
      sessionIds: JSON.stringify(
        Array.isArray(body.sessionIds) ? body.sessionIds : [],
      ),
      rateLimitRpm: typeof body.rateLimitRpm === 'number' ? body.rateLimitRpm : 0,
    },
  })

  return NextResponse.json({ key: fullKey, record: created })
}

/** PATCH: enable/disable. Body: { id, enabled?, label?, sessionIds?, rateLimitRpm? } */
export async function PATCH(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const id = String(body.id || '')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const update: Record<string, unknown> = {}
  if (typeof body.enabled === 'boolean') update.enabled = body.enabled
  if (typeof body.label === 'string') update.label = body.label
  if (typeof body.rateLimitRpm === 'number') update.rateLimitRpm = body.rateLimitRpm
  if (Array.isArray(body.sessionIds)) update.sessionIds = JSON.stringify(body.sessionIds)

  const updated = await db.apiKey.update({ where: { id }, data: update })
  return NextResponse.json({ key: updated })
}

export async function DELETE(req: Request) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  await db.apiKey.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
