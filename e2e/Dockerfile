# The e2e driver (e2e/run.sh re-runs itself in this image, so the host needs only Docker): Playwright with its
# browsers (same version as e2e/package.json), the docker CLI + compose/buildx plugins (run.sh and the tests drive
# the stack through the host's Docker socket), rsync (copies the repo), curl, socat (localhost:8080/9999 → the stack).
FROM docker:29-cli AS docker
FROM mcr.microsoft.com/playwright:v1.63.0-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends rsync curl socat \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
