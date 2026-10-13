#!/bin/sh
# Entrypoint of the dev containers (compose.dev.yaml). Runs the command as the owner of the bind-mounted source
# tree (LABDECK_SRC; on Linux the host user, so files written into the checkout stay the user's), after giving that
# user the writable volumes (LABDECK_VOLUMES). With LABDECK_NPM=1 it first runs `npm ci` when package-lock.json
# changed since the last install into the node_modules volume.
set -eu
src=${LABDECK_SRC:-/src}
if [ "$(id -u)" = 0 ]; then
  uid=$(stat -c %u "$src") gid=$(stat -c %g "$src")
  for d in ${LABDECK_VOLUMES:-} "$HOME"; do
    mkdir -p "$d"
    [ "$(stat -c %u:%g "$d")" = "$uid:$gid" ] || chown -R "$uid:$gid" "$d"
  done
  if [ "$uid" != 0 ]; then
    # ssh and ansible need a passwd entry for the uid
    getent group "$gid" >/dev/null || groupadd -o -g "$gid" dev
    getent passwd "$uid" >/dev/null || useradd -o -u "$uid" -g "$gid" -M -d "$HOME" -s /bin/sh dev
    exec setpriv --reuid="$uid" --regid="$gid" --clear-groups "$0" "$@"
  fi
fi
if [ "${LABDECK_NPM:-0}" = 1 ]; then
  lock=$(sha256sum "$src/package-lock.json" | cut -d' ' -f1)
  if [ "$(cat "$src/node_modules/.labdeck-lock" 2>/dev/null)" != "$lock" ]; then
    echo "npm ci（package-lock.json 有變動）" >&2
    find "$src/node_modules" "$src/apps/web/node_modules" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    (cd "$src" && npm ci --no-audit --no-fund)
    echo "$lock" >"$src/node_modules/.labdeck-lock"
  fi
fi
exec "$@"
