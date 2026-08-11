#!/bin/bash
# Bundle the OmniRoute project for download.
# Produces /home/z/my-project/download/omniroute.zip containing the
# full Next.js source + extension files + README.

set -e
PROJECT_DIR=/home/z/my-project
DOWNLOAD_DIR=$PROJECT_DIR/download
TMP_DIR=$DOWNLOAD_DIR/omniroute-bundle

# Clean & recreate
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

# ─── 1. Source code (excluding node_modules, .next, db) ────────────────
mkdir -p "$TMP_DIR/src"
cp -r "$PROJECT_DIR/src" "$TMP_DIR/"
cp -r "$PROJECT_DIR/prisma" "$TMP_DIR/"
cp -r "$PROJECT_DIR/public" "$TMP_DIR/"
cp -r "$PROJECT_DIR/scripts" "$TMP_DIR/"
cp -r "$PROJECT_DIR/examples" "$TMP_DIR/" 2>/dev/null || true

# Top-level config files
for f in package.json tsconfig.json next.config.ts \
         tailwind.config.ts postcss.config.mjs eslint.config.mjs \
         components.json Caddyfile .env.example; do
  [ -f "$PROJECT_DIR/$f" ] && cp "$PROJECT_DIR/$f" "$TMP_DIR/"
done

# ─── 2. Environment example ─────────────────────────────────────────────
cat > "$TMP_DIR/.env.example" << 'EOF'
DATABASE_URL="file:/home/z/my-project/db/custom.db"
# Optional: enable z.ai SDK fallback for the test endpoint
# ZAI_SDK_FALLBACK=true
EOF

# ─── 3. README with setup + usage instructions ────────────────────────
cat > "$TMP_DIR/README.md" << 'READMEEOF'
# OmniRoute — Multi-Provider AI Gateway

Capture and refresh AI web sessions, expose them via an OpenAI-compatible API.
No provider lock-in — add new providers by writing a single adapter file.

## Quick Start

```bash
bun install
bun run db:push
bun run dev
```

Open <http://localhost:3000>.

## Architecture

```
src/
├── app/
│   ├── page.tsx                  Dashboard UI (7 tabs)
│   ├── api/
│   │   ├── v1/                   OpenAI-compatible API
│   │   │   ├── chat/completions  POST - chat completion (stream + non-stream)
│   │   │   └── models            GET  - list available models
│   │   ├── extension/            Chrome extension endpoints
│   │   │   ├── register          device registration
│   │   │   ├── sessions          cookie/token capture
│   │   │   ├── heartbeat         keep-alive ping
│   │   │   └── download          .zip of the extension
│   │   ├── providers/             CRUD on provider registry
│   │   ├── sessions/             manage captured sessions
│   │   ├── keys/                 API key generation + management
│   │   ├── refresh/              manual session refresh
│   │   ├── dashboard/            aggregated stats endpoint
│   │   ├── logs/                 request log query
│   │   └── test/zai              SDK-backed test route (proves real GLM responds)
├── lib/
│   ├── providers/
│   │   ├── base.ts               ProviderAdapter contract + registry
│   │   ├── kimi.ts               Kimi (with /api/auth/refresh)
│   │   ├── zai.ts                Z.AI Chat
│   │   ├── deepseek.ts           DeepSeek Chat
│   │   ├── claude.ts             Claude.ai
│   │   ├── generic.ts            Fallback adapter for 8 other platforms
│   │   ├── index.ts              Registry of all built-in adapters
│   │   ├── seed.ts               Idempotent DB seeding
│   │   └── session-loader.ts     Session → AdapterSessionContext helper
│   ├── scheduler/
│   │   └── token-refresh.ts      Background scheduler (refresh + ping)
│   ├── openai/
│   │   └── api-key.ts            sk-or-* generation + SHA-256 hashing
│   └── dashboard/
│       └── types.ts              Shared types + helpers
├── components/dashboard/
│   ├── stats-grid.tsx
│   ├── providers-table.tsx
│   ├── sessions-table.tsx
│   ├── keys-table.tsx
│   ├── logs-table.tsx
│   ├── extension-card.tsx
│   └── quick-start-card.tsx
public/extension/
├── manifest.json                 Chrome MV3 manifest
├── background.js                 Service worker (auto-capture)
├── popup.html / popup.js         Extension UI
├── content.js                    Token observer on AI sites
└── icons/                        Extension icons
prisma/schema.prisma              Provider, ProviderSession, ApiKey, etc.
```

## Chrome Extension

1. Download the .zip via `/api/extension/download` or use `public/extension/`.
2. Unzip into a folder.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked** → select the folder.
6. Open the extension popup, set Backend URL to your OmniRoute server.
7. Log into AI sites — sessions are captured automatically.

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

- ✅ /v1/models returns provider-prefixed model list
- ✅ /v1/chat/completions forwards to upstream with browser-like headers
- ✅ /api/test/zai confirms real GLM model on z.ai responds (not a stub)
- ✅ Auto-capture via chrome.cookies.onChanged + content script + tab load
- ✅ Token refresh scheduler keeps sessions alive
READMEEOF

# ─── 4. Zip everything ────────────────────────────────────────────────
cd "$DOWNLOAD_DIR"
rm -f omniroute.zip
# Use python's zipfile (no zip dependency required)
python3 -c "
import zipfile, os
src = 'omniroute-bundle'
out = 'omniroute.zip'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(src):
        # skip node_modules etc.
        dirs[:] = [d for d in dirs if d not in {'node_modules', '.next', '__pycache__'}]
        for f in files:
            fp = os.path.join(root, f)
            arc = os.path.relpath(fp, src)
            z.write(fp, arc)
print(f'Created {out}: {os.path.getsize(out)} bytes')
"

# Also copy individual extension files for easy direct access
mkdir -p "$DOWNLOAD_DIR/extension"
cp "$PROJECT_DIR/public/extension/manifest.json" "$DOWNLOAD_DIR/extension/"
cp "$PROJECT_DIR/public/extension/background.js" "$DOWNLOAD_DIR/extension/"
cp "$PROJECT_DIR/public/extension/popup.html" "$DOWNLOAD_DIR/extension/"
cp "$PROJECT_DIR/public/extension/popup.js" "$DOWNLOAD_DIR/extension/"
cp "$PROJECT_DIR/public/extension/content.js" "$DOWNLOAD_DIR/extension/"
cp -r "$PROJECT_DIR/public/extension/icons" "$DOWNLOAD_DIR/extension/" 2>/dev/null || true

# Make an extension-only zip too (smaller, faster to download)
cd "$DOWNLOAD_DIR/extension"
rm -f ../omniroute-extension.zip
python3 -c "
import zipfile, os
out = '../omniroute-extension.zip'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk('.'):
        for f in files:
            fp = os.path.join(root, f)
            z.write(fp, fp)
print(f'Created {out}: {os.path.getsize(out)} bytes')
"

# Cleanup tmp
rm -rf "$TMP_DIR"

# Final listing
echo ""
echo "Files in download/:"
ls -la "$DOWNLOAD_DIR/"
echo ""
echo "Total size:"
du -sh "$DOWNLOAD_DIR/"*
