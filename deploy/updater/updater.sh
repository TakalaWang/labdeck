#!/bin/sh
# LabDeck 自動更新（docs/deploy.md「自動更新（CD）」）。compose 的 updater 服務（profile autoupdate）在 docker CLI image 內執行：
#   sh updater.sh        每 LABDECK_UPDATE_INTERVAL 秒跑一輪
#   sh updater.sh once   只跑一輪（docker compose run --rm updater once）
# 一輪：只對「正在跑」且 image 屬於 LABDECK_UPDATE_IMAGES 的服務 docker compose pull；image 有變的 up -d --no-deps，
# 等健康檢查；失敗就換回原本的 image 並記下壞掉的 image ID（同一個 image 不再重試，等更新的版本）。結果送 Discord。
# 不會啟動停著的服務；不處理自己（updater）。
set -eu

INTERVAL=${LABDECK_UPDATE_INTERVAL:-600}
TIMEOUT=${LABDECK_UPDATE_TIMEOUT:-180}
IMAGES=${LABDECK_UPDATE_IMAGES:-ghcr.io/takalawang/labdeck-}
CHECK_URL=${LABDECK_UPDATE_CHECK_URL-http://web:3000/api/session} # 只在 web 有在跑時檢查；設成空字串＝不檢查
WEBHOOK_FILE=${LABDECK_UPDATE_WEBHOOK_FILE:-/deploy/secrets/discord_webhook}
STATE=${LABDECK_UPDATE_STATE:-/state}
MIGRATION_MARK='before migrating it' # packages/core/src/db.ts migrate() 在備份並遷移 DB 前印出

log() { echo "$(date '+%F %T') updater: $*"; }

notify() {
  log "$1"
  url=$(cat "$WEBHOOK_FILE" 2>/dev/null) || return 0
  [ -n "$url" ] || return 0
  json=$(printf '%s' "[LabDeck] $1" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{ printf "%s%s", (NR > 1 ? "\\n" : ""), $0 }')
  wget -q -T 10 -O /dev/null --header 'Content-Type: application/json' --post-data "{\"content\":\"$json\"}" "$url" \
    || log "Discord 通知送不出去（$WEBHOOK_FILE）"
}

if [ "${1:-loop}" != once ]; then
  log "啟動：每 ${INTERVAL}s 檢查 ${IMAGES}* 的新版"
  while :; do
    sh "$0" once || log "本輪失敗（見上方訊息），下一輪再試"
    sleep "$INTERVAL"
  done
fi

# --- 一輪 ---
mkdir -p "$STATE"
exec 9>"$STATE/lock"
flock -n 9 || { log "另一個 updater 正在跑，略過這一輪"; exit 0; }
touch "$STATE/bad"

# 自己所在的 compose 專案（容器 label）。compose 會把相對路徑換成主機上的絕對路徑交給 Docker，
# 所以讓主機上的部署目錄路徑在容器內也指到同一份檔案（掛在 /deploy）。
self=$(hostname)
label() { docker inspect -f "{{index .Config.Labels \"$1\"}}" "$self"; }
PROJECT=$(label com.docker.compose.project)
DIR=$(label com.docker.compose.project.working_dir)
FILES=$(label com.docker.compose.project.config_files)
SELF_SVC=$(label com.docker.compose.service)
if [ -z "$PROJECT" ] || [ -z "$DIR" ]; then log "要以 compose 服務執行（找不到 compose 專案的 label）"; exit 1; fi
if [ ! -e "$DIR" ]; then
  mkdir -p "$(dirname "$DIR")"
  ln -s /deploy "$DIR"
fi
FARGS=
for f in $(echo "$FILES" | tr , ' '); do FARGS="$FARGS -f $f"; done
# shellcheck disable=SC2086 # FARGS：部署目錄路徑不含空白
dc() { docker compose --project-directory "$DIR" -p "$PROJECT" $FARGS "$@"; }

# 服務目前的容器（含停止中的；不含 docker compose run 的一次性容器）
cid() {
  docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" \
    --filter label=com.docker.compose.oneoff=False | head -n 1
}
# image 的版本：CI 的 OCI label（main 或 1.2.3）與 commit，沒有就用 image ID
ver() {
  v=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null \
    | awk '$1 != "" { printf "%s", $1 } $2 != "" { printf " (%s)", substr($2, 1, 7) }')
  id=${1#sha256:}
  echo "${v:-$(echo "$id" | cut -c 1-12)}"
}

running=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.oneoff=False \
  --format '{{.Label "com.docker.compose.service"}}' | sort -u | grep -vx "$SELF_SVC" || true)
svcs= # 正在跑、image 是 LABDECK 的服務
for s in $running; do
  case $(dc config --images "$s") in "$IMAGES"*) svcs="$svcs $s" ;; esac
done
[ -n "$svcs" ] || { log "沒有要更新的服務（正在跑的服務都不是 ${IMAGES}*）"; exit 0; }

# shellcheck disable=SC2086
dc pull -q --ignore-pull-failures $svcs

plan=$STATE/plan # 每行：服務 image 名稱 舊 ID 新 ID
: >"$plan"
changed=
for s in $svcs; do
  ref=$(dc config --images "$s")
  old=$(docker inspect -f '{{.Image}}' "$(cid "$s")")
  new=$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null) || continue
  [ "$new" != "$old" ] || continue
  if grep -qx "$new" "$STATE/bad"; then
    docker tag "$old" "$ref" # 讓手動的 docker compose up -d 也不會用到壞掉的版本
    log "略過 $s 的 $(ver "$new")：之前更新失敗並已回復，等更新的版本"
    continue
  fi
  echo "$s $ref $old $new" >>"$plan"
  changed="$changed $s"
done
[ -n "$changed" ] || { log "已是最新（${svcs# }）"; exit 0; }

# 全部新容器 running、沒有重啟過、有 healthcheck 的是 healthy，web 有在跑時 CHECK_URL 回 2xx
healthy() {
  for s in $changed; do
    c=$(cid "$s")
    [ -n "$c" ] || return 1
    case $(docker inspect -f '{{.State.Status}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c") in
      "running 0 " | "running 0 healthy") ;;
      *) return 1 ;;
    esac
  done
  [ -z "$CHECK_URL" ] || [ -z "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter label=com.docker.compose.service=web --filter label=com.docker.compose.oneoff=False)" ] \
    || wget -q -T 5 -O /dev/null "$CHECK_URL" 2>/dev/null
}
# 健康檢查沒過時的狀況（寫進 log）
describe() {
  for s in $changed; do
    log "$s：$(docker inspect -f '{{.State.Status}}，重啟 {{.RestartCount}} 次{{if .State.Health}}，{{.State.Health.Status}}{{end}}' "$(cid "$s")")"
  done
  [ -z "$CHECK_URL" ] || log "$CHECK_URL：$(wget -q -T 5 -O /dev/null "$CHECK_URL" 2>&1 && echo OK)"
}
# 連續兩次（間隔 10 秒）健康才算成功，抓得到啟動後幾秒才掛掉的版本
wait_healthy() {
  end=$(($(date +%s) + TIMEOUT))
  while [ "$(date +%s)" -lt "$end" ]; do
    if healthy; then
      sleep 10
      if healthy; then return 0; fi
    fi
    sleep 3
  done
  return 1
}
versions() { while read -r s _ _ n; do printf '%s %s、' "$s" "$(ver "$n")"; done <"$plan" | sed 's/、$//'; }

log "更新：$(versions)"
# shellcheck disable=SC2086
dc up -d --no-deps --pull never $changed

migrated=
for s in $changed; do
  if docker logs "$(cid "$s")" 2>&1 | grep -q "$MIGRATION_MARK"; then migrated="$migrated $s"; fi
done

if wait_healthy; then
  msg="更新完成：$(versions)"
  [ -z "$migrated" ] || msg="$msg。DB 已遷移，遷移前的備份在 portal_data 的 /data/backup/pre-migrate-*.db"
  notify "$msg"
  while read -r _ _ o _; do docker image rm "$o" >/dev/null 2>&1 || true; done <"$plan" # 換下來的舊 image
  exit 0
fi

failed=$(versions)
describe
while read -r _ _ _ n; do echo "$n" >>"$STATE/bad"; done <"$plan"
if [ -n "$migrated" ]; then
  # 舊版看到新的表結構會拒絕啟動（它要刪掉新欄位），所以不自動回復
  notify "更新失敗：$failed 在 ${TIMEOUT}s 內沒有通過健康檢查。${migrated# } 已遷移 DB，舊版無法使用新的 DB，因此**沒有自動回復**。
請手動處理（docs/deploy.md「自動更新（CD）」）：看 docker compose logs$migrated；要退回舊版需先還原 /data/backup/pre-migrate-*.db。"
  exit 1
fi

while read -r _ r o _; do docker tag "$o" "$r"; done <"$plan"
# shellcheck disable=SC2086
dc up -d --no-deps --pull never $changed
if wait_healthy; then
  notify "更新失敗，已回復舊版：$failed 在 ${TIMEOUT}s 內沒有通過健康檢查。這個版本不再重試，等下一個新版本。"
else
  notify "更新失敗，回復舊版後仍不健康：$failed。請手動處理：docker compose ps、docker compose logs$changed"
fi
exit 1
