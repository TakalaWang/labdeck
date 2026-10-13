# 部署手冊

Caddy（唯一對外，80/443）處理 TLS 與安全標頭，全部轉給 portal（`web`，Next.js：網頁 + JSON API）。
Prometheus 以 HTTPS + basic auth 抓各主機 node_exporter，告警經 Alertmanager 送 Discord；`runner` 執行 portal 排入的 ansible job。
容器路徑、機密檔與設定變數見 [design.md](design.md) 約定 A、B。以下指令皆在監控主機的部署目錄（放 `compose.yaml` 的目錄）執行；
`docker compose run --rm cli …` 的工作目錄是 image 內的 `ansible/`。監控主機上只需要 Docker，其他工具都在 image 裡（見 [docker.md](docker.md)）。

## P0 安裝（一次性）

監控主機上只需要四樣東西：`compose.yaml`、`deploy/`（Caddy、Prometheus、Alertmanager 設定）、`.env`、`secrets/`。
web、runner、caddy 三個 image 由 GitHub Actions 建好放在 GHCR（`ghcr.io/<owner>/labdeck-{web,runner,caddy}`），不需要 clone repo 或在主機上建置。

1. **監控主機**：Linux + Docker Engine + compose v2。必須連得到各主機的 SSH（22）與 node_exporter（9100）。設好 DNS 名稱（= `SITE_ADDRESS`）。
2. **下載設定檔**（`<owner>` 換成 GitHub 帳號，`V` 換成要安裝的版本，見 GitHub 的 Releases／tags）：
   ```sh
   mkdir labdeck && cd labdeck
   V=1.0.0
   curl -fsSL "https://github.com/<owner>/labdeck/archive/refs/tags/v$V.tar.gz" \
     | tar xz --strip-components=1 --wildcards '*/compose.yaml' '*/deploy' '*/.env.example'
   ```
   （也可以直接 `git clone`；只用到這幾個檔案。）
3. **OAuth app**：到身分提供者註冊 app（例如 NYCU：https://id.nycu.edu.tw/apply/app ），
   redirect URI 填 `${PUBLIC_URL}/auth/callback`。其他提供者需支援 authorization code flow，
   token endpoint 接受 `client_secret_post`，profile endpoint 以 Bearer token 回傳 JSON；欄位名稱用 `OAUTH_ID_FIELD`、`OAUTH_EMAIL_FIELD` 指定。
4. **`.env`**：`cp .env.example .env && chmod 600 .env`，填入所有欄位（`SESSION_SECRET` 的產生方式寫在檔內），
   `LABDECK_VERSION` 設成第 2 步的版本（固定版本，升級時才改；`latest` 是最新的正式版，`main` 是 main 分支最新的 build）。
   image 不在 `ghcr.io/takalawang` 時改 `LABDECK_IMAGE_PREFIX`。
5. **`secrets/`**：先 `docker compose pull` 下載 image，再在 runner image 內一次產生全部檔案（SSH key、node_exporter 憑證與密碼、vault），owner 也一併設好
   （runner、cli 是 uid 1000；`node_exporter_password`、`discord_webhook` 給 prometheus／alertmanager 的 nobody，65534）：
   ```sh
   docker compose run --rm --no-deps --user 0:0 -v "$PWD/secrets:/secrets" \
     -e DISCORD_WEBHOOK='https://discord.com/api/webhooks/…' runner labdeck-init-secrets /secrets
   ```
   （在 repo checkout 內等同 `scripts/init-secrets.sh`。）各檔案的內容見 design.md 約定 A；要沿用既有的檔案（例如舊的 SSH key）時，產生後再替換。
   `vault_bot_become_password` 已隨機產生，各主機 bot 帳號的 sudo 密碼由它與主機名稱導出（design.md 約定 F）。要修改 vault：
   ```sh
   docker compose run --rm -v "$PWD/secrets:/w" cli ansible-vault edit /w/vault.yml    # 容器內的 vi
   ```
   Linux 上 `secrets/` 屬於 uid 1000，主機上的一般使用者讀不到；要看內容就用 `sudo` 或像上面一樣經容器操作。
6. **啟動**：`docker compose up -d`，再 `docker compose ps` 確認全部 running。
   runner image 內是 ansible 12（ansible-core 2.19），這是最後一版支援 Python 3.8 目標主機（Ubuntu 20.04）的 core。
7. **第一位管理員**：`docker compose exec web labdeck add-admin <sso_id> <linux_username>`，
   `<sso_id>` 是身分提供者的 ID（`OAUTH_ID_FIELD` 的值）。之後用該帳號登入。

**從原始碼建置**（不用 GHCR 的 image）：clone repo，在 `.env` 設 `LABDECK_IMAGE_PREFIX=labdeck`、`LABDECK_VERSION=local`，
以 `docker compose build` 取代第 5 步的 `docker compose pull`（之後升級是 `git pull && docker compose build && docker compose up -d`）。
建置時需要連得到 Docker Hub、npm、PyPI 與 crates.io（runner image 內的 labdeck-agent 以 Rust 編譯；執行時不需要 crates.io）。

## 升級

```sh
# .env 的 LABDECK_VERSION 改成新版本（用 latest 或 main 時不用改）
docker compose pull && docker compose up -d
docker image prune -f        # 刪掉舊版 image
```

DB 結構在啟動時就地遷移。新版有改 `compose.yaml` 或 `deploy/` 時（release notes 會寫），先下載到別的目錄比對，再把差異套進來
（`deploy/` 內可能有你自己改過的告警規則與路由，不要直接覆蓋）：

```sh
mkdir -p /tmp/labdeck-new
curl -fsSL "https://github.com/<owner>/labdeck/archive/refs/tags/v$V.tar.gz" \
  | tar xz -C /tmp/labdeck-new --strip-components=1 --wildcards '*/compose.yaml' '*/deploy' '*/.env.example'
diff -ru . /tmp/labdeck-new
```

退回舊版：`LABDECK_VERSION` 改回舊版本後同樣 `docker compose pull && docker compose up -d`。新版可能已遷移 DB，升級前先手動備份一份（見「備份」）。

### 從自行建置改為預先建好的 image

之前在 repo checkout 內 `docker compose up -d --build` 部署的主機：`git pull` 後在 `.env` 加上 `LABDECK_IMAGE_PREFIX`、`LABDECK_VERSION`
（見 `.env.example`），再 `docker compose pull && docker compose up -d`。volume、`.env` 與 `secrets/` 都不變。
runner 與 cli 不再掛載 repo：playbook 改為建置進 runner image（`/repo/ansible`），改 playbook 要重建 image。
確認無誤後可刪掉舊的 `labdeck-web:local`、`labdeck-runner:local`、`labdeck-caddy:local`。

## 從 lab-dashboard 升級

最簡單的方式是在監控主機上以 root 執行搬遷腳本（只需要 Docker 與 curl；不啟動 runner，舊 volume 保留可回復）：

```sh
curl -fsSL https://raw.githubusercontent.com/TakalaWang/labdeck/main/scripts/migrate-from-lab-dashboard.sh | sh -s -- /舊的/repo 目錄 /opt/labdeck
```

它會下載 `compose.yaml` 與 `deploy/`、複製舊的 `.env` 與 `secrets/`、拉 image、線上備份資料庫、把 `lab-dashboard_*` volume
複製成 `labdeck_*` 並啟動（不含 runner），最後替監控主機自己放行 node_exporter。確認網站正常後再 `docker compose up -d runner`。
以下是腳本做的事的手動版本：

專案改名為 LabDeck：compose 專案名稱由 `lab-dashboard` 改為 `labdeck`，named volume 因此變成 `labdeck_*`（舊的是 `lab-dashboard_*`），
image 改為 `labdeck-api:local`、`labdeck-web:local`；目錄也重新整理（`apps/`、`ansible/`、`deploy/`），但 `.env` 與 `secrets/` 仍在 repo 根目錄、不用改。
直接 `docker compose up` 會得到一組空的 volume（新的 DB、沒有歷史資料），請先把舊 volume 複製過去：

```sh
docker compose -p lab-dashboard down          # 停掉舊專案（不要加 -v）
git pull                                      # 取得新版
docker compose up --no-start                  # 建立 labdeck_* volume 與容器，先不啟動（自行建置時加 --build）
for v in portal_data prom_sd prometheus_data alertmanager_data caddy_data; do
  docker run --rm -v "lab-dashboard_$v":/from:ro -v "labdeck_$v":/to alpine sh -c 'cp -a /from/. /to/'
done
docker compose up -d
```

確認無誤（登入、主機與帳號都在、圖表有歷史資料）後，再刪除舊的 volume 與 image：
`docker volume rm lab-dashboard_portal_data lab-dashboard_prom_sd lab-dashboard_prometheus_data lab-dashboard_alertmanager_data lab-dashboard_caddy_data lab-dashboard_caddy_config`、
`docker image rm lab-portal:local lab-caddy:local`。監控主機本身也被監控時，compose 網段可能改變，依下節第 5 步重新放行（網路名稱改為 `labdeck_lab`）。

### 主機端收集程式改為 labdeck-agent

主機上的收集腳本（`gpu.sh`、`procs.py`、`du.sh`、`smartmon.py`、`collect_host.py`）已換成單一執行檔 labdeck-agent（Rust，`crates/agent/`），
指標與 collect JSON 的格式不變。`docker compose build` 會一併建置它（需要連得到 crates.io）。更新 image 後對所有已安裝監控的主機重跑
「安裝監控」：會裝上 `/usr/local/lib/labdeck/labdeck-agent`、改寫 systemd unit 並重啟，舊的 `/usr/local/lib/lab-textfile/` 會被刪除。
「收集資料」會自己安裝（或更新）同一個執行檔，不需另外處理。

### 後端改為 TypeScript（Next.js + runner）

FastAPI 後端、Vite SPA 與 `ansible/inventory/portal.py` 已換成 TypeScript：`web` 是 Next.js（網頁與 JSON API 同一個服務），
`runner` 是 Node 程式（同一個 image 內仍是 ansible 12）。API、資料庫（同一份 `schema.sql`，啟動時就地遷移）、`.env` 與 `secrets/` 都不變，
直接 `git pull && docker compose up -d --build` 即可。注意：
- image 改為 `labdeck-web:local`（Next.js）、`labdeck-runner:local`（runner 與 cli）、`labdeck-caddy:local`；確認無誤後可 `docker image rm labdeck-api:local`。
- session cookie 的格式改變，所有人需要重新登入一次（行事曆訂閱網址不受影響，仍由 `SESSION_SECRET` 導出）。
- Ansible inventory：runner 執行前寫出 `/data/inventory.json`；cli 的 `ANSIBLE_INVENTORY` 是直接讀 DB 的動態 inventory（`labdeck-inventory`），網頁新增的主機立刻可以 bootstrap。
- 第一位管理員的指令改為 `docker compose exec web labdeck add-admin <sso_id> <linux_username>`。

## 只限校內／VPN 存取（建議）

網頁直接開在監控主機的 443，防火牆只放校內與 VPN 網段；網域放在 Cloudflare 時，用 DNS-01 拿正式憑證，不必對外開任何 port。
1. Cloudflare DNS：加一筆 A 紀錄 `dashboard.example.org` → 監控主機 IP，**DNS only（灰色雲朵）**，不要 proxy。
2. Cloudflare → My Profile → API Tokens → Create Token → 範本「Edit zone DNS」，Zone Resources 只選這個網域。
3. `.env`：`SITE_ADDRESS=dashboard.example.org`、`PUBLIC_URL=https://dashboard.example.org`、`CADDY_TLS=cloudflare`、
   `CLOUDFLARE_API_TOKEN=<token>`。`docker compose up -d caddy`，`docker compose logs caddy` 看到 `certificate obtained successfully`。
4. 防火牆（Docker 發布的 port 會繞過 ufw 的 INPUT 規則，所以要寫在 `DOCKER-USER` 鏈；或像下面讓 caddy 只綁內部可達的位址再用 ufw）：
   ```sh
   # 只允許校內與 VPN 網段連 80/443（範例網段，換成實際的校內／VPN 網段；VPN 用戶的來源位址可從 caddy 存取紀錄確認）
   for net in 198.51.100.0/24 203.0.113.0/24; do
     sudo iptables -I DOCKER-USER -p tcp -m multiport --dports 80,443 -s "$net" -j RETURN
   done
   sudo iptables -A DOCKER-USER -p tcp -m multiport --dports 80,443 -j DROP
   sudo apt install iptables-persistent && sudo netfilter-persistent save
   ```
   HTTP-01（`CADDY_TLS=public`）在這種設定下拿不到憑證，因為 Let's Encrypt 從外網連不進來。
5. 監控主機本身也被監控時：Prometheus 從容器連本機 node_exporter，來源是 compose 網段而不是校內 IP，要另外放行：
   `sudo ufw allow from $(docker network inspect labdeck_lab -f '{{(index .IPAM.Config 0).Subnet}}') to any port 9100 proto tcp`（port 依 `NODE_EXPORTER_PORT`）。

## Cloudflare Tunnel（選填，取代對外開 80/443）

監控主機在 NAT 後面或不想開連入 port 時，用 Cloudflare Tunnel 對外；憑證由 Cloudflare 處理。
1. Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel（Cloudflared），複製 token（只顯示這一次，當密碼保管）。
2. 該 tunnel 的 Public Hostname：例如 `dashboard.example.org` → Service `HTTP` `caddy:80`。
3. `.env`：`TUNNEL_TOKEN=<token>`、`SITE_ADDRESS=:80`（Caddy 只在容器網路內提供 http）、`PUBLIC_URL=https://dashboard.example.org`；
   OAuth 與 Discord 的 redirect URI 改成新的 `PUBLIC_URL`。
4. `compose.override.yaml` 拿掉 caddy 的對外 port：
   ```yaml
   services:
     caddy:
       ports: !reset []
   ```
5. `docker compose --profile tunnel up -d`。

注意：經 tunnel 的網址全網際網路都連得到，所有資料都靠 portal 的登入保護。若要限制只有學校信箱能打開頁面，
可再加 Cloudflare Access（Zero Trust → Access → Applications，政策 `Emails ending in @example.edu`；免費方案 50 人）。

## 個人通知（選填）

成員可在「我的帳號」自行開啟帳號到期、主機維護的個人通知（預設全部關閉）。沒設定的管道不會出現在網頁上。

**Discord**（在實驗室頻道 @提及 本人；私訊需要 bot，刻意不做）：
1. https://discord.com/developers/applications → New Application（名稱例如 `LabDeck`）。
2. OAuth2 頁面：複製 Client ID、Reset Secret 取得 Client Secret；Redirects 加上 `${PUBLIC_URL}/auth/discord/callback`（須完全相同）。
   不需要 Bot、不需要任何權限，portal 只要求 scope `identify`（讀使用者 ID 與名稱）。
3. `.env` 填 `DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`（`DISCORD_WEBHOOK_URL` 需已設定：通知發在這個 webhook 的頻道，
   成員必須在該 Discord 伺服器且看得到該頻道才會收到提及），`docker compose up -d`。

**Email**（stdlib smtplib，預設 587 + STARTTLS）：
- Gmail／Google Workspace：該帳號開啟兩步驟驗證 → https://myaccount.google.com/apppasswords 建立「應用程式密碼」（16 碼）。
  `.env`：`SMTP_HOST=smtp.gmail.com`、`SMTP_PORT=587`、`SMTP_USER=<帳號>`、`SMTP_PASSWORD=<應用程式密碼>`、`SMTP_FROM=<同一帳號或其別名>`。
  Workspace 若停用應用程式密碼，改用 SMTP relay（`smtp-relay.gmail.com`，在管理控制台允許監控主機的 IP）。
- 學校郵件伺服器：依其說明填 `SMTP_HOST`／`SMTP_PORT`；465 port 加 `SMTP_SECURITY=ssl`。
- 改完 `docker compose up -d`。寄送失敗會在 `docker compose logs runner` 看到 `notification #… failed: <錯誤類型> <代碼>`（不含密碼）；
  `535` = 帳密錯誤。`SMTP_PASSWORD` 與其他 `.env` 內容一樣只放在 `.env`（chmod 600）。

## 新增主機

1. 網頁「主機管理」（`/admin/hosts`）新增主機（或貼上 CSV：`name,address,group`）。
2. 在監控主機上建立 bot 帳號（`BOT_USER`），並把主機的 SSH host key 寫入 `/data/known_hosts`：
   ```sh
   docker compose run --rm cli ansible-playbook playbooks/bootstrap_bot.yaml -l <name> -u <既有管理帳號> \
     --ask-pass --ask-become-pass -e @/run/secrets/vault.yml -e monitoring_host_ip=<監控主機 IP>
   ```
   `monitoring_host_ip` 是主機看到的來源 IP 或 CIDR（bot 的 key 只接受從這裡登入）。
   `-l` 可以是多台或群組（例如 `-l gpu` 或 `-l all`）；管理帳號密碼相同時一次輸入即可。
   **各主機管理帳號密碼不同時**，改用一份加密的密碼表，一次跑完全部主機（表中必須列出每台目標主機）：
   ```sh
   docker compose run --rm -v "$PWD/secrets:/w" cli ansible-vault create /w/bootstrap_passwords.yml   # 容器內的 vi，填入：
   #   bootstrap_passwords:
   #     gpu01: !unsafe 'gpu01 的密碼'
   #     gpu02: !unsafe 'gpu02 的密碼'
   docker compose run --rm cli ansible-playbook playbooks/bootstrap_bot.yaml -l all -u <既有管理帳號> \
     -e @/run/secrets/bootstrap_passwords.yml -e @/run/secrets/vault.yml -e monitoring_host_ip=<監控主機 IP>
   docker compose run --rm -v "$PWD/secrets:/w" cli rm /w/bootstrap_passwords.yml   # 只有 bootstrap 用得到，用完即刪
   ```
   （`!unsafe` 讓含 `{{` 等字元的密碼不被 Ansible 當成樣板。）
   host key 是首次使用即信任（`ssh-keyscan`）；在意的話事後比對 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`。
   主機重灌後重跑同一個指令即可（會更新 host key 並重建 bot 帳號）。
   從 bot 共用同一個 sudo 密碼的舊版升級上來時，每台既有主機都要重跑一次這個指令（改成各主機自己的密碼），否則 runner 的 job 會 sudo 失敗。
3. portal 上按「安裝監控」（`agents` job）→ 成功後自動列入 Prometheus（runner 數秒內更新 `targets.json`）。
4. 按「收集資料」（`collect` job），或等每晚 03:00 自動收集。

主機防火牆需放行監控主機連 22；有啟用 ufw 的主機，「安裝監控」會自動只對 `MONITORING_SOURCE` 開放 node_exporter 的 port（其他防火牆請手動開）。改了 `DATA_MOUNT_GLOB` 後要對所有主機重跑「安裝監控」（du 的 systemd unit 用到它）。

## P1 監控檢查

1. 抓取狀態（應全部 `up`）：
   ```sh
   docker compose exec runner python3 -c 'import json, urllib.request as u; [print(t["labels"]["instance"], t["health"], t["lastError"]) for t in json.load(u.urlopen("http://prometheus:9090/api/v1/targets"))["data"]["activeTargets"]]'
   ```
2. 登入 portal：主機列表應顯示各主機的 CPU／RAM 使用率，主機頁有圖表，GPU 看板列出各張卡。
3. 確認 Discord 收得到告警：暫時停掉某台主機的 node_exporter 5 分鐘，應收到 `HostDown` 與解除通知。
4. 臨時查詢（PromQL）：Prometheus **不對外開 port**，從自己的電腦開 SSH tunnel 到監控主機的 prometheus 容器：
   ```sh
   # 在監控主機上查 prometheus 容器的 IP
   docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(docker compose ps -q prometheus)"
   # 在自己的電腦上
   ssh -N -L 9090:<容器 IP>:9090 <監控主機>
   ```
   再開 http://localhost:9090 。容器重建後 IP 可能改變，需重查。

## 既有帳號匯入

- 第一次 collect 後，各主機的既有帳號會出現在「未認領」，請逐筆認領到人（同名不一定同一人，**不要依名稱批次處理**）；
  UID 不一致的帳號只能人工處理，系統不會重新編號。
- 請成員先登入一次 portal，網管再把其 SSO ID 連到對應的人；新成員走線上申請 → 網管核准。
- 新建帳號會設臨時密碼並強制首次登入改密碼：成員需先用終端機 `ssh` 互動登入改密碼，
  在那之前 VS Code Remote-SSH、scp 等非互動連線即使用 key 也會失敗。

## 備份

- runner 每天 04:00 後把 SQLite 備份到 volume 內 `/data/backup/portal-YYYYMMDD.db`（保留 14 份；0600，不含臨時密碼）。
  **這個 volume 和 portal 在同一顆碟上**，請用 cron 複製到別台機器：
  ```cron
  30 5 * * *  cd /path/to/labdeck && docker compose cp web:/data/backup/. /srv/labdeck-backup/ && rsync -a /srv/labdeck-backup/ backup-host:labdeck/
  ```
- 立即備份一份：
  `docker compose exec runner sqlite3 /data/portal.db ".backup /data/backup/manual.db"`
- 還原：`docker compose stop web runner`，把備份檔 `docker compose cp` 回 `web:/data/portal.db`，再 `docker compose start web runner`。
- `.env` 與 `secrets/` 不在 git 裡，請另外離線備份；遺失 `secrets/ssh_key` 或 vault 需對所有主機重跑 bootstrap。
- 不需備份：Prometheus 歷史（400 天，遺失只影響圖表與月報）。
  `caddy_data` 內有 internal CA，刪掉會讓使用者重新看到憑證警告。

## 疑難排解

- `kex_exchange_identification: read: Connection reset by peer`：主機 sshd 的 MaxStartups 擋掉並行連線。
  `ansible/ansible.cfg` 已設 `forks=3`，手動執行時不要加大 `-f`。
- 手動以 bot 身分跑 playbook（除錯用）：
  ```sh
  docker compose run --rm cli ansible-playbook playbooks/collect.yaml -l <name> -u labbot --private-key /run/secrets/ssh_key \
    -e @/run/secrets/vault.yml -e "ansible_become_password={{ (vault_bot_become_password ~ inventory_hostname) | hash('sha256') }}" \
    -e collect_dir=/tmp/collect
  ```
- 某台 `HostDown`：`lastError` 是 timeout → 主機關機、防火牆沒放行監控主機到 9100，或網路邊界整個擋掉 9100（常見於校園網路：`nc -z` 逾時而其他 port 立即被拒）→ 在 `.env` 改 `NODE_EXPORTER_PORT` 後重跑「安裝監控」；
  `x509` → 主機上的憑證與 `secrets/node_exporter.crt` 不一致，重跑「安裝監控」；
  `401` → `secrets/node_exporter_password` 與 vault 裡的 bcrypt hash 不一致。
- `Host key verification failed`／`REMOTE HOST IDENTIFICATION HAS CHANGED`：主機重灌或換了 IP，重跑新增主機的第 2 步。
- 網頁圖表顯示無法取得監控資料（API 回 502）：`docker compose ps prometheus` 確認在跑；web 以 `PROMETHEUS_URL`（預設 `http://prometheus:9090`）連線。
- 改設定後：`deploy/prometheus/` 的 `rules.yml`／`prometheus.yml` → `docker compose kill -s HUP prometheus`；
  `deploy/alertmanager/alertmanager.yml`／`deploy/Caddyfile` → `docker compose restart alertmanager`／`caddy`；`.env` → `docker compose up -d`。
  改 rules 前先跑測試：`docker run --rm -v "$PWD/deploy/prometheus":/w -w /w --entrypoint promtool prom/prometheus:v3.15.0 test rules rules_test.yml`
- 刻意拔掉 GPU 或卸載資料碟後，`GpuMissing`／`MountMissing` 會持續 7 天，請 silence：
  `docker compose exec alertmanager amtool --alertmanager.url=http://localhost:9093 silence add alertname=GpuMissing instance=gpu01 -d 7d -a <你> -c '原因'`
- 所有主機都升到 Ubuntu 22.04 以上之後，才能把 image 的 ansible 升到 ansible-core 2.20+（不再支援 Python 3.8 目標主機）。
- ponytail: GPU 月報由 web 以一個月長的 1m subquery 即時計算；若查詢逾時，改成 recording rule 預先算每分鐘的 `count by (instance, uuid, user)`。

## 測試

在 repo checkout 內執行，全部在容器內跑（主機只需要 Docker），細節見 [docker.md](docker.md)：

- `./labdeck test`：vitest（packages/core、web 的 API、runner）、`cargo test`（主機端收集程式 labdeck-agent）、Prometheus 規則測試。
- `./labdeck lint`：型別檢查、eslint、`next build`、cargo fmt／clippy、playbook syntax-check、Alertmanager 設定檢查。
- 只改了監控主機上的 `deploy/prometheus/rules.yml` 時，在部署目錄也能直接測：
  `docker run --rm -v "$PWD/deploy/prometheus":/w -w /w --entrypoint promtool prom/prometheus:v3.15.0 test rules rules_test.yml`
- 端對端：`./labdeck e2e`（= `e2e/run.sh`；需 Docker 可跑 privileged 容器，約 5–10 分鐘）。它把 repo 複製到 `e2e/.work/app`、
  產生測試用 `secrets/` 與 `.env`，以 `compose.yaml` + `e2e/compose.e2e.yaml` 起整套服務，另加假 OAuth provider（`e2e/mock_oauth.py`，
  兼當假 Discord（OAuth 與 webhook 收件端）與 SMTP 收件端，內容可由 `http://localhost:9999/_sink` 讀取）與一台假的 Ubuntu 20.04 主機 `gpu01`（`e2e/target/`，systemd + sshd），
  再在 Playwright 容器內跑 `e2e/tests/`。網頁在 http://localhost:8080 （需空出 8080、9999 port）。`KEEP=1` 跑完不拆環境、`SKIP_BUILD=1` 不重建 image；
  各服務的 log 在 `e2e/.work/logs/`，Playwright 報告在 `e2e/playwright-report/index.html`。
  除了下載 image 與 npm 套件，測試不連外部服務，也不碰任何真實主機。
