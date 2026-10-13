#!/usr/bin/env bash
# 產生部署用的 secrets/（docs/design.md 約定 A）。主機只需要 Docker：這個腳本在 runner image 內執行
# （image 內是 /usr/local/bin/labdeck-init-secrets）；在主機上執行時，會改在 runner image 內執行那一份。
#   scripts/init-secrets.sh [目錄，預設 ./secrets]        在 compose.yaml 所在目錄執行（用 .env 指定的 runner image）
#   docker run --rm -v "$PWD/secrets:/secrets" <runner image> labdeck-init-secrets /secrets
# 選填環境變數：DISCORD_WEBHOOK（Alertmanager 用；未設定則不送通知）、RUNNER_IMAGE（指定 runner image）
set -euo pipefail

S=${1:-secrets}
if [[ -d $S && -n $(ls -A "$S") ]]; then
  echo "$S 已有檔案；為避免覆蓋既有的 key 與 vault，停止。" >&2
  exit 1
fi

if [[ ${0##*/} != labdeck-init-secrets ]]; then # on the host: run the copy in the runner image
  img=${RUNNER_IMAGE:-$(docker compose config --images runner 2>/dev/null | head -n 1)}
  if [[ -z $img ]]; then
    echo "找不到 runner image：在 compose.yaml 所在目錄（且已有 .env）執行，或設定 RUNNER_IMAGE" >&2
    exit 1
  fi
  mkdir -p "$S"
  S=$(cd "$S" && pwd)
  # root：產生後直接把檔案交給容器內的使用者（uid 1000、65534），主機上不必 sudo chown
  exec docker run --rm --user 0:0 -e DISCORD_WEBHOOK -v "$S:/secrets" "$img" labdeck-init-secrets /secrets
fi

mkdir -p "$S"
chmod 700 "$S"
S=$(cd "$S" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

ssh-keygen -q -t ed25519 -N '' -C labbot -f "$S/ssh_key"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -subj /CN=node-exporter -addext subjectAltName=DNS:node-exporter \
  -keyout "$tmp/node_exporter.key" -out "$S/node_exporter.crt" 2>/dev/null

password=$(openssl rand -hex 16)
printf '%s' "$password" >"$S/node_exporter_password"
bcrypt=$(printf '%s' "$password" | python3 -c \
  'import sys; from passlib.hash import bcrypt; print(bcrypt.using(rounds=10).hash(sys.stdin.read()))')

{
  echo "vault_bot_become_password: $(openssl rand -hex 16)"
  echo "vault_node_exporter_basic_auth_bcrypt: '$bcrypt'"
  echo "vault_node_exporter_tls_key: |"
  sed 's/^/  /' "$tmp/node_exporter.key"
} >"$S/vault.yml"
openssl rand -base64 32 >"$S/vault_pass"
# ponytail: without a webhook, alerts fail to deliver (logged by Alertmanager) instead of blocking startup.
printf '%s' "${DISCORD_WEBHOOK:-http://127.0.0.1:9/discord-not-configured}" >"$S/discord_webhook"

# stdio to a file: ansible refuses non-blocking stdio (e.g. under some IDE terminals)
# --vault-password-file only: compose sets ANSIBLE_VAULT_PASSWORD_FILE in the runner/cli containers
unset ANSIBLE_VAULT_PASSWORD_FILE
HOME=$tmp ansible-vault encrypt --vault-password-file "$S/vault_pass" "$S/vault.yml" </dev/null >"$tmp/vault.log" 2>&1 \
  || { cat "$tmp/vault.log" >&2; exit 1; }
chmod 600 "$S"/*
chmod 644 "$S/ssh_key.pub" "$S/node_exporter.crt" # public; the runner (uid 1000) and prometheus both read the cert
# Owners the containers expect (約定 A): runner/cli = 1000, prometheus/alertmanager = nobody (65534).
if [[ $(id -u) == 0 ]]; then
  chown -R 1000:1000 "$S" && chown 65534:65534 "$S/node_exporter_password" "$S/discord_webhook" \
    || echo "警告：無法變更 $S 的 owner（見 docs/deploy.md P0）" >&2
fi

cat <<EOF
已產生 secrets/（owner：runner、cli 為 uid 1000；node_exporter_password、discord_webhook 為 65534，給 prometheus、alertmanager）
EOF
