/**
 * Builds public/mirage-extension.zip from public/extension/.
 * Run on postinstall / before dev so download never depends on a live ZIP API.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { zipSync } from 'fflate'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const srcDir = path.join(root, 'public', 'extension')
const outFile = path.join(root, 'public', 'mirage-extension.zip')

function collect(dir, base = dir, out = {}) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collect(full, base, out)
      continue
    }
    // Skip oversized source assets not needed to load the extension
    if (entry.name === 'icon-source.png') continue
    const arc = path.relative(base, full).split(path.sep).join('/')
    out[arc] = new Uint8Array(fs.readFileSync(full))
  }
  return out
}

const files = collect(srcDir)
if (Object.keys(files).length === 0) {
  console.error('[build-extension-zip] no files in public/extension')
  process.exit(1)
}

const zipped = zipSync(files, { level: 6 })
fs.writeFileSync(outFile, Buffer.from(zipped))
console.log(
  `[build-extension-zip] wrote ${outFile} (${zipped.byteLength} bytes, ${Object.keys(files).length} files)`,
)
