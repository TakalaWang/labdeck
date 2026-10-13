#!/bin/sh
# Move a lab-dashboard deployment (compose project lab-dashboard, built from source) to LabDeck on prebuilt images.
# Run as root on the monitoring host; needs only Docker and curl:
#   curl -fsSL https://raw.githubusercontent.com/TakalaWang/labdeck/main/scripts/migrate-from-lab-dashboard.sh | sh -s -- /opt/lab-dashboard /opt/labdeck
# The runner is NOT started: it would immediately run today's nightly collect (SSH to every host). Start it yourself
# afterwards with `docker compose up -d runner` once you want jobs to run. The old volumes are kept for rollback.
set -eu
OLD=${1:?usage: migrate-from-lab-dashboard.sh OLD_DIR NEW_DIR}
NEW=${2:?usage: migrate-from-lab-dashboard.sh OLD_DIR NEW_DIR}
REF=${LABDECK_REF:-main}
VOLS="portal_data prom_sd prometheus_data alertmanager_data caddy_data"

[ -f "$OLD/.env" ] && [ -d "$OLD/secrets" ] || { echo "no .env / secrets/ in $OLD" >&2; exit 1; }
[ -e "$NEW/.env" ] && { echo "$NEW/.env already exists: refusing to overwrite" >&2; exit 1; }

echo "== 1/6 deployment files ($REF) → $NEW"
mkdir -p "$NEW"
TMP=$(mktemp -d)
curl -fsSL "https://github.com/TakalaWang/labdeck/archive/$REF.tar.gz" | tar xz -C "$TMP" --strip-components=1
cp -p "$TMP/compose.yaml" "$NEW/" && cp -Rp "$TMP/deploy" "$NEW/"
rm -rf "$TMP"
cp -p "$OLD/.env" "$NEW/.env"
cp -a "$OLD/secrets" "$NEW/secrets"
grep -q '^LABDECK_VERSION=' "$NEW/.env" || echo "LABDECK_VERSION=$REF" >> "$NEW/.env"
cd "$NEW"

echo "== 2/6 pull images"
docker compose pull -q caddy web runner prometheus alertmanager

echo "== 3/6 back up the database (online, inside the old volume)"
docker run --rm -v lab-dashboard_portal_data:/v alpine sh -c \
  'apk add -q sqlite >/dev/null && mkdir -p /v/backup && sqlite3 /v/portal.db ".backup /v/backup/pre-labdeck.db" && chmod 600 /v/backup/pre-labdeck.db'

echo "== 4/6 stop lab-dashboard, copy its volumes to labdeck_*"
docker compose -p lab-dashboard down
docker compose up --no-start caddy web runner prometheus alertmanager
for v in $VOLS; do
  # cp -a keeps the contents' owners; the volume root needs its owner too (prometheus/alertmanager run as nobody)
  docker run --rm -v "lab-dashboard_$v":/from:ro -v "labdeck_$v":/to alpine sh -c 'cp -a /from/. /to/ && chown "$(stat -c %u:%g /from)" /to'
done

echo "== 5/6 start (without the runner)"
docker compose up -d caddy web prometheus alertmanager
sleep 15
docker compose ps --format '{{.Service}}  {{.Status}}'

echo "== 6/6 firewall: let this host's Prometheus scrape its own node_exporter (compose subnet changed)"
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  PORT=$(sed -n 's/^NODE_EXPORTER_PORT=//p' .env); PORT=${PORT:-9100}
  SUBNET=$(docker network inspect labdeck_lab -f '{{(index .IPAM.Config 0).Subnet}}')
  ufw allow from "$SUBNET" to any port "$PORT" proto tcp comment 'labdeck prometheus (self)' >/dev/null
  ufw status | grep "$PORT"
fi
echo "Done. Check the site, then: cd $NEW && docker compose up -d runner. Old volumes lab-dashboard_* kept for rollback."
