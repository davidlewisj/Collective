# Deploying Collective (public HTTPS)

This guide stands up a **public HTTPS endpoint** so the two things that need
to reach your server from the internet actually work:

- **The claude.ai connector** — Claude connects from Anthropic's cloud, so it
  can't reach `localhost`; the MCP OAuth flow (spec §6.4) needs a public URL.
- **Microsoft sign-in** with a real redirect URI on your domain.

> [!IMPORTANT]
> **This is a staging / validation deployment — do not put real patient
> information on it.** Collective is HIPAA-scoped: PHI may only live on a host
> covered by a signed Business Associate Agreement. The managed hosts below
> (Render, Fly, a generic VPS) are fine for exercising the connector and
> sign-in with **test/demo meetings**, but production PHI belongs on the
> BAA-covered AWS landing zone tracked in `STATUS.md` (PF‑1..3), not here.
> Keep the per-meeting "Contains patient info?" flag on and the BAA registry
> honest even in staging.

## What "single origin" means

In production the server serves **everything on one origin**: the web app, the
API, the MCP endpoint, and the OAuth consent page. There is no separate Vite
dev server and no cross-origin proxy. Set one public URL and the whole app —
including the `/oauth/*` and `/.well-known/*` discovery endpoints Claude reads —
answers there.

The container image (`Dockerfile`) builds the web app and runs the server with
`COLLECTIVE_WEB_DIR` pointing at it; `main.ts` also auto-detects `apps/web/dist`
if you run outside Docker.

## Environment variables

| Variable | Required | Value |
|---|---|---|
| `COLLECTIVE_PUBLIC_URL` | see note | The public origin, e.g. `https://collective.example.com`. Becomes the OAuth issuer + MCP resource. **On Render this is auto-detected** from `RENDER_EXTERNAL_URL` — you can leave it unset. |
| `WEB_ORIGIN` | see note | Same value as `COLLECTIVE_PUBLIC_URL` (single origin). Falls back to `COLLECTIVE_PUBLIC_URL` / `RENDER_EXTERNAL_URL`, so it's also auto-set on Render. |
| `COLLECTIVE_DATA_DIR` | recommended | Path on a **persistent** disk (image default `/data`). Holds `state.json`, `audit.jsonl`, `audio/`. |
| `PORT` | no | Listen port (default `4000`). Most hosts inject their own; the server honors it. |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` | for MS sign-in | From your Entra app registration. |
| `GRAPH_REDIRECT_URI` | for MS sign-in | `https://<your-domain>/auth/callback`. |
| `ASSEMBLYAI_API_KEY`, Bedrock vars, `COLLECTIVE_BAA` | optional | Only after the matching BAA is signed (`docs/procurement-baa-runbook.md`). Leave unset in staging to stay on mock adapters. |

Single origin means **no** `COLLECTIVE_ALLOWED_ORIGINS` is needed (the browser
never makes a cross-origin call).

## Option A — Render (simplest)

The repo ships a **Render Blueprint** (`render.yaml`), so Render provisions the
service, the persistent disk, and the health check for you — and the server
picks up its own public URL from `RENDER_EXTERNAL_URL`, so there's **no URL to
set by hand**.

1. Push this repo to GitHub (already done for the working branch).
2. Render → **New → Blueprint** → connect the repo → **Apply**. It reads
   `render.yaml`: a Docker web service named `collective`, a 1 GB disk at
   `/data`, health check `/health`, plan **Starter**.
3. Wait for the first deploy. Render terminates TLS, so it's HTTPS immediately
   at the assigned `https://collective-xxxx.onrender.com`.
4. That's the whole app. To turn on **Microsoft sign-in**, add `GRAPH_TENANT_ID`,
   `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` in the service's **Environment** tab
   (the Blueprint lists them, left blank), and add the redirect URI below.

> **Cost / persistence:** Starter is ~$7/month and is what keeps the disk and
> keeps the app awake — the Claude connector needs that, because the OAuth
> clients and tokens live on the disk. A **Free** instance works for a quick
> look but sleeps when idle and loses the disk (you'd re-create the connector
> each time). To try Free, remove the `disk:` and set `plan: free` in
> `render.yaml`.

**Prefer clicking it yourself?** New → Web Service → Docker, add a disk at
`/data`, set health check `/health`. Leave the URL vars unset (auto-detected).

## Option B — Fly.io

```bash
fly launch --dockerfile Dockerfile --no-deploy   # creates fly.toml + app
fly volume create data --size 3                  # persistent /data
# In fly.toml: mount the volume at /data, set internal_port = 4000.
fly secrets set COLLECTIVE_PUBLIC_URL=https://<app>.fly.dev WEB_ORIGIN=https://<app>.fly.dev
fly deploy
```

Fly provides HTTPS on `*.fly.dev` automatically. Add `GRAPH_*` via `fly secrets set`.

## Option C — a server you control (VPS)

Run the container behind a TLS-terminating reverse proxy. With
[Caddy](https://caddyserver.com) (automatic Let's Encrypt certificates):

```bash
docker build -t collective .
docker run -d --name collective -p 127.0.0.1:4000:4000 \
  -v /srv/collective-data:/data \
  -e COLLECTIVE_PUBLIC_URL=https://collective.example.com \
  -e WEB_ORIGIN=https://collective.example.com \
  collective
```

`Caddyfile`:

```
collective.example.com {
  reverse_proxy 127.0.0.1:4000
}
```

Caddy obtains and renews the certificate; point your domain's DNS at the box first.

## After it's live

1. **Verify discovery** (what Claude will read):
   ```bash
   curl https://<your-domain>/.well-known/oauth-protected-resource
   curl https://<your-domain>/.well-known/oauth-authorization-server
   curl https://<your-domain>/health
   ```
   The `resource` should be `https://<your-domain>/mcp` and `issuer` your domain.

2. **Microsoft sign-in**: in the Entra app registration, add the redirect URI
   `https://<your-domain>/auth/callback`, and grant admin consent for
   `Calendars.Read` if you haven't. Set the `GRAPH_*` env vars.

3. **claude.ai connector**:
   - Sign in to Collective as an org admin → **Admin → Claude connectors** →
     *Create connector*. For the redirect URL use the value claude.ai shows when
     you add a custom connector (currently `https://claude.ai/api/mcp/auth_callback`).
     Copy the **Client ID** and **Client secret** (shown once).
   - In claude.ai → **Settings → Connectors → Add custom connector**: MCP server
     URL `https://<your-domain>/mcp`, then paste the Client ID and secret.
   - Each teammate who enables it signs into Collective and approves on the
     consent screen; from then on Claude sees only what that person can, and
     patient-info-flagged meetings stay hidden per the BAA registry.

## Persistence & resets

Everything durable lives under `COLLECTIVE_DATA_DIR` (`/data` in the image). Mount
a persistent volume there or a redeploy starts empty. Sessions and in-flight
OAuth codes are intentionally **not** persisted — a restart just means signing in
again. Deleting the volume is a full reset.
