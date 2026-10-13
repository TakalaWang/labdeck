# labdeck-toolbox: the development tools, so a contributor's machine needs only Docker (docs/docker.md).
# Node 24 (npm workspaces: typecheck, lint, vitest, next dev/build), Rust 1.91.0 with rustfmt and clippy
# (crates/agent; same version as crates/agent/rust-toolchain.toml), ssh-keygen (vitest).
# Used by compose.dev.yaml (toolbox, the Next.js dev server) and CI; the source is bind-mounted at /src.
FROM node:24-bookworm-slim AS node

FROM rust:1.91.0-slim-bookworm
RUN rustup component add rustfmt clippy \
 && apt-get update \
 && apt-get install -y --no-install-recommends openssh-client tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
# Registry cache and build output live in the volumes compose.dev.yaml mounts here, not in the source tree.
ENV CARGO_HOME=/cargo CARGO_TARGET_DIR=/cargo/target HOME=/home/dev NEXT_TELEMETRY_DISABLED=1 NPM_CONFIG_UPDATE_NOTIFIER=false
RUN mkdir -p /cargo /home/dev /src && chmod 1777 /home/dev
WORKDIR /src
