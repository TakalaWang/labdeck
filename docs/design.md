# 設計與介面約定

實驗室 GPU 主機的監控與帳號管理系統。**repo 內不含任何站點資料**（主機、IP、帳號、密碼）：
主機在網頁上新增，其餘設定走 `.env` 與 `secrets/`。本檔是各部件之間的介面約定，改介面時同步更新本檔。

範例一律使用中性名稱（`gpu01`）與文件專用 IP（RFC 5737：`192.0.2.0/24`、`198.51.100.0/24`）。

## 架構

```
監控主機（docker compose）
  caddy ── 唯一對外（80/443）：TLS 與安全標頭，全部轉給 web
  web      Next.js（TypeScript）：網頁 + JSON API（身分、主機清冊、帳號、申請、稽核、排程、代理 Prometheus 的固定查詢）
  runner   TypeScript 常駐服務（另一個 image，含 Ansible）；唯一持有 SSH key / vault，依 allowlist 跑 ansible-playbook
  cli      與 runner 同 image，profile "cli"：網管手動跑 playbook（例如 bootstrap 新主機）
  prometheus ← file_sd（runner 依 DB 產生）→ 各主機 node_exporter（HTTPS + basic auth）
  alertmanager → Discord
各主機：node_exporter + labdeck-agent（Rust 靜態執行檔：textfile metrics 與 collect JSON，見約定 D、E）
```

主機清冊的唯一來源是 portal 的 SQLite（`hosts` 表）。runner 依它寫出 Ansible inventory（`/data/inventory.json`，約定 C）。
前後端之間的 JSON API 見 [api.md](api.md)。

## 目錄

```
compose.yaml  .env.example  .gitignore  LICENSE  README.md  package.json（npm workspaces）  vitest.config.ts
compose.dev.yaml  dev/        開發環境與 toolbox image（docs/docker.md）；labdeck：開發／測試／部署的指令捷徑
packages/core/                 共用 TypeScript：設定、SQLite（schema.sql、就地遷移）、驗證、job allowlist、通知佇列、Prometheus 固定查詢；guide.md、CLI
apps/web/                      Next.js（App Router）：網頁 + JSON API（src/server）；Dockerfile → `labdeck-web`（standalone）
apps/runner/                   runner（TypeScript）；Dockerfile → `labdeck-runner`（Node 24 + Ansible + playbook + labdeck-agent），runner 與 cli 共用
ansible/ansible.cfg  ansible/vault.yml.example
ansible/playbooks/{bootstrap_bot,monitoring_agents,collect,users}.yaml
crates/agent/                  labdeck-agent（Rust）：主機端收集程式（textfile metrics、collect JSON）與其測試
deploy/Caddyfile  deploy/caddy.Dockerfile（`labdeck-caddy`）  deploy/caddy-tls/{local,cloudflare,public}
deploy/prometheus/{prometheus.yml,rules.yml,rules_test.yml}  deploy/alertmanager/alertmanager.yml
scripts/init-secrets.sh        產生 secrets/（在 runner image 內執行，image 內為 labdeck-init-secrets）
e2e/                           端對端測試：假 OAuth、假 GPU 主機（systemd + sshd）、Playwright（容器內）；e2e/run.sh
docs/{design.md,api.md,deploy.md,admin-guide.md}
secrets/                       (gitignored) 部署機密，見下
```

## 約定 A：容器內路徑與機密

| 路徑 | 內容 | 掛載 |
|---|---|---|
| `/repo/ansible` | `ansible/`（playbook、`ansible.cfg`；cli 的工作目錄） | 建置進 runner image（runner、cli）；開發環境（compose.dev.yaml）從工作目錄掛入 |
| `/data` | `portal.db`、`inventory.json`、`collect/`、`jobs/`、`backup/`、`known_hosts`（舊版的 `bmc/` 不再使用，可刪除） | named volume `portal_data`（web、runner、cli；容器內皆 uid 1000） |
| `/prom_sd/targets.json` | Prometheus file_sd，由 runner 產生（`PROM_SD_DIR`） | named volume `prom_sd`：runner rw 掛 `/prom_sd`（不放在 `/data` 裡：巢狀 volume 首次啟動會競爭）；prometheus ro 掛 `/etc/prometheus/sd` |
| `/run/secrets` | 整個 `./secrets` 目錄 | runner、cli（ro） |
| `/app` | web：Next.js standalone 與 `packages/core`；runner：`apps/runner`、`packages/core` 與 node_modules | 建置進 image，不掛載 |

`./secrets/` 內容（全部 gitignored，由部署者產生）：
`ssh_key`、`ssh_key.pub`（bot 的 SSH key）、`vault_pass`、`vault.yml`（ansible-vault 加密）、
`node_exporter.crt`（公開憑證）、`node_exporter_password`（prometheus 用明文）、`discord_webhook`。
prometheus 另外單檔掛 `node_exporter.crt`、`node_exporter_password`；alertmanager 單檔掛 `discord_webhook`。
權限（`scripts/init-secrets.sh` 產生時即如此）：目錄 0700、檔案 0600，只有公開的 `ssh_key.pub`、`node_exporter.crt` 為 0644；
目錄與檔案 owner 1000（runner、cli），`node_exporter_password`、`discord_webhook` 給 65534（prometheus、alertmanager）；
`labdeck-init-secrets` 以 root 執行時（deploy.md P0 第 5 步）直接設好。

`vault.yml` 變數：`vault_bot_become_password`、
`vault_node_exporter_basic_auth_bcrypt`、`vault_node_exporter_tls_key`。

runner 與 cli 的共同環境變數（compose 設定）：
`ANSIBLE_CONFIG=/repo/ansible/ansible.cfg`、`ANSIBLE_INVENTORY=/usr/local/bin/labdeck-inventory`、
`ANSIBLE_VAULT_PASSWORD_FILE=/run/secrets/vault_pass`、
`ANSIBLE_SSH_ARGS=-o UserKnownHostsFile=/data/known_hosts -o StrictHostKeyChecking=yes -o ControlMaster=auto -o ControlPersist=30m -o ServerAliveInterval=30`（每台主機整個 job 只開一條 SSH 連線，避免被防火牆／`MaxStartups` 限流）。
image 需含 `sshpass`（bootstrap 時以 `--ask-pass` 登入既有管理帳號）。
image 內的 `/opt/labdeck/bin/labdeck-agent` 是 `apps/runner/Dockerfile` 的 build stage（`agent-build`） 從 `crates/agent` 建置的 x86_64 靜態執行檔
（`x86_64-unknown-linux-musl`，Rust 版本固定在 `crates/agent/rust-toolchain.toml` 與 Dockerfile）；crate 以 named build context `agent`
傳入（compose 的 `additional_contexts`；直接 `docker build` 時加 `--build-context agent=crates/agent`）。
playbook 從這裡複製到主機（可用 `-e labdeck_agent_src=<路徑>` 改來源）。

## 約定 B：設定（`.env`，括號內為預設值）

| 變數 | 用途 |
|---|---|
| `LABDECK_IMAGE_PREFIX`（`ghcr.io/takalawang/labdeck`）、`LABDECK_VERSION`（`latest`） | compose 的 image：`<PREFIX>-{web,runner,caddy}:<VERSION>`；自行建置用 `labdeck`、`local` |
| `PUBLIC_URL`、`SITE_ADDRESS` | portal 對外網址、Caddy site address |
| `SITE_NAME`（`LabDeck`） | 頁面標題 |
| `TZ`（`UTC`；範例檔填 `Asia/Taipei`） | 容器時區（排程、顯示） |
| `SESSION_SECRET` | 簽 session cookie 與行事曆 token，必填、至少 32 字元：`NODE_ENV=production`（web、runner image）未設定或太短即拒絕啟動；只有開發／測試才以每次啟動隨機產生的值代替 |
| `DISCORD_WEBHOOK_URL` | |
| `PROMETHEUS_URL`（`http://prometheus:9090`） | web 查詢 Prometheus 的位址（compose 內部網路） |
| `OAUTH_NAME`（`NYCU`） | 登入按鈕與 UI 上的身分名稱，如「NYCU ID」 |
| `OAUTH_CLIENT_ID`、`OAUTH_CLIENT_SECRET` | |
| `OAUTH_AUTHORIZE_URL`（`https://id.nycu.edu.tw/o/authorize/`） | |
| `OAUTH_TOKEN_URL`（`https://id.nycu.edu.tw/o/token/`，client_secret_post） | |
| `OAUTH_PROFILE_URL`（`https://id.nycu.edu.tw/api/profile/`，Bearer） | |
| `OAUTH_SCOPE`（`profile`）、`OAUTH_ID_FIELD`（`username`）、`OAUTH_EMAIL_FIELD`（`email`） | profile JSON 的欄位名稱 |
| `BOT_USER`（`labbot`） | runner 登入主機用的帳號 |
| `RESERVED_USERS`（空） | 額外保留帳號，逗號分隔（例如各主機的共用管理帳號）；`root` 與 `BOT_USER` 一律保留 |
| `UID_MIN`、`UID_MAX`（`20000`、`29999`） | 新帳號 UID 分配區段 |
| `DATA_MOUNT_GLOB`（`/data*`） | 主機上的資料碟掛載點 glob（collect 的 mounts、du 每週掃描的根目錄） |
| `MONITORING_SOURCE`（空） | 監控主機的來源 IP/CIDR：安裝監控時在啟用 ufw 的主機上只對它開放 node_exporter 的 port（†`monitoring_source`）；bootstrap 的 bot key `from=` 預設值 |
| `NODE_EXPORTER_PORT`（`9100`） | 各主機 node_exporter 的 port（agents job 的 †欄位 `node_exporter_port`、Prometheus 抓取目標） |
| `DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`（空 = 不提供 Discord 個人通知） | Discord OAuth2 app（scope `identify`，redirect URI `${PUBLIC_URL}/auth/discord/callback`）；通知以 `<@id>` 發在 `DISCORD_WEBHOOK_URL`，不需 bot token |
| `DISCORD_AUTHORIZE_URL`（`https://discord.com/oauth2/authorize`）、`DISCORD_TOKEN_URL`（`https://discord.com/api/oauth2/token`）、`DISCORD_PROFILE_URL`（`https://discord.com/api/users/@me`） | 測試時指到假 Discord |
| `SMTP_HOST`（空 = 不提供 Email 通知）、`SMTP_PORT`（`587`）、`SMTP_SECURITY`（`starttls`；`ssl` = 465 implicit TLS；`none` 只給本機 relay／測試，不可與 `SMTP_USER` 並用） | 個人通知的寄信伺服器（runner 以 nodemailer 寄出，逾時 20 秒，驗證憑證；`starttls` 為必要 STARTTLS） |
| `SMTP_USER`、`SMTP_PASSWORD`、`SMTP_FROM`（預設 = `SMTP_USER`） | SMTP 登入（密碼不寫入 log）與寄件者 |

## 約定 C：hosts 表與 Ansible inventory

`hosts(name PK, address, group_name, bmc_address NULL, bmc_status NULL, bmc_power NULL, bmc_checked_at NULL, bmc_note NULL,
       console NULL, boot_risk INTEGER DEFAULT 0, ssh_no_retry INTEGER DEFAULT 0, monitored INTEGER DEFAULT 0, no_shutdown INTEGER DEFAULT 0,
       room, rack, psu, notes, facts_json, facts_at, created_at)`
- **遠端電源控制（IPMI）與排程關機已移除**：`bmc_address`、`bmc_status`、`bmc_power`、`bmc_checked_at`、`bmc_note`、`console`、`boot_risk`、
  `no_shutdown` 欄位留在表裡（就地遷移不刪欄位），web、runner 都不再讀寫；新增的主機這些欄位為 NULL／0。
- `name`：`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`；`address`：IPv4、IPv6 或 DNS 名稱（嚴格驗證，不可含空白或逗號）。
- `group_name`：`^[A-Za-z][A-Za-z0-9_]{0,31}$`，不可為 `all`、`ungrouped`、`no_shutdown`。
- `monitored`：是否列入 Prometheus 抓取目標。
- `ssh_no_retry`：這台會封鎖頻繁開新 SSH 連線的來源 IP；設定時 inventory 給 hostvar `ansible_ssh_retries: 0`，蓋掉 `ansible/ansible.cfg` 的 `[connection] retries`。
- 既有 DB 由 `initDb`（`packages/core`；web、runner 啟動時）就地遷移：欄位定義與 `schema.sql` 不同的表（只差空白、註解不算）會重建並複製
  所有欄位（只適用加欄位、放寬 CHECK）。重建前先 `VACUUM INTO /data/backup/pre-migrate-<UTC 時間>.db`（0600，不輪替，確認無誤後手動刪除）；
  若重建會丟掉舊表有、`schema.sql` 沒有的欄位，直接拒絕啟動並列出表與欄位（需另寫遷移）；COMMIT 前跑 `PRAGMA foreign_key_check`，有違反就整批 rollback。

runner 每輪（≤ 5 s）與每次執行 playbook 前依 DB 寫出 `/data/inventory.json`（`INVENTORY_PATH`；0600，內容有變才以 rename 原子寫入），
是 Ansible YAML inventory 格式的 JSON，runner 以 `-i` 傳入。cli 的 `ANSIBLE_INVENTORY` 則是 `labdeck-inventory`（`apps/runner/src/inventory.ts`）：每次直接讀 DB、輸出同樣主機與 hostvars 的 script inventory，所以網頁剛新增的主機就能 bootstrap（寫檔有延遲時，`-l <新主機>` 會因為沒有符合的主機而什麼都不做卻回報成功）：
```json
{"all": {"children": {"gpu": {"hosts": {"gpu01": {"ansible_host": "192.0.2.11"}}}}}}
```
`ansible_ssh_retries: 0` 僅在 `ssh_no_retry` 時出現。inventory **不設** `ansible_user`（runner 用 `-e ansible_user=$BOT_USER`，手動時用 `-u`）。

runner 每輪（≤ 5 s）依 DB 產生 `/prom_sd/targets.json`（只含 `monitored=1`，內容有變才以 rename 原子寫入）：
```json
[{"targets": ["192.0.2.11:9100"], "labels": {"instance": "gpu01", "group": "gpu"}}]
```

## 約定 D：textfile metrics（主機端產生 → Prometheus 使用）

textfile 目錄 `/var/lib/node_exporter/textfile/`。主機上的收集程式是 `/usr/local/lib/labdeck/labdeck-agent`（0755，monitoring_agents.yaml
以 copy 安裝，checksum 不同才傳送，更新時重啟 lab units；舊版的 `/usr/local/lib/lab-textfile/` 腳本會被刪除），由 systemd unit／timer 執行
`labdeck-agent textfile <gpu|procs|du|smart> --dir <textfile 目錄>`，一律寫暫存檔（`<檔名>.tmp`）再 rename。
外部指令（`nvidia-smi`、`smartctl`、`du`、`stat`、`ps`、`lspci`）照舊以子程序呼叫，`/proc` 直接讀。staleness 用 `node_textfile_mtime_seconds{file=...}`。

`gpu.prom`（`textfile gpu`，lab-gpu.service，每 15 s）：`lab_gpu_info{gpu,uuid,name}`、`lab_gpu_utilization_percent{gpu,uuid}`、
`lab_gpu_memory_used_bytes`、`lab_gpu_memory_total_bytes`、`lab_gpu_temperature_celsius`、`lab_gpu_power_watts`、
`lab_gpu_process_memory_bytes{gpu,uuid,user,pid,comm}`、`lab_gpu_pci_count`、`lab_gpu_smi_count`、`lab_nvidia_smi_ok`。
`procs.prom`（`textfile procs`，lab-procs.service，每 30 s 取樣 5 s）：`lab_user_cpu_cores{user}`（取樣期間的平均核心數）、
`lab_user_memory_bytes{user}`（RSS 加總）、`lab_user_processes{user}`；以 effective UID 歸戶，UID < 1000 合為 `user="system"`，root 另列為 `root`。
`du_home.prom`（`textfile du /home du_home.prom`，每晚）／`du_data.prom`（`textfile du <DATA_MOUNT_GLOB> du_data.prom`，每週；glob 依 shell 規則展開）：`lab_user_disk_bytes{root,path,owner}`、`lab_du_success_timestamp_seconds{root}`。
`smart.prom`（`textfile smart`，每小時）：`lab_smart_healthy{device,model,serial}`、`lab_smart_temperature_celsius{device}`、
`lab_smart_reallocated_sectors`、`lab_smart_pending_sectors`、`lab_smart_nvme_percentage_used`、`lab_smart_nvme_media_errors`。

node_exporter：`https` + basic auth（使用者 `prometheus`），憑證 SAN = `node-exporter`，Prometheus 以
`tls_config: {ca_file: /etc/node_exporter/tls.crt, server_name: node-exporter}` 驗證。

記憶體告警 `MemoryLow`、`SwapHeavy`、`OOMKill` 的說明以 `topk(1, lab_user_memory_bytes{instance=…})` 附上該主機記憶體用量最多的使用者。

告警 `DiskWillFill`：實體檔案系統依過去 6 小時的 `predict_linear` 3 天內會寫滿，且剩餘不到 20%，持續 1 小時（warning）。

告警 `MountMissing` 為通用規則：某台主機的實體檔案系統數量低於 7 天內最大值（含降到 0）即觸發，不綁定任何路徑。

## 約定 E：collect JSON（主機端產生 → portal 匯入）

`collect.yaml` vars：`collect_dir`（必填）、`target_hosts`（預設 `all`）、`data_mount_glob`（預設 `/data*`）。
collect.yaml 先把 labdeck-agent 裝到 `/usr/local/lib/labdeck/labdeck-agent`（同約定 D；沒裝監控的主機也一樣），再以
`labdeck-agent facts <inventory_hostname> <data_mount_glob>` 印出一份 JSON，寫到 `{{ collect_dir }}/<host>.json`：
```json
{"host": "gpu01", "collected_at": 1790000000,
 "facts": {"os": "Ubuntu 22.04.4 LTS", "kernel": "5.15.0-105-generic", "cpu_model": "…", "cpu_count": 64, "mem_mb": 257587,
           "nvidia_driver": "535.183.01", "cuda": "12.2", "gpu_pci_count": 8,
           "gpus": [{"index": 0, "name": "NVIDIA GeForce RTX 3090", "uuid": "GPU-…", "memory_mb": 24576}],
           "disks": [{"name": "sda", "size_bytes": 4000787030016, "model": "…", "serial": "…", "rota": true}],
           "mounts": [{"mountpoint": "/data0", "size_bytes": 0, "used_bytes": 0}],
           "uptime_s": 1052311, "apt_update_at": 1790000000, "apt_check_ok": true,
           "reboot_required": false, "reboot_pkgs": []},
 "accounts": [{"username": "alice", "uid": 1001, "home": "/home/alice", "shell": "/bin/bash",
               "last_login": 1790000000, "home_mtime": 1790000000, "locked": false, "expires": "2027-07-31"}],
 "logins": [{"username": "alice", "src": "198.51.100.7", "ts": 1790000000}]}
```
- `accounts` 只含 UID 1000–65533；讀不到帳號清單（`getent passwd` 失敗）時為 `null`，portal 保留原有帳號資料不做比對
  （`[]` 則表示主機上真的沒有這些帳號）。指令輸出不是 UTF-8 的位元組以 U+FFFD 取代，不會讓整個探測失敗。
- `expires`：最後一天可登入的日期 = shadow `sp_expire`（第一個拒絕登入的日子）的前一天；沒有到期日為 `null`。
- `locked`：密碼欄 `!` 開頭且其後不是空字串或 `*`（`usermod -L` 鎖住的真密碼）**或**已到期（UTC 的今天 ≥ `sp_expire`，與 PAM 相同）；
  `!`、`!*`、`*` 本身是僅 key 帳號，不算鎖定。
- `mounts`：`/`、`/home` 與符合 `data_mount_glob` 的掛載點；網路檔案系統（`nfs*`、`cifs`、`smb3`、`fuse.*`）照列但不做 statvfs
  （伺服器沒回應會卡住），`size_bytes`／`used_bytes` 為 `null`。`logins` 來自 wtmp（`last -Fiw`），只留有來源 IP 的。
- 主機健康（`/api/admin/health`）用的欄位，讀不到時為 `null`（`reboot_pkgs` 為 `[]`）；舊版腳本收集的 facts 沒有這些 key，portal 顯示「尚無資料」：
  - `apt_update_at`：最後一次**成功** `apt update` 的時間 = `/var/lib/apt/periodic/update-success-stamp`（update-notifier-common 的
    `APT::Update::Post-Invoke-Success` hook，只有 `apt update` 結束碼為 0 才 touch）與 `update-stamp`（apt.systemd.daily 每日更新成功後 touch）
    兩者較新的 mtime；都沒有為 `null`。**不在收集時跑 `apt-get update`**（要連網、可能數分鐘、會搶 dpkg lock）：
    有任何來源失敗（金鑰過期、套件庫不存在、連不到）時 `apt update` 結束碼非 0，stamp 就停在壞掉前，所以
    「以收集時間計，stamp 已超過 3 天」即代表每日更新一直失敗（portal：> 3 天 warn、> 14 天 bad）。
  - `apt_check_ok`：`apt-get -o Debug::NoLocking=1 -qq check` 成功與否（本機、不連網、不拿 lock）；`false` = 相依損壞或 dpkg 中斷；沒有 apt-get 為 `null`。
  - `reboot_required`：`/var/run/reboot-required` 是否存在；`reboot_pkgs`：`/var/run/reboot-required.pkgs` 的套件（去重、保留順序）。
  - `uptime_s`：`/proc/uptime` 的秒數（取整）。
- collect.yaml 的收集 task 每台限 600 秒。

## 約定 F：runner 執行的 job

```
ansible-playbook -i /data/inventory.json /repo/ansible/<playbook> \
  --private-key /home/app/.ssh/id_ed25519 --vault-password-file /run/secrets/vault_pass \
  -e @/run/secrets/vault.yml -e ansible_user=$BOT_USER \
  -e "ansible_become_password={{ (vault_bot_become_password ~ inventory_hostname) | hash('sha256') }}" \
  -e @/data/jobs/<id>.yml   [--check --diff]
```
ansible-playbook 的環境變數採 allowlist（`playbookEnv`）：只有 `PATH`、`HOME`、`TZ`、`LANG`、`LC_*`、`ANSIBLE_*`、`PYTHONUNBUFFERED`、
`PYTHONDONTWRITEBYTECODE` 與 playbook 以 `lookup('env', …)` 讀的 `BOT_USER`、`MONITORING_SOURCE`、`KNOWN_HOSTS`，另加 runner 設定的 `DATA_DIR`；
`SESSION_SECRET`、`OAUTH_*`、`DISCORD_*`、`SMTP_*` 等 `.env` 內容不會傳給 playbook。playbook 新增 `lookup('env', …)` 時要同步加進 allowlist。
bot 的 sudo 密碼每台不同：`sha256(vault_bot_become_password + inventory_hostname)`（bootstrap_bot.yaml 以同一式子設定），
一台主機的 root 拿不到其他主機的 bot 密碼。
`target_hosts` 一律是逗號分隔的 inventory hostname 字串，playbook 以 `hosts: "{{ target_hosts }}"` 使用。
job 檔 0600、跑完即刪；內容是 JSON 前面加一個 YAML tag：`!unsafe {…}`，整份（含巢狀）字串 Ansible 都不會當 template
（不逐一標在字串上：Ansible 會重新推斷被標 `!unsafe` 純量的型別，`"2027-07-31"` 會變成日期）。
另外 `validateJob`（packages/core）拒絕任何含 `{` 或 `}` 的字串（含 dict key），在網頁排入時與 runner 執行前各檢查一次。
**標 †的欄位由 runner 依設定注入，不接受網頁輸入。**

| kind | playbook | job 檔 |
|---|---|---|
| `collect` | collect.yaml | `{collect_dir: "/data/collect", target_hosts: "all"\|"a,b", data_mount_glob†}` |
| `agents` | monitoring_agents.yaml | `{target_hosts, data_mount_glob†, node_exporter_port†}`；成功後把這些主機設 `monitored=1` |
| `users` | users.yaml | `{target_hosts, accounts: {host: [entry…]}, only_user?, temp_password?, reserved_users†, keys_only†}`，先 `--check --diff` 由網管確認；只含金鑰變更者自動確認（`keys_only: true`）；網管指派主機時每台一個自動確認的單帳號 job（`only_user`） |

預覽（`--check --diff`）的 rc 為 0 或 2（某台主機的 task 失敗，仍有輸出可讀）才進入 `awaiting`；其他 rc（4 無法連線、1／3／5 等錯誤）
沒有產生預覽，job 標為 `check_failed`（預檢失敗，`finished_at` 設定、不能確認），網管頻道 `[預檢失敗] <描述>（#id）：<原因>`。
失敗的 job（`failed`、`check_failed`）可由網管「重新執行」（api.md `/rerun`）：依目前 DB 重建、重新檢查後排入新的 job，舊 job 不變。
網管頻道的 job 通知以 `describeJob`（packages/core/src/jobs.ts）的白話描述命名，失敗附 `failureSummary` 的原因。

已移除的 kind `power`（ipmi_power.yaml）、`shutdown`（shutdown.yaml）、`bmc_check`（ipmi_status.yaml）：`jobs.kind` 的 CHECK 仍允許，
舊紀錄照常顯示在工作紀錄；`validateJob` 拒絕排入，runner 遇到（例如舊的排程關機到期）直接標為失敗「已停用的工作類型」，不執行任何 playbook。
runner image 不再安裝 pyghmi。

帳號與身分（schema.sql）：`accounts.primary_user`（受管帳號：這台主機的主要使用者，只做顯示）；`accounts.desired` 另有 `absent`
（網管要求刪除，`remove_home` 是否連家目錄；沒有人認領的舊帳號被刪除時成為 `person_id` 為 NULL 的受管列）。
`requests.kind`：`account` = SSO 身分的**登記**（`name`、希望的 `username`、需求）、`hosts` = 既有成員申請其他主機；`requests.decision_note` = 退回原因；兩者都只填需求
（`reason` 用途、`gpus`、`min_vram_gb`、`expected_end` 預計使用到），不選主機。**沒有自行認領**：SSO 身分一律由網管在待指派連結到既有人員
或建立新人員（api.md「登記與待指派」）。`assignments`：網管指派的每一個 (人員, 主機) 與它的 `only_user` job（`request_id` 為 NULL = 快速指派）。
既有 DB 由 `initDb` 就地遷移：`requests` 加欄位、`accounts` 放寬 CHECK 並加 `remove_home`，舊資料（含待審的舊帳號申請，可照樣在待指派處理）保留。開通主機時（`grant`）若人員沒有 `people.uid` 但已有受管帳號（認領來、各主機 UID 不同），新帳號另以
`allocUid` 分配一個全實驗室 UID 並存入 `people.uid`，之後開通的主機都沿用；既有帳號的 UID 永不更動。

個人通知（api.md「個人通知」）：`people.discord_id`、`discord_name`、`notify_email`、`notify_prefs`，待驗證的地址在 `email_verifications`，
待送的通知在 `outbox`。web 與排程只寫 `outbox`；runner 另一個非同步迴圈（自己的 DB 連線）每 5 秒送出，長 job 不會延誤通知，SMTP 卡住也不影響 job。
維護公告（有 `hosts`）的 24 小時前提醒以 `announcements.reminded_at` 記錄已處理。

排程（runner，每日一次、可重入）：03:00 `collect`（監控中的主機）、04:00 後備份 DB
（`/data/backup/portal-YYYYMMDD.db`，0600，`people.temp_password` 清成 NULL）。

`finish` 只更新 `status='running'` 的 job；取消 job 以條件式 `UPDATE … WHERE status IN ('queued','awaiting','confirmed')`。

管理員：`people.role` 只能經 `POST /api/admin/people/{id}/promote` 由 `member` 升為 `admin`（網頁、API 都沒有降級）；
降級只能在伺服器上執行 `labdeck demote-admin <帳號>`（`packages/core/src/cli.ts`，web 與 runner image 都有；不會降級最後一位啟用中的管理員）。

`users` entry：`{username, uid, state: present|locked, expires: "YYYY-MM-DD"|null, keys_add: [...], keys_remove: [...]}`。
`expires` 是最後一天可登入的日期（= `people.expires_at`）。
users.yaml 語意（playbook 自己強制）：
- assert username 合 `^[a-z_][a-z0-9_-]{0,31}\Z`、不在 `reserved_users`（永遠含 `root`；未提供時預設 `[root, labbot]`）、state 合法、uid ≥ 1000。
- 已存在的帳號：若給 uid 則 assert 相符，**不傳 uid/group/home**，也不重建已不在的家目錄（`create_home: false`）。
  不存在且 present：必須有 uid 才建立（`chage -d 0` 搭配臨時密碼）。不存在且 locked：略過。
- absent（只會出現在網管排入、預覽確認過的 job；`keys_only` 時略過）：帳號存在且 UID 相符才 `userdel`（仍有程序在跑會失敗）；
  `remove_home: true` 時一併刪除家目錄與 mail spool，但先檢查家目錄是 `<某目錄>/<帳號名稱>`（至少兩層）、不是 symlink、owner 是該 UID，
  否則整個 job 失敗、什麼都不刪。帳號不存在則略過。entry 只有 absent 帶 `remove_home`（`validateJob` 檢查），且不帶到期日與 key。
- present：shadow 到期日設為 `expires` 的**隔天**（`sp_expire` 是第一個拒絕登入的日子，以 UTC 日計），即可用到 `expires` 當天結束；
  `null` → `-1`（不到期）。只有密碼欄 `^!\$` 才解鎖。locked：`password_lock: true` + `expires: 86400`（`sp_expire` = 1，`chage -l` 顯示
  Jan 02, 1970）。除了 absent 之外不刪帳號或家目錄；不用 `authorized_key exclusive`、不管理 groups。
- SSH key 的新增／移除以該帳號本人身分執行（`become_user`，需 `pipelining`）：`authorized_key` 會跟隨 symlink，以 root 執行時
  `~/.ssh/authorized_keys → /etc/shadow` 會被 chown 給使用者、內容出現在 `--diff`。
- `keys_only: true`（runner 只為自動確認、沒人預覽過的 job 注入）：若有帳號需要建立則 assert 失敗；略過建立、更新到期日、解鎖、鎖定，
  只對已存在的帳號新增／移除 key。
- `only_user: <username>`（網管指派「一個人、一台主機」時，由 `enqueueHostAccount` 排入、`auto_confirm`，並寫一筆 `assignments`）：
  `validateJob` 要求 `target_hosts` 只有一台、該台的 entry 恰好一筆且就是這個帳號、`state: present`；runner 只在 job 為
  `auto_confirm`、且有 `assignments` 列指向此 job、主機相同、人員帳號名稱等於 `only_user` 且人員仍為 `active` 時執行，否則標為失敗
  （「沒有對應的管理員指派紀錄」）；不預覽、不注入 `keys_only`，可建立帳號（單人建立照常設定臨時密碼；同一人指派多台時，在本人按「我已記下」之前
  各台沿用同一個臨時密碼）。臨時密碼產生時 `people.temp_password_pending=1`，建立此人帳號（或此人的指派 job）**成功**後才清為 0，
  `/api/me` 只在 0 時回傳密碼，直到本人 ack 刪除（GET 不會清除）。users.yaml 也只取 `accounts[host]` 中 `username == only_user` 的那筆並 assert 一台一筆，
  所以這台主機上其他人（或此人其他主機）待同步的變更不會被套用。
- 確認預覽（`POST /api/admin/jobs/{id}/confirm`）時與 runner 套用前，依目前 DB 重建同一批 (host, username) 的 entry（含 key），
  與 job 內容不同即不套用：確認回 `409` 並取消 job，runner 則標為失敗（「狀態已變更，請重新同步後再確認」）。

## 約定 G：Caddy ↔ web（Next.js）

- 所有路徑 → `reverse_proxy web:3000`（`encode zstd gzip`）。web 是一個 Next.js standalone server：
  - `/api/*`、`/login`、`/auth/*`：route handler，全部交給同一個 dispatcher（`apps/web/src/server`），所以不存在的路徑與方法一律回
    API 自己的 JSON `404`／`405`，CSRF 檢查、session cookie 與安全標頭（`Cache-Control: no-store`、`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`）也只有一套。
  - 其餘路徑是網頁（App Router 的 client page，與原本的 SPA 一樣在瀏覽器繪製、以 TanStack Query 讀 `/api/*`）；`/_next/static/*`
    檔名含 hash，Next.js 自己送 `Cache-Control: public, max-age=31536000, immutable`。
- Caddy 在回應加上 HSTS、`X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`，並在回應**沒有** CSP 時補上
  `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`。
  網頁的 CSP 由 web（`apps/web/src/proxy.ts`）每次請求產生：同一套政策，`script-src` 另加 `'nonce-…' 'strict-dynamic'`
  （Next.js 的啟動 script 是 inline，靠 nonce 放行；它再載入的 chunk 由 `strict-dynamic` 放行）。因此網頁仍不可有自己的 inline script、
  外部 CDN（字型、script）；登入須是整頁導向（`<a href="/login?next=…">` 或 `location.assign`），
  不可用 `<form>` 送到 `/login`（Chromium 的 `form-action` 會擋掉轉到 OAuth provider 的 redirect）。
- session：signed cookie `portal_session`（HMAC-SHA256 以 `SESSION_SECRET` 簽章、7 天、`HttpOnly; Secure; SameSite=Lax`），內容只有
  `sso_id`、`email`、`person_id`、`csrf` 與 OAuth `state`，沒有任何機密。
- Prometheus、Alertmanager 不對外；網頁的圖表只經 web 的 `/api/metrics/*`（固定查詢，見 api.md）。

## 約定 H：網頁導覽與網址

側欄分兩組，每一項是一個頁面；頁面內的分頁以 `?tab=<id>` 表示（可直接連結、重新整理後保留；`components/route-tabs.tsx`），
分頁自己的參數（篩選、月份、頁碼…）放在同一個網址，切換分頁時丟掉。

| 側欄 | 網址 | 分頁 |
|---|---|---|
| 首頁 | `/` | 總覽、最新公告、我的狀態 |
| 主機 | `/hosts`、`/hosts/{name}` | 主機頁：`overview` 概況（含管理員的健康檢查與主機設定）／`gpu`／`users` 使用者／`disk` 磁碟 |
| 使用量 | `/usage` | `gpu` GPU 即時（預設）／`cpu` CPU·記憶體／`disk` 磁碟／`monthly` 月報 |
| 公告與維護 | `/announcements` | `list` 公告（公開）／`calendar` 維護日曆（成員） |
| 我的帳號 | `/me` | （新成員指南 `/guide` 從這裡與使用者選單連過去） |
| 待指派（管理） | `/admin/requests` | （側欄顯示待處理筆數；管理員首頁有「待指派 N 筆」卡片） |
| 人員與帳號（管理） | `/admin/people`、`/admin/people/{id}` | `people` 人員／`accounts` 主機帳號（子分類 `?view=all\|drift\|uid\|idle\|unmanaged\|suggest`） |
| 主機管理（管理） | `/admin/hosts` | `hosts` 主機／`health` 健康 |
| 維運（管理） | `/admin/ops`、`/admin/jobs/{id}` | `jobs` 工作／`announcements` 公告管理／`guide` 指南編輯／`audit` 稽核紀錄 |

尚未成為成員的 SSO 身分只看到首頁、公告與維護、登記、新成員指南。舊網址由 `apps/web/src/proxy.ts` 以 307 轉到新位置（原有參數保留）：
`/gpus`→`/usage?tab=gpu`、`/disk`→`?tab=disk`、`/reports/gpu-monthly`→`/usage?tab=monthly`、
`/calendar`→`/announcements?tab=calendar`、`/health`→`/admin/hosts?tab=health`、`/admin/accounts?tab=X`→`/admin/people?tab=accounts&view=X`、
`/admin/jobs`、`/admin/announcements`、`/admin/guide`、`/admin/audit`→`/admin/ops?tab=…`、`/admin/power`→`/admin/hosts`。
通知裡的連結（`/admin/jobs/{id}`、`/announcements`、`/me`、`/request`、`/admin/requests`）不受影響。

## 已知的安全取捨

- 登記不檢查帳號名稱是否重複（只檢查格式），所以登記者無法藉此列舉帳號；名稱衝突由網管在指派時處理（建立新帳號遇到同名 `409`，
  同一人改用連結既有帳號）。登記者看不到任何人員或帳號清單；SSO 身分與人員的對應只能由網管建立（`sso_link`、`person_create` 稽核）。

## 新增主機流程（portal 顯示給網管）

1. 主機管理（`/admin/hosts`）新增主機（或貼上 CSV：`name,address,group`）。
2. 在監控主機上：`docker compose run --rm cli ansible-playbook playbooks/bootstrap_bot.yaml -l <name> -u <既有管理帳號> --ask-pass --ask-become-pass -e @/run/secrets/vault.yml -e monitoring_host_ip=<監控主機 IP>`（建立 bot 帳號、寫入 `/data/known_hosts`）。
3. portal 上按「安裝監控」（`agents` job）→ 成功後自動列入 Prometheus。
4. 按「收集資料」（`collect` job）或等每晚 03:00 自動收集。
