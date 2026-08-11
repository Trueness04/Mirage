/**
 * GET /api/extension/download
 * Serves the prebuilt public/mirage-extension.zip (built by scripts/build-extension-zip.mjs).
 * Falls back to a small live zip of public/extension if the static file is missing.
 */

import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { zipSync } from 'fflate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROOT = process.cwd()
const STATIC_ZIP = path.join(ROOT, 'public', 'mirage-extension.zip')
const EXTENSION_DIR = path.join(ROOT, 'public', 'extension')

function collectFiles(dir: string, base = dir): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {}
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      Object.assign(out, collectFiles(full, base))
      continue
    }
    if (entry.name === 'icon-source.png') continue
    const arc = path.relative(base, full).split(path.sep).join('/')
    out[arc] = new Uint8Array(fs.readFileSync(full))
  }
  return out
}

function zipResponse(data: Uint8Array) {
  const body = Buffer.from(data)
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="mirage-extension.zip"',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export async function GET() {
  try {
    if (fs.existsSync(STATIC_ZIP)) {
      return zipResponse(new Uint8Array(fs.readFileSync(STATIC_ZIP)))
    }

    const files = collectFiles(EXTENSION_DIR)
    if (Object.keys(files).length === 0) {
      return NextResponse.json(
        { error: 'Extension source not found. Run: bun run extension:zip' },
        { status: 404 },
      )
    }
    return zipResponse(zipSync(files, { level: 6 }))
  } catch (e) {
    console.error('[extension/download]', e)
    return NextResponse.json(
      { error: 'Failed to serve extension zip: ' + (e as Error).message },
      { status: 500 },
    )
  }
}
