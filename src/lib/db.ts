import { PrismaClient, type Prisma } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function prismaLog(): Prisma.LogLevel[] {
  // Opt-in only — `query` floods the terminal on every dashboard poll / seed.
  const raw = (process.env.PRISMA_LOG || '').trim().toLowerCase()
  if (!raw || raw === '0' || raw === 'off' || raw === 'false') {
    return process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error']
  }
  const levels = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as Prisma.LogLevel[]
  return levels.length ? levels : ['error']
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: prismaLog(),
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
