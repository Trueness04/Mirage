const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()
async function main() {
  const logs = await db.requestLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { model: true, status: true, errorMessage: true, stream: true, durationMs: true, createdAt: true },
  })
  for (const l of logs) {
    console.log(`[${l.createdAt.toISOString()}] model=${l.model} status=${l.status} stream=${l.stream} dur=${l.durationMs}ms err=${(l.errorMessage || '').slice(0, 150)}`)
  }
  await db.$disconnect()
}
main()
