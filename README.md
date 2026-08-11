# Mirage

OpenAI-compatible gateway for free AI web sessions.

Mirage captures logins from AI chat sites (via a browser extension), keeps tokens alive, and exposes them as a drop-in `/v1` API you can point any OpenAI SDK at.

<p align="center">
  <img src="public/logo.svg" alt="Mirage" width="80" />
</p>

```text
Your app  →  Mirage /v1  →  Kimi / Z.AI / Claude / … (browser session)
```

---

## Features

- **OpenAI-compatible** — `/v1/models`, `/v1/chat/completions` (streaming supported)
- **Session harvester** — Chrome / Edge extension auto-captures cookies + tokens
- **Keep-alive** — background refresh so access tokens do not expire mid-request
- **Primary + fallback** — Chrome primary, Edge fallback; automatic failover on `401`/`403`
- **Add platforms from the UI** — Check → Connect; extension picks up new domains immediately
- **Dashboard** — providers, sessions, API keys, request logs

---

## Stack

- Next.js (App Router) + Prisma (SQLite by default)
- Bun or Node.js 20+
- Manifest V3 extension in `public/extension`

---

## Install

```bash
git clone https://github.com/Trueness04/Mirage.git
cd Mirage

bun install          # or: npm install
cp .env.example .env
bun run db:generate
bun run db:push
bun run dev
```

Open [http://localhost:3000](http://localhost:3000).

| Env | Default | Notes |
|-----|---------|--------|
| `DATABASE_URL` | `file:./dev.db` | SQLite path; switch to Postgres URL if you change Prisma datasource |
| `MIRAGE_ADMIN_SECRET` | _(empty)_ | Required in production. Unlocks the dashboard; localhost works without it in development |

---

## Setup in 3 steps

1. **API key** — Dashboard → API Keys → create (`sk-mg-…`)
2. **Extension** — Dashboard → Extension → download zip, or load `public/extension` unpacked in `chrome://extensions` (Developer mode). Set Backend URL to your Mirage origin.
3. **Capture** — Log into AI sites (Kimi, chat.z.ai, …). Sessions appear under Sessions. For failover, install the same extension on **Edge** and log in again.

---

## API

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="sk-mg-...",
)

print(client.chat.completions.create(
    model="<provider/modelKey from GET /v1/models>",
    messages=[{"role": "user", "content": "Hello"}],
).choices[0].message.content)
```

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-mg-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"<provider/modelKey>","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

Model IDs come from live import after session capture — list them with `GET /v1/models`.

---

## Deployment

Build and run:

```bash
bun install
bun run db:generate
bun run db:push
bun run build
bun run start
```

| Host | Notes |
|------|--------|
| **VPS / Docker** | Prefer this. Persist the SQLite file (or use Postgres). Put HTTPS in front (Caddy/Nginx). Point the extension Backend URL at `https://your-domain`. |
| **Railway / Render / Fly** | Deploy from this repo; run `prisma generate` + `db push` on release; expose port `3000`. SQLite needs a volume — Postgres is safer on ephemeral disks. |
| **Vercel** | Possible for the Next app, but SQLite does not persist well on serverless. Use Postgres (update `prisma/schema.prisma` datasource) or host elsewhere. |

After deploy: HTTPS origin → extension Backend URL → create API key → capture sessions from the browser that has the extension.

---

## Add a platform

Dashboard → **Providers** → **Add platform**:

1. Paste website URL (optional API base `https://host/v1`)
2. **Check** — probes reachability / OpenAI-compatible `/models`
3. **Connect** — registers provider; extension monitors the domain on next register/heartbeat
4. Log in on the site to capture a session

For free OpenAI-style gateways, set API Base + model IDs so chat works without a custom adapter.

Custom protocol (non-OpenAI web UI): add `src/lib/providers/<name>.ts` and import it from `src/lib/providers/index.ts`.

---

## Primary / fallback

| Role | Browser | Priority |
|------|---------|----------|
| Primary | Chrome (first capture) | `0` |
| Fallback | Edge (second device) | `1` |

Install Mirage on both browsers with the same Backend URL, log into each AI site once. Routing tries primary first, then fallback.

---

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Dev server (`:3000`) |
| `bun run build` | Production build |
| `bun run start` | Run production server |
| `bun run db:push` | Sync Prisma schema |
| `bun run db:generate` | Generate Prisma client |

---

## Layout

```text
public/extension/     Chrome · Edge harvester
prisma/               Schema (SQLite)
src/app/              Dashboard + /v1 + /api
src/lib/providers/    Site adapters
src/lib/scheduler/    Token refresh loop
```

---

## Security

- Treat sessions and API keys as secrets; never commit `.env` or `*.db`
- Set `MIRAGE_ADMIN_SECRET` in `.env` to lock the dashboard (`/api/dashboard`, keys, sessions, …)
- Extension installs receive a per-device `deviceSecret` on register; session/heartbeat calls require it and may only update that device’s sessions
- Use HTTPS in production; keep Mirage private if you proxy personal accounts
- Personal / research use — respect each provider’s Terms of Service

---

## License

MIT
