# Collective — single-origin container image (staging/validation deploys).
#
# Serves the built web app, the API, the MCP server, and the OAuth consent
# flow on ONE origin (see docs/deploy.md). This image is for standing up a
# public HTTPS endpoint to validate the claude.ai connector and Microsoft
# sign-in with TEST data. Production PHI belongs on a BAA-covered host — the
# AWS landing zone tracked in STATUS.md (PF-1..3) — not here.

# --- build: install deps, build tokens + web ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/tokens/package.json packages/tokens/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build --workspace packages/tokens \
 && npm run build --workspace apps/web

# --- run: server (via tsx) serving the built web app ---
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Carry the installed deps + sources + built web/tokens from the build stage.
COPY --from=build /app /app
# Durable data (state.json, audit.jsonl, audio/). Mount a persistent volume
# here on the host so it survives redeploys.
ENV COLLECTIVE_DATA_DIR=/data
# main.ts auto-detects apps/web/dist; set it explicitly for clarity.
ENV COLLECTIVE_WEB_DIR=/app/apps/web/dist
ENV PORT=4000
VOLUME /data
EXPOSE 4000
# COLLECTIVE_PUBLIC_URL and WEB_ORIGIN must be set at run time to the public
# HTTPS origin (see docs/deploy.md); OAuth discovery + redirects depend on them.
CMD ["npx", "tsx", "apps/server/src/main.ts"]
