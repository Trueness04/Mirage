/**
 * GET /api/download?file=<name>
 * --------------------------------------------------------------------
 * Serves files from /home/z/my-project/download/ to the user.
 *
 * This is the only way to download files in this sandboxed environment
 * — direct filesystem access is blocked, but the Next.js server can
 * read its own filesystem and stream the bytes back as an HTTP response.
 *
 * Allowed files (whitelist — prevents path traversal):
 *   - mirage.zip                 (full project bundle)
 *   - mirage-extension.zip       (Chrome extension only)
 *   - extension/manifest.json
 *   - extension/background.js
 *   - extension/popup.html
 *   - extension/popup.js
 *   - extension/content.js
 *   - extension/icons/icon-16.png
 *   - extension/icons/icon-48.png
 *   - extension/icons/icon-128.png
 *   - README.md
 */

import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const DOWNLOAD_DIR = path.join(process.cwd(), 'download')

const ALLOWLIST: Record<string, { path: string; mime: string }> = {
  'mirage.zip': { path: 'mirage.zip', mime: 'application/zip' },
  'mirage-extension.zip': {
    path: 'mirage-extension.zip',
    mime: 'application/zip',
  },
  // Back-compat aliases
  'omniroute.zip': { path: 'mirage.zip', mime: 'application/zip' },
  'omniroute-extension.zip': {
    path: 'mirage-extension.zip',
    mime: 'application/zip',
  },
  'manifest.json': {
    path: 'extension/manifest.json',
    mime: 'application/json',
  },
  'background.js': {
    path: 'extension/background.js',
    mime: 'text/javascript',
  },
  'popup.html': { path: 'extension/popup.html', mime: 'text/html' },
  'popup.js': { path: 'extension/popup.js', mime: 'text/javascript' },
  'content.js': { path: 'extension/content.js', mime: 'text/javascript' },
  'icon-16.png': {
    path: 'extension/icons/icon-16.png',
    mime: 'image/png',
  },
  'icon-48.png': {
    path: 'extension/icons/icon-48.png',
    mime: 'image/png',
  },
  'icon-128.png': {
    path: 'extension/icons/icon-128.png',
    mime: 'image/png',
  },
  'README.md': { path: 'README.md', mime: 'text/markdown' },
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const file = url.searchParams.get('file') || ''
  const entry = ALLOWLIST[file]
  if (!entry) {
    return NextResponse.json(
      {
        error: 'Unknown file. Allowed files: ' + Object.keys(ALLOWLIST).join(', '),
      },
      { status: 400 },
    )
  }

  const fullPath = path.join(DOWNLOAD_DIR, entry.path)
  if (!fs.existsSync(fullPath)) {
    return NextResponse.json(
      { error: `File not found on disk: ${entry.path}` },
      { status: 404 },
    )
  }

  const data = fs.readFileSync(fullPath)
  return new NextResponse(data, {
    headers: {
      'Content-Type': entry.mime,
      'Content-Length': String(data.length),
      'Content-Disposition': `attachment; filename="${file}"`,
      'Cache-Control': 'no-store',
    },
  })
}
