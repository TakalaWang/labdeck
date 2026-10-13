#!/bin/sh
# deploy/updater/updater.sh 的測試（./labdeck test-updater；CI 也跑）。只需要 Docker，不連 GHCR、不碰真實主機。
# 在暫存目錄起一個拋棄式 compose 專案：本機 registry、小小的假 web／runner image、假 Discord webhook，
# updater 用 compose.yaml 裡真正的 updater 服務定義（extends），每一步跑一輪（docker compose run --rm updater once）：
#   v1 → v2 會更新；停著的 runner 保持停止；壞掉的 v3 會回復成 v2 且不再重試；
#   v4 在遷移 DB 後失敗：不自動回復；v5 正常 → 更新。每次結果都送到假 Discord。
# KEEP=1：跑完不拆（印出目錄與專案名稱）。
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
P=labdeck-updater-test
WORK=$(mktemp -d "${TMPDIR:-/tmp}/labdeck-updater-test.XXXXXX")
REG=$P-registry

dc() { docker compose -p "$P" --project-directory "$WORK" -f "$WORK/compose.yaml" "$@"; }

cleanup() {
  status=$?
  if [ "${KEEP:-0}" = 1 ]; then
    echo "KEEP=1：保留 $WORK（docker compose -p $P …）與 registry 容器 $REG"
  else
    dc --profile autoupdate down -v --remove-orphans >/dev/null 2>&1 || true
    docker rm -f "$REG" >/dev/null 2>&1 || true
    docker images --format '{{.Repository}}:{{.Tag}}' | grep "^$PREFIX-" | xargs docker rmi -f >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
  [ "$status" = 0 ] && echo "全部通過" || echo "失敗（exit $status）" >&2
}
PREFIX='unset'
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

# --- 本機 registry ---
docker rm -f "$REG" >/dev/null 2>&1 || true
docker run -d --name "$REG" -p 127.0.0.1::5000 registry:2.8.3 >/dev/null
PORT=$(docker port "$REG" 5000/tcp | head -n 1 | sed 's/.*://')
PREFIX=localhost:$PORT/labdeck

# 假 image：web 以 busybox httpd 在 3000 提供 /api/session；OK=0 時沒有這個檔（404）；MIGRATE=1 時印出遷移 DB 的訊息
push_web() { # 版本 OK MIGRATE
  docker build -q -t "$PREFIX-web:main" --build-arg V="$1" --build-arg OK="$2" --build-arg MIGRATE="$3" - >/dev/null <<'EOF'
FROM busybox:1.37.0
ARG V OK MIGRATE
ENV MIGRATE=$MIGRATE
LABEL org.opencontainers.image.version=main org.opencontainers.image.revision=rev${V}aaaaaaaa
RUN mkdir -p /www/api && if [ "$OK" = 1 ]; then echo "v$V" >/www/api/session; fi
CMD ["sh", "-c", "[ \"$MIGRATE\" != 1 ] || echo 'backed up the DB to /data/backup/pre-migrate-x.db before migrating it'; exec httpd -f -p 3000 -h /www"]
EOF
  docker push -q "$PREFIX-web:main" >/dev/null
}
push_runner() {
  docker build -q -t "$PREFIX-runner:main" --build-arg V="$1" - >/dev/null <<'EOF'
FROM busybox:1.37.0
ARG V
LABEL org.opencontainers.image.version=main org.opencontainers.image.revision=rev${V}aaaaaaaa
CMD ["sleep", "infinity"]
EOF
  docker push -q "$PREFIX-runner:main" >/dev/null
}

# --- 部署目錄（同正式環境：compose.yaml、deploy/、.env、secrets/）---
mkdir -p "$WORK/deploy/site" "$WORK/secrets" "$WORK/mock/cgi-bin"
cp "$REPO/compose.yaml" "$WORK/compose.base.yaml"
cp -R "$REPO/deploy/updater" "$WORK/deploy/"
echo extra-ok >"$WORK/deploy/site/ok" # 相對路徑的 bind mount：確認 updater 重建容器時路徑仍指到主機上的這個目錄
printf '%s' http://discord/cgi-bin/hook >"$WORK/secrets/discord_webhook"
cat >"$WORK/mock/cgi-bin/hook" <<'EOF'
#!/bin/sh
head -c "$CONTENT_LENGTH" >>/tmp/hooks
echo >>/tmp/hooks
printf 'Status: 204 No Content\r\n\r\n'
EOF
chmod +x "$WORK/mock/cgi-bin/hook"
cat >"$WORK/.env" <<EOF
LABDECK_IMAGE_PREFIX=$PREFIX
LABDECK_VERSION=main
LABDECK_UPDATE_TIMEOUT=20
SITE_ADDRESS=:80
EOF
cat >"$WORK/compose.yaml" <<'EOF'
name: labdeck-updater-test
services:
  web:
    image: ${LABDECK_IMAGE_PREFIX}-web:${LABDECK_VERSION}
    restart: unless-stopped
    env_file: .env # 同正式環境：compose 在 updater 容器內也要讀得到部署目錄的 .env
    volumes: ["./deploy/site:/www/extra:ro"]
    networks: [lab]
  runner:
    image: ${LABDECK_IMAGE_PREFIX}-runner:${LABDECK_VERSION}
    restart: unless-stopped
    networks: [lab]
  prometheus: # 不是 LabDeck 的 image：不拉、不動
    image: busybox:1.37.0
    command: [sleep, infinity]
    networks: [lab]
  discord: # 假 Discord webhook：收到的內容在容器內 /tmp/hooks
    image: busybox:1.37.0
    command: [httpd, -f, -p, "80", -h, /www]
    volumes: ["./mock:/www:ro"]
    networks: [lab]
  updater:
    extends: {file: compose.base.yaml, service: updater}
networks:
  lab:
volumes:
  updater_state:
EOF

hooks() { dc exec -T discord sh -c 'cat /tmp/hooks 2>/dev/null' || true; }
nhooks() { hooks | grep -c . || true; }
get() { dc exec -T discord wget -q -O- "http://web:3000/$1" 2>/dev/null || true; }
img() { docker inspect -f '{{.Image}}' "$(dc ps -aq "$1")"; }
run_updater() { # 期望的 exit code
  set +e
  dc run --rm -T updater once >"$WORK/out" 2>&1
  rc=$?
  set -e
  sed 's/^/    | /' "$WORK/out"
  [ "$rc" = "$1" ] || fail "updater exit $rc，預期 $1"
}
wait_web() {
  i=0
  until [ "$(get api/session)" = "$1" ]; do
    i=$((i + 1))
    [ "$i" -lt 30 ] || fail "web 沒有提供 $1（現在：$(get api/session)）"
    sleep 1
  done
}

echo "== 準備：web、runner v1；runner 停止"
docker pull -q docker:28.5.2-cli >/dev/null
push_web 1 1 0
push_runner 1
dc up -d --quiet-pull web runner prometheus discord
dc stop runner
wait_web v1
runner_v1=$(img runner)

echo "== 沒有新版"
run_updater 0
grep -q '已是最新（web）' "$WORK/out" || fail "應該只檢查 web（runner 停止、prometheus 不是 LabDeck）"
[ "$(nhooks)" = 0 ] || fail "沒有更新不應通知"
ok "沒有新版：不動、不通知"

echo "== v2"
push_web 2 1 0
push_runner 2
run_updater 0
wait_web v2
[ "$(get extra/ok)" = extra-ok ] || fail "web 的 bind mount（./deploy/site）不對"
[ "$(docker inspect -f '{{.State.Status}}' "$(dc ps -aq runner)")" = exited ] || fail "runner 被啟動了"
[ "$(img runner)" = "$runner_v1" ] || fail "停著的 runner 被換了 image"
hooks | grep -q '更新完成：web main (rev2aaa)' || fail "沒有成功通知：$(hooks)"
ok "v1 → v2 更新、通知；停止的 runner 保持停止"
web_v2=$(img web)

echo "== 壞掉的 v3"
push_web 3 0 0
run_updater 1
wait_web v2
[ "$(img web)" = "$web_v2" ] || fail "沒有回復成 v2"
hooks | grep -q '更新失敗，已回復舊版：web main (rev3aaa)' || fail "沒有回復通知：$(hooks)"
ok "v3 健康檢查失敗 → 回復 v2、通知"

echo "== v3 仍是最新版：不重試"
n=$(nhooks)
run_updater 0
grep -q '略過 web 的 main (rev3aaa)' "$WORK/out" || fail "應該略過壞掉的 v3"
[ "$(img web)" = "$web_v2" ] || fail "web 被換掉了"
[ "$(docker image inspect -f '{{.Id}}' "$PREFIX-web:main")" = "$web_v2" ] || fail "image 名稱應指回 v2"
[ "$(nhooks)" = "$n" ] || fail "略過不應通知"
ok "壞掉的 v3 不重試"

echo "== v4：遷移 DB 後失敗"
push_web 4 0 1
run_updater 1
[ "$(img web)" != "$web_v2" ] || fail "遷移過 DB 不應自動回復"
hooks | grep -q '沒有自動回復' || fail "沒有「不自動回復」的通知：$(hooks)"
ok "遷移 DB 後失敗 → 不自動回復、通知"

echo "== v5"
push_web 5 1 0
run_updater 0
wait_web v5
hooks | grep -q '更新完成：web main (rev5aaa)' || fail "沒有成功通知"
ok "更新的版本出現後照常更新"

echo "== 常駐模式（docker compose --profile autoupdate up -d）"
dc --profile autoupdate up -d updater
i=0
until dc logs updater 2>/dev/null | grep -q '已是最新（web）'; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || { dc logs updater; fail "常駐的 updater 沒有跑完第一輪"; }
  sleep 1
done
[ "$(dc ps -q updater)" != "" ] || fail "updater 沒有在跑"
ok "常駐的 updater 跑完第一輪且繼續執行"
