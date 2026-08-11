#!/usr/bin/env python3
"""
Build download bundles for OmniRoute.
Outputs:
  download/omniroute.zip               (full Next.js project)
  download/omniroute-extension.zip     (Chrome extension only)
"""
import os, zipfile, shutil

PROJECT = '/home/z/my-project'
DOWNLOAD = os.path.join(PROJECT, 'download')
TMP = os.path.join(DOWNLOAD, '_bundle_tmp')

# Clean
shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP, exist_ok=True)

SKIP_DIRS = {'node_modules', '.next', '.git', '__pycache__', '.zscripts',
             'db', '.turbo', 'out', 'build', '_bundle_tmp'}
SKIP_FILES = {'dev.log', 'bun.lock'}


def walk(src_root, dst_root, zip_writer):
    for root, dirs, files in os.walk(src_root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for f in sorted(files):
            if f in SKIP_FILES:
                continue
            if f.startswith('.env') and f != '.env.example':
                continue
            full = os.path.join(root, f)
            arc = os.path.relpath(full, src_root)
            arc = os.path.join(dst_root, arc).replace(os.sep, '/')
            zip_writer.write(full, arc)


# ─── 1. omniroute-extension.zip ────────────────────────────────────────
ext_src = os.path.join(PROJECT, 'public', 'extension')
ext_zip = os.path.join(DOWNLOAD, 'omniroute-extension.zip')
with zipfile.ZipFile(ext_zip, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(ext_src):
        dirs.sort()
        for f in sorted(files):
            full = os.path.join(root, f)
            arc = os.path.relpath(full, ext_src).replace(os.sep, '/')
            z.write(full, arc)
print(f'OK {ext_zip} ({os.path.getsize(ext_zip)} bytes)')


# ─── 2. README.md ───────────────────────────────────────────────────────
readme_path = os.path.join(TMP, 'README.md')
with open(readme_path, 'w') as fp:
    fp.write("""# OmniRoute - Multi-Provider AI Gateway

Capture and refresh AI web sessions, expose them via an OpenAI-compatible API.
No provider lock-in - add new providers by writing a single adapter file.

## Quick Start

```bash
bun install
bun run db:push
bun run dev
```

Open <http://localhost:3000>.

## Chrome Extension

1. Download the .zip via the dashboard (Extension tab).
2. Unzip into a folder.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked** -> select the folder.
6. Open the extension popup, set Backend URL to your OmniRoute server.
7. Log into AI sites - sessions are captured automatically.

## OpenAI-Compatible Usage

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="sk-or-...",
)
resp = client.chat.completions.create(
    model="kimi/kimi-k2",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)
```

## Adding a New Provider

1. Copy `src/lib/providers/kimi.ts` to `src/lib/providers/<newprovider>.ts`.
2. Implement `buildUpstreamRequest`, `parseUpstreamResponse`, `transformStream`,
   `refresh`, `ping`, `validate`.
3. Import it from `src/lib/providers/index.ts`.
4. The seed script will auto-register it + its model catalog.

## Verified Working

- /v1/models returns provider-prefixed model list
- /v1/chat/completions forwards to upstream with browser-like headers
- /api/test/zai confirms real GLM model on z.ai responds (not a stub)
- Auto-capture via chrome.cookies.onChanged + content script + tab load
- Token refresh scheduler keeps sessions alive
""")

# ─── 3. .env.example ───────────────────────────────────────────────────
env_path = os.path.join(TMP, '.env.example')
with open(env_path, 'w') as fp:
    fp.write('DATABASE_URL="file:/home/z/my-project/db/custom.db"\n')

# ─── 4. omniroute.zip (full project) ────────────────────────────────────
proj_zip = os.path.join(DOWNLOAD, 'omniroute.zip')
with zipfile.ZipFile(proj_zip, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    # Top-level config files
    for f in ['package.json', 'tsconfig.json', 'next.config.ts',
              'tailwind.config.ts', 'postcss.config.mjs', 'eslint.config.mjs',
              'components.json', 'Caddyfile']:
        full = os.path.join(PROJECT, f)
        if os.path.exists(full):
            z.write(full, f)

    z.write(env_path, '.env.example')
    z.write(readme_path, 'README.md')

    # Source dirs
    for sub in ['src', 'prisma', 'public', 'scripts', 'examples']:
        full = os.path.join(PROJECT, sub)
        if os.path.exists(full):
            walk(full, sub, z)

print(f'OK {proj_zip} ({os.path.getsize(proj_zip)} bytes)')

# Cleanup
shutil.rmtree(TMP, ignore_errors=True)
print('Done.')
