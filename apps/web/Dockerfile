# labdeck-web: the Next.js server (UI + JSON API, apps/web) as a standalone Node server.
# Build context: the repo root (compose: context ., dockerfile apps/web/Dockerfile) — it needs packages/core.
# Holds no SSH key and no vault: those are only in the runner image/container.
FROM node:24-slim AS build
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
RUN npm ci -w @labdeck/web --include-workspace-root --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/web apps/web
RUN npm run -w @labdeck/web build

FROM node:24-slim
# ssh-keygen: fingerprints and type checks of the SSH keys members paste (POST /api/me/keys)
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client tzdata \
 && rm -rf /var/lib/apt/lists/*
# TZ: compose passes the site's TZ from .env (約定 B). HOSTNAME: listen on every interface (Docker sets its own).
ENV TZ=UTC NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 LABDECK_CORE_DIR=/app/packages/core
WORKDIR /app
COPY --from=build /src/apps/web/.next/standalone ./
COPY --from=build /src/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /src/apps/web/public ./apps/web/public
COPY packages/core/schema.sql packages/core/guide.md packages/core/package.json ./packages/core/
COPY packages/core/src ./packages/core/src
# Admin CLI: docker compose exec web labdeck add-admin <sso_id> <linux_username>
RUN printf '#!/bin/sh\nexec node /app/packages/core/src/cli.ts "$@"\n' > /usr/local/bin/labdeck && chmod 755 /usr/local/bin/labdeck \
 && mkdir -p /data && chown node:node /data
# uid 1000 (node), the same owner as the runner's: both use the portal_data volume
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
