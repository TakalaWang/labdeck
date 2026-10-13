#!/usr/bin/env bash
# 端對端測試：把 repo 複製到 e2e/.work/app，產生測試用 secrets 與 .env，
# 以 compose.yaml + e2e/compose.e2e.yaml 起整套服務（外加假 OAuth 與假主機 gpu01），再跑 Playwright。
#
#   e2e/run.sh [playwright 參數…]     例如 e2e/run.sh -g CSRF（或 ./labdeck e2e …）
#   KEEP=1        跑完不拆環境（http://localhost:8080 ，以 tester 或任意名稱登入）
#   SKIP_BUILD=1  不重建 image（沿用上次建好的）
#
# 只需要 Docker（可跑 privileged 容器）：本腳本會在 e2e/Dockerfile 的 image（Playwright + docker CLI）內重跑自己，
# 經主機的 Docker socket 操作 compose；repo 以相同路徑掛進容器，compose 的相對路徑因此在主機上也成立。
# 不會連到任何真實主機。
set -euo pipefail

E2E=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(dirname "$E2E")

if [[ ${LABDECK_E2E_IN_CONTAINER:-0} != 1 ]]; then
  img=labdeck-e2e-driver:local
  if [[ ${SKIP_BUILD:-0} != 1 ]] || ! docker image inspect "$img" >/dev/null 2>&1; then
    docker build -q -t "$img" - <"$E2E/Dockerfile" >/dev/null # no build context needed
  fi
  tty=
  if [[ -t 1 ]]; then tty=-t; fi
  # node_modules in a volume: the host's e2e/ stays free of Linux packages
  exec docker run --rm --init $tty \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$REPO:$REPO" -w "$REPO" -v labdeck-e2e-node-modules:"$E2E/node_modules" \
    -e LABDECK_E2E_IN_CONTAINER=1 -e HOST_OWNER="$(id -u):$(id -g)" -e KEEP -e SKIP_BUILD -e CI \
    "$img" "$E2E/run.sh" "$@"
fi

WORK=$E2E/.work
APP=$WORK/app
LOGS=$WORK/logs
NETWORK=labdeck-e2e_lab # compose project labdeck-e2e（e2e/compose.e2e.yaml）
export E2E_APP_DIR=$APP # tests/helpers.ts 在這裡跑 docker compose

dc() { (cd "$APP" && docker compose -f compose.yaml -f e2e/compose.e2e.yaml "$@"); }

# 每秒重試，直到指令成功或逾時：wait_for <說明> <秒數> <指令…>
wait_for() {
  local what=$1 timeout=$2 i
  shift 2
  for ((i = 0; i < timeout; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "逾時（${timeout}s）：$what" >&2
  return 1
}

cleanup() {
  local status=$?
  if [[ -f $APP/e2e/compose.e2e.yaml ]]; then
    mkdir -p "$LOGS"
    local svc
    for svc in $(dc config --services 2>/dev/null); do
      dc logs --no-color --timestamps "$svc" >"$LOGS/$svc.log" 2>&1 || true
    done
    if [[ ${KEEP:-0} == 1 ]]; then
      echo "KEEP=1：環境保留在 http://localhost:8080 。拆除：(cd ${APP#"$REPO"/} && docker compose -f compose.yaml -f e2e/compose.e2e.yaml down -v)"
    else
      docker network disconnect -f "$NETWORK" "$HOSTNAME" >/dev/null 2>&1 || true
      dc down -v --remove-orphans >"$LOGS/down.log" 2>&1 || true
    fi
  fi
  # 檔案還給主機上的使用者（容器內是 root）
  if [[ ${HOST_OWNER:-0:0} != 0:* ]]; then
    chown -R "$HOST_OWNER" "$WORK" "$E2E/test-results" "$E2E/playwright-report" 2>/dev/null || true
  fi
  ((status == 0)) || echo "e2e 失敗（exit $status）；各服務 log 在 e2e/.work/logs/，Playwright 報告：e2e/playwright-report/index.html" >&2
  exit "$status"
}

# 上次 KEEP=1 留下的環境先拆掉，再重建工作目錄
if [[ -f $APP/e2e/compose.e2e.yaml ]]; then dc down -v --remove-orphans >/dev/null 2>&1 || true; fi
rm -rf "$APP" "$LOGS"
mkdir -p "$APP" "$LOGS"
trap cleanup EXIT

echo "== 複製 repo 到 e2e/.work/app"
# 不複製 .env 與 secrets/：同一份 checkout 可能就是正式部署
rsync -a --exclude=.git --exclude=node_modules --exclude=.next --exclude=dist --exclude=__pycache__ --exclude=.pytest_cache --exclude=/crates/agent/target \
  --exclude=/.env --exclude=/secrets --exclude=/e2e/.work --exclude=/e2e/test-results --exclude=/e2e/playwright-report \
  "$REPO/" "$APP/"

# LABDECK_*：compose.yaml 的 image 名稱，用本機建置的 labdeck-*:local，不從 registry 拉
cat >"$APP/.env" <<ENV
LABDECK_IMAGE_PREFIX=labdeck
LABDECK_VERSION=local
PUBLIC_URL=http://localhost:8080
SITE_ADDRESS=http://localhost:8080
SITE_NAME=E2E Lab
TZ=Asia/Taipei
SESSION_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
OAUTH_NAME=MockSSO
OAUTH_CLIENT_ID=e2e-client
OAUTH_CLIENT_SECRET=e2e-client-secret
OAUTH_AUTHORIZE_URL=http://localhost:9999/authorize
OAUTH_TOKEN_URL=http://mock-oauth:9999/token
OAUTH_PROFILE_URL=http://mock-oauth:9999/profile
DISCORD_WEBHOOK_URL=http://mock-oauth:9999/discord
DISCORD_CLIENT_ID=e2e-discord
DISCORD_CLIENT_SECRET=e2e-discord-secret
DISCORD_AUTHORIZE_URL=http://localhost:9999/discord/oauth2/authorize
DISCORD_TOKEN_URL=http://mock-oauth:9999/discord/api/oauth2/token
DISCORD_PROFILE_URL=http://mock-oauth:9999/discord/api/users/@me
SMTP_HOST=mock-oauth
SMTP_PORT=2525
SMTP_SECURITY=none
SMTP_FROM=lab@example.edu
RESERVED_USERS=admin
MONITORING_SOURCE=172.31.250.0/24
ENV

if [[ ${SKIP_BUILD:-0} != 1 ]]; then
  echo "== 建置 image"
  dc build
fi

echo "== 產生測試用 secrets/"
S=$APP/secrets
RUNNER_IMAGE=labdeck-runner:local DISCORD_WEBHOOK=http://mock-oauth:9999/discord \
  "$APP/scripts/init-secrets.sh" "$S" >"$LOGS/init-secrets.log"
# 丟棄式的測試機密：開放讀取，容器內的 app（uid 1000）與 nobody 都讀得到
chmod 755 "$S"
chmod 644 "$S"/*

echo "== 啟動 compose"
dc up -d --wait --wait-timeout 300
# 本容器接上 compose 網路，localhost:8080／9999 轉給 caddy／mock-oauth：瀏覽器與測試看到的網址和在主機上相同
docker network connect "$NETWORK" "$HOSTNAME"
socat TCP-LISTEN:8080,bind=127.0.0.1,fork,reuseaddr TCP:caddy:8080 2>>"$LOGS/socat.log" &
socat TCP-LISTEN:9999,bind=127.0.0.1,fork,reuseaddr TCP:mock-oauth:9999 2>>"$LOGS/socat.log" &
wait_for "web（/api/session）" 120 curl -fsS http://localhost:8080/api/session
wait_for "gpu01 的 sshd" 120 dc exec -T gpu01 systemctl is-active --quiet ssh
dc exec -T web labdeck add-admin tester tester

echo "== Playwright"
cd "$E2E"
npm ci --no-audit --no-fund
npx playwright test "$@"
