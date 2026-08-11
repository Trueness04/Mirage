/**
 * Build Mirage brand / favicon / extension icons from stacked-layers master PNG.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = path.join(root, 'public')
const extIcons = path.join(publicDir, 'extension', 'icons')
const master = path.join(publicDir, 'abstract-stacked-layers-512x512.png')

async function loadSharp() {
  try {
    return (await import('sharp')).default
  } catch {
    return null
  }
}

async function main() {
  const sharp = await loadSharp()
  if (!sharp) {
    console.error('[icons] sharp is required: bun add -d sharp')
    process.exit(1)
  }
  if (!fs.existsSync(master)) {
    console.error('[icons] missing', master)
    process.exit(1)
  }

  fs.mkdirSync(extIcons, { recursive: true })
  const src = fs.readFileSync(master)

  const jobs = [
    { out: path.join(publicDir, 'logo.png'), size: 128 },
    { out: path.join(publicDir, 'favicon-32.png'), size: 32 },
    { out: path.join(publicDir, 'apple-touch-icon.png'), size: 180 },
    { out: path.join(publicDir, 'apple-icon.png'), size: 180 },
    { out: path.join(publicDir, 'icon.png'), size: 512 },
    { out: path.join(publicDir, 'icon-192.png'), size: 192 },
    { out: path.join(publicDir, 'icon-512.png'), size: 512 },
    { out: path.join(extIcons, 'icon-16.png'), size: 16 },
    { out: path.join(extIcons, 'icon-48.png'), size: 48 },
    { out: path.join(extIcons, 'icon-128.png'), size: 128 },
  ]

  for (const j of jobs) {
    await sharp(src)
      .resize(j.size, j.size, { fit: 'contain', background: '#000000' })
      .png()
      .toFile(j.out)
    console.log('[icons]', path.relative(root, j.out))
  }

  await sharp(src)
    .resize(32, 32, { fit: 'contain', background: '#000000' })
    .png()
    .toFile(path.join(publicDir, 'favicon.ico'))
  console.log('[icons] public/favicon.ico')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
