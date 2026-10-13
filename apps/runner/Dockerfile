# check=skip=FromPlatformFlagConstDisallowed
# labdeck-runner: the job runner (apps/runner, Node 24 runs its TypeScript directly) plus Ansible, and the `cli`
# service (same image). The only image whose containers get the SSH key and the vault (./secrets).
# Build context: the repo root (compose: context ., dockerfile apps/runner/Dockerfile); the agent crate comes in
# as the named build context "agent" (compose additional_contexts; docker build: --build-context agent=crates/agent).

# --- labdeck-agent (crates/agent): the static x86_64 binary the playbooks copy to the hosts ---------------------
# Always linux/amd64 (the hosts are x86_64), so it also builds, emulated, on an arm64 machine.
# (Not named "agent": that is the build context.)
FROM --platform=linux/amd64 rust:1.91.0-alpine AS agent-build
# musl-dev: crt files for linking the proc-macro (serde_derive) build dependencies
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY --from=agent Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY --from=agent src ./src
RUN cargo build --release --locked --target x86_64-unknown-linux-musl

# --- runner dependencies (nodemailer; @labdeck/core is a workspace link) -----------------------------------------
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
RUN npm ci -w @labdeck/runner --omit=dev --no-audit --no-fund

FROM python:3.12-slim
# TZ: compose passes the site's TZ from .env (約定 B).
ENV TZ=UTC PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 NODE_ENV=production
# sshpass: bootstrap_bot.yaml logs in once with an existing admin account (--ask-pass). libstdc++6: node.
# openssl: labdeck-init-secrets. vim-tiny: `ansible-vault edit` in the container (the host needs only Docker).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client sshpass sqlite3 tzdata libstdc++6 openssl vim-tiny \
 && rm -rf /var/lib/apt/lists/*

# ansible (full package → ansible.posix, community.general) is the big, rarely-changing layer;
# passlib for password_hash.
# ponytail: ansible 12 = core 2.19, the last core that manages Python 3.8 targets (Ubuntu 20.04);
# bump once every host runs 22.04+.
RUN pip install ansible==12.3.0 passlib==1.7.4

COPY --from=deps /usr/local/bin/node /usr/local/bin/node
COPY --from=agent-build /src/target/x86_64-unknown-linux-musl/release/labdeck-agent /opt/labdeck/bin/labdeck-agent

# /prom_sd exists in the image so the prom_sd named volume starts out owned by app.
RUN useradd --create-home --uid 1000 app && mkdir -p /data /prom_sd && chown app:app /data /prom_sd
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/core/package.json packages/core/schema.sql packages/core/guide.md ./packages/core/
COPY packages/core/src ./packages/core/src
COPY apps/runner/package.json ./apps/runner/
COPY apps/runner/src ./apps/runner/src
RUN printf '#!/bin/sh\nexec node /app/packages/core/src/cli.ts "$@"\n' > /usr/local/bin/labdeck && chmod 755 /usr/local/bin/labdeck
RUN printf '#!/bin/sh\nexec node /app/apps/runner/src/inventory.ts "$@"\n' > /usr/local/bin/labdeck-inventory && chmod 755 /usr/local/bin/labdeck-inventory
# The playbooks (ANSIBLE_CONFIG=/repo/ansible/ansible.cfg, the cli working directory): a deployment needs no checkout.
COPY ansible /repo/ansible
# Generates secrets/ (scripts/init-secrets.sh runs this when the host has no ansible-vault).
COPY scripts/init-secrets.sh /usr/local/bin/labdeck-init-secrets
ENV LABDECK_CORE_DIR=/app/packages/core
USER app
CMD ["node", "/app/apps/runner/src/main.ts"]
