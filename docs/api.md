# Portal JSON API 約定

網頁（`apps/web/src/views`，瀏覽器端）與 JSON API（`apps/web/src/server`，Next.js route handler）之間的唯一介面。改介面時同步更新本檔。

## 通則

- 同源部署：Caddy 把所有路徑轉給 web（Next.js）；`/api/*`、`/login`、`/auth/*` 是 API 與登入導向，其餘是網頁。不存在的 `/api/*` 路徑回 `404`、不支援的方法回 `405`（JSON）；`HEAD` 不等同 `GET`，一律 `405`（有些 GET 會消耗一次性狀態，如 OAuth state）。
- 身分用 session cookie（`portal_session`，Secure、HttpOnly、SameSite=Lax）。
- **所有會改變狀態的請求**（POST/PUT/DELETE）必須帶 header `X-CSRF-Token: <GET /api/session 回傳的 csrf>`，且 `Origin` 必須等於 `PUBLIC_URL` 的 origin；否則 `403`。
- 請求與回應都是 JSON（`Content-Type: application/json`），CSV 端點除外。
- 錯誤：`{"error": "給使用者看的繁中訊息"}`，狀態碼 `400` 驗證失敗（含超出範圍的數字）、`401` 未登入、`403` 權限不足或 CSRF、`404` 不存在、`409` 衝突（例如同名帳號需先認領，或與同時進行的操作搶到同一筆資料）、`429` 太頻繁（重寄驗證碼、Email 達每小時上限）、`502` Prometheus 無法連線（僅 `/api/metrics/*` 與 `/api/me/usage`）。
- 時間：時間點一律 ISO 8601 含時區（`2026-09-27T01:45:00+08:00`）；日期為 `YYYY-MM-DD`。沒有值時為 `null`。
- 權限：`public` 不需登入；`identity` 需 SSO 登入（可以還不是成員）；`member` 需 `people.status='active'` 且未過 `expires_at`（到期日當天仍可用；過期後 `403`，`/api/session` 仍回傳 `user`）；`admin` 需是 member 且 `role='admin'`。
- 標 `(admin)` 的欄位只在呼叫者是 admin 時出現。

## 認證（瀏覽器導向，非 JSON）

| 方法 | 路徑 | 權限 | 說明 |
|---|---|---|---|
| GET | `/login?next=/path` | public | 302 到 OAuth provider；`next` 僅接受站內相對路徑 |
| GET | `/auth/callback` | public | 完成登入後 302 到 `next` 或 `/`；失敗時 302 到 `/?login_error=oauth`（OAuth／profile 失敗）或 `/?login_error=identity`（身分欄位無效），首頁顯示繁中訊息（不回 JSON） |
| POST | `/api/logout` | identity | 清除 session，回 `{}` |

## Session / 首頁

`GET /api/session`（public）
```json
{"site": {"name": "LabDeck", "oauth_name": "NYCU"},
 "csrf": "…",
 "user": {"id": 1, "username": "alice", "name": "Alice", "email": "…", "sso_id": "…", "role": "admin", "status": "active", "expires_at": "2028-07-31"},
 "identity": {"sso_id": "…", "email": "…"}}
```
`user` 未登入或尚非成員時為 `null`；`identity` 為 SSO 身分（已登入即有）。

`GET /api/summary`（member）
```json
{"hosts_total": 29, "hosts_up": 28, "gpus_total": 144, "gpus_idle": 37,
 "announcements": [Announcement…], "metrics_ok": true}
```
`hosts_up` = 監控中且 `up` 的主機數。`gpus_total`／`gpus_idle` 同一來源：Prometheus 正常時都取自 GPU 看板
（`/api/metrics/gpus` 的卡數與閒置數）；`metrics_ok=false`（Prometheus 無法連線）時 `hosts_up`、`gpus_idle` 為 `null`，
`gpus_total` 改用各主機最後收集到的 GPU 數。

## 公告

`Announcement`：
```json
{"id": 1, "title": "…", "body": "…", "starts_at": "…", "ends_at": "…", "created_by": "alice", "hosts": ["gpu01"]}
```
`hosts`：維護影響的主機（選填，清冊順序；`[]` = 沒有指定），只用於標示（維護日曆、iCal），不會對主機做任何事。
排程關機已移除：舊公告的 `announcements.shutdown_*` 欄位留在 DB 但不再讀取，它們的 `shutdown` job 只留在工作紀錄。

| 方法 | 路徑 | 權限 | body → 回應 |
|---|---|---|---|
| GET | `/api/announcements` | public | → `[Announcement]`（進行中 + 未來的，新到舊） |
| GET | `/api/admin/announcements` | admin | → `[Announcement]`（全部） |
| POST | `/api/admin/announcements` | admin | `{title, body, starts_at, ends_at, hosts?: [name]}` → `Announcement`（`hosts` 有不在清冊的主機 `400`）；帶非 null 的 `shutdown`（已移除的排程關機）`400`「已不支援排程關機」，其他未知欄位忽略；寫稽核 `announce`、通知網管 Discord（`[公告] <標題>`、`時間：MM/DD HH:MM – MM/DD HH:MM`、有主機時 `影響主機：…`、內容）與訂閱維護通知的成員（標題只在主旨／Discord 粗體第一行，內文不重複） |

`/api/admin/announcements/{id}/cancel-shutdown` 已移除（`404`）。

## 新成員指南

Markdown 存在 DB（`pages` 表，key `guide`）；沒有存過時用內建預設（`packages/core/guide.md`）。
替換字只有固定幾個：`{{site_name}}`、`{{oauth_name}}`、`{{public_url}}`（大括號內可有空白），以純字串取代設定值；
其他 `{{…}}` 原樣保留（不是 template engine）。Markdown 由前端以 react-markdown 繪製：不繪製原始 HTML、過濾 `javascript:` 等連結。

| 方法 | 路徑 | 權限 | body → 回應 |
|---|---|---|---|
| GET | `/api/guide` | identity | → `{markdown, members_markdown, updated_at, updated_by, is_default}`（皆已套用替換字；`members_markdown` 只給帳號啟用中的成員，其他人或內容空白時為 `null`） |
| GET | `/api/admin/guide` | admin | → `{source, default, placeholders: {site_name, oauth_name, public_url}, members_source, updated_at, updated_by, is_default}`（`source` 為原文） |
| PUT | `/api/admin/guide` | admin | `{source}` → 同 GET；空白 `400`、超過 50,000 字 `400`；與預設內容相同時刪除 DB 內容（回到預設，之後預設更新會跟著變）；寫稽核 `guide_update`（`{chars, sha256, default}`） |
| PUT | `/api/admin/guide/members` | admin | `{source}` → 同 GET `/api/admin/guide`；成員專區（`pages` key `guide_members`，與公開指南分開存）；空白＝清除；超過 50,000 字 `400`；稽核 `guide_update` 只記 `{chars, sha256}` |

## 維護日曆

`GET /api/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD`（member；預設本月，範圍 0–92 天，否則 `400`）
```json
{"start": "2026-09-27", "end": "2026-11-07", "events": [Announcement…],
 "subscribe_url": "https://portal.example.org/api/calendar.ics?token=3.…"}
```
`events`：顯示期間（`starts_at`–`ends_at`；沒有 `ends_at` 只算開始那一刻）與範圍重疊的公告（含已結束），依開始時間排序。
前端把 `hosts` 非空的公告畫成「維護」。

`GET /api/calendar.ics`（member：session cookie，或 `?token=`）→ `text/calendar`（RFC 5545），供行事曆 App 訂閱。
- 內容：`ends_at`（或開始）在 180 天內之後的公告各一個 VEVENT（`UID:announcement-{id}@<PUBLIC_URL 的主機名>`，有 `hosts` 時標題加 `[維護]`、說明附影響主機，
  `URL` 為 `/announcements?tab=calendar`）。排程關機已移除，不再有 `UID:shutdown-…` 事件（已訂閱的行事曆更新時會移除）。時間一律 UTC（`…Z`）。
- 格式：CRLF 換行、每行最多 75 octets（以 CRLF + 空白續行，不切斷 UTF-8 字元）；TEXT 跳脫 `\\`、`\;`、`\,`，換行為 `\n`，其他控制字元移除。
- `token` = `<person id>.<HMAC-SHA256(SESSION_SECRET, "calendar:<id>") 前 32 碼>`（`subscribe_url` 已帶好）。行事曆 App 不帶 cookie，所以用 token；
  該人員須仍是 member（停用、到期即 `403`），token 錯誤 `403`。更換 `SESSION_SECRET` 會讓所有訂閱網址失效（正式環境必填；開發／測試未設定時每次重啟都會變）。

## 主機

`Host`（列表）：
```json
{"name": "gpu01", "address": "192.0.2.11", "group": "gpu", "ssh_no_retry": false,
 "monitored": true, "room": "…", "rack": "…", "psu": "…", "notes": "…",
 "facts_at": "…", "os": "Ubuntu 22.04.4 LTS", "kernel": "…", "cpu_model": "…", "cpu_count": 64, "mem_gb": 251.5,
 "nvidia_driver": "535.183.01", "cuda": "12.2", "gpu_summary": "8× RTX 3090", "gpu_count": 8, "gpu_pci_count": 8,
 "disk_count": 6, "primary_users": [{"username": "alice", "name": "Alice"}],
 "status": null | {"up": true | false | null, "cpu_pct": 43.1, "mem_pct": 38.0, "root_pct": 71.2, "gpu_util_avg": 55.0,
                   "net_rx_bps": 4830.0, "net_tx_bps": 891.0}}
```
`status` 在未監控或 Prometheus 無法連線時為 `null`；個別數值取不到時為 `null`（`up: null` = 尚未抓取到，不代表離線）。
`gpu_count`、`disk_count` 在從未收集（`facts_at` 為 `null`）時為 `null`（不是 0）。
`ssh_no_retry`：ansible 連線失敗不重試（主機會封鎖頻繁連線的 IP）。
遠端電源控制已移除：`bmc_address`、`ipmi`、`console`、`boot_risk`、`no_shutdown` 不再出現在任何回應（DB 欄位保留、不再讀寫）。

`primary_users`：這台主機的主要使用者（受管帳號、網管標記），依帳號排序；member 也看得到姓名。

`HostDetail` = `Host` 加上：
```json
{"facts": {…collect JSON 的 facts 原樣…},
 "accounts": [{"username": "alice", "uid": 1001, "exists": true, "locked": false, "expires": null,
               "last_active": "…", "managed": true, "desired": "present", "primary": false,
               "person": {"id": 3, "username": "alice", "name": "Alice" (*), "discord_name": "alice_dc" (*)} | null}],
 "bootstrap_command": "docker compose run --rm cli ansible-playbook …" (admin)}
```
`desired`：受管帳號的期望狀態 `present`（開通）｜`locked`（停用）｜`absent`（網管要求刪除；未認領的舊帳號被刪除時也會變成受管、`person: null`）。
`primary`：受管帳號是否為這台主機的主要使用者（未受管的帳號一律 `false`）。(*) `person.name`、`person.discord_name` 只在呼叫者是 admin，
或這一列是主要使用者時出現；其他人員對 member 仍只有 `{id, username}`。

| 方法 | 路徑 | 權限 | body → 回應 |
|---|---|---|---|
| GET | `/api/hosts` | member | → `[Host]` |
| GET | `/api/hosts.csv` | member | → CSV（公式字元跳脫） |
| GET | `/api/hosts/{name}` | member | → `HostDetail` |
| POST | `/api/admin/hosts` | admin | `{name, address, group, ssh_no_retry?, room?, rack?, psu?, notes?}` → `Host`（已移除的 `bmc_*`、`console`、`boot_risk`、`no_shutdown` 忽略） |
| POST | `/api/admin/hosts/import` | admin | `{csv}`（每行 `name,address,group`，其他欄數為該行錯誤）→ `{added: [name], skipped: [{name, reason}], errors: [{line, error}]}`（有任何 error 則全部不匯入） |
| PUT | `/api/admin/hosts/{name}` | admin | 同新增欄位（不含 name）+ `monitored` → `Host` |
| DELETE | `/api/admin/hosts/{name}` | admin | `{confirm: "<name>"}` → `{}`；受管帳號須都已取消開通（`desired=locked`）且在主機上已鎖定或不存在，或已刪除（`desired=absent` 且不存在），否則 `409` 並列出帳號；這些帳號列一併刪除 |
| POST | `/api/admin/hosts/{name}/agents` | admin | → `{job_id}` |
| POST | `/api/admin/hosts/{name}/collect` | admin | → `{job_id}` |
| PUT | `/api/admin/hosts/{name}/accounts/{username}/primary` | admin | `{primary: bool}` → `{primary}`；不是這台主機的受管帳號 `404`；稽核 `primary_set` |
| POST | `/api/admin/hosts/{name}/accounts/{username}/delete` | admin | `{remove_home: bool, confirm?}` → `{job_id}`；**刪除這台主機上的帳號**（受管帳號，或沒有人認領的舊帳號）：`desired='absent'`、排入只含這一筆的 users job，**一律先預覽、由網管確認**（不自動）。`remove_home: true` 時 `confirm` 須等於帳號名稱（`400`）。保留帳號、名稱不合法 `400`；主機上沒有這個帳號 `400`；UID 與紀錄不符 `400`。稽核 `account_delete`。刪除後（收集到帳號已不在）這一列不再出現在同步裡，同名可再開通 |
| PUT | `/api/admin/primary-users` | admin | `{items: [{host, username}]}`（**全部主機**主要使用者的完整集合：列出的設為主要，其他全部清除）→ `{items}`（去重、排序）；任何一筆不是受管帳號則 `400` 並列出、全部不變；稽核 `primary_import`（`{count}`）。供一次性匯入，沒有 UI |

選填欄位省略即清空。`/api/admin/hosts/{name}/bmc-check`、`/api/admin/bmc-check`、`/api/admin/power` 已移除（`404`）。

## 監控資料（後端以固定查詢代理 Prometheus，不接受任意 PromQL）

後端設定 `PROMETHEUS_URL`（預設 `http://prometheus:9090`）。Prometheus 無法連線時回 `502`。

`GET /api/metrics/hosts/{name}?range=1h|6h|24h|7d|30d`（member，預設 `6h`）
```json
{"range": "6h", "step": 60,
 "cpu_pct": [[1790000000, 43.1], …],
 "mem_pct": [[t, v], …],
 "net_rx_bps": {"eth0": [[t, v], …]}, "net_tx_bps": {"eth0": [[t, v], …]},
 "disk_pct": {"/": [[t, v], …], "/data0": […]},
 "gpu_util_pct": {"0": [[t, v], …]}, "gpu_mem_pct": {"0": [[t, v], …]}}
```
時間戳為 epoch 秒（圖表用）；step 依 range：1h→15、6h→60、24h→300、7d→1800、30d→7200。網卡排除 `lo|docker.*|veth.*|br-.*`；檔案系統排除 tmpfs/overlay/squashfs 等。

`GET /api/metrics/gpus`（member）— GPU 即時看板
```json
{"updated_at": "…",
 "hosts": [{"host": "gpu01", "group": "gpu", "up": true | false | null, "nvidia_ok": true | false | null,
            "gpus": [{"index": 0, "uuid": "GPU-…", "name": "NVIDIA GeForce RTX 3090", "util_pct": 97.0,
                      "mem_used_bytes": 2.3e10, "mem_total_bytes": 2.5e10, "temp_c": 71, "power_w": 310.5,
                      "idle": false,
                      "processes": [{"user": "alice", "pid": 1234, "comm": "python", "mem_bytes": 2.2e10}]}]}]}
```
`idle` = 使用率 < 5% 且記憶體用量 < 1 GiB。只列 `monitored` 且有 GPU 的主機：沒有任何 GPU 序列且 `lab_gpu_pci_count` 為 0
（或沒有該序列時，最後收集也沒看到 GPU）的純 CPU 主機不列；lspci 有卡但 nvidia-smi 失敗的列出（`nvidia_ok: false`）。
`up`／`nvidia_ok` 為 `null` = 尚無資料（尚未抓取）。`gpus` 只含有 `lab_gpu_info` 的卡（`name` 一定有值，缺名稱時為 `"未知 GPU"`）；
`index` 取不到時為 `null`。

`GET /api/metrics/users`（member）— 各主機誰在用 CPU、記憶體與 GPU
```json
{"updated_at": "…",
 "hosts": [{"host": "gpu01", "group": "gpu", "up": true | false | null,
            "cpu_count": 64, "cpu_used_cores": 27.5, "mem_total_bytes": 2.7e11, "mem_used_bytes": 1.2e11,
            "users": [{"user": "alice", "cpu_cores": 12.3, "mem_bytes": 1.2e11, "processes": 42,
                       "gpu_count": 2, "gpu_mem_bytes": 4.4e10}]}]}
```
列出所有 `monitored` 主機（含純 CPU 主機，順序同 GPU 看板）。主機欄位取自 node_exporter：`cpu_used_cores` = 最近 2 分鐘忙碌的核心數
（含 kernel 與已結束的程序，不一定等於各使用者加總），`mem_used_bytes` = MemTotal − MemAvailable；取不到時為 `null`。
`users` 取自 labdeck-agent 的 `procs.prom`（每 30 秒取樣 5 秒）：`cpu_cores` 為取樣期間平均使用的核心數，`mem_bytes` 為各程序 RSS 加總
（共用記憶體，例如 fork 出來的 worker，會重複計算，可能高於實際用量），UID < 1000 合為 `system`、`root` 另列；
GPU 欄位以同名使用者合併 `lab_gpu_process_memory_bytes`（`gpu_count` = 不同的卡數）。只在 GPU 上看到的使用者 `cpu_cores`、`mem_bytes`、
`processes` 為 `null`；主機還沒回報（未抓取、離線或監控尚未更新）時 `users` 為 `[]`。
排序：CPU 佔比與記憶體佔比取較大者，由高到低，同分再依 GPU 卡數、名稱。

`GET /api/metrics/hosts/{name}/users`（member）→ 單台主機，同上 `hosts[]` 的一筆（查詢只限這台；找不到主機 `404`）。

`GET /api/metrics/hosts/{name}/gpu-hours`（member）→ `{"days": 30, "users": [{"user": "alice", "gpu_hours": 12.3}]}`
（近 30 天、只限這台主機，算法同 GPU 月報；0 小時的不列，由多到少；找不到主機 `404`）。主機頁「使用者」的 GPU 欄位。

`GET /api/metrics/disk`（member）— 磁碟用量
```json
{"owners": [{"owner": "alice", "bytes": 1.2e12, "paths": 3}],
 "rows": [{"host": "gpu01", "root": "/home", "path": "/home/alice", "owner": "alice", "bytes": 5.1e11}],
 "last_scan": [{"host": "gpu01", "root": "/home", "at": "…"}]}
```

### 歷史圖表（對齊的時間格）

以下端點每組圖表各只打固定幾個 range query（不分主機），在後端依 DB 主機切開；只算 DB 內 `monitored` 的主機（不在 DB 的 instance 忽略）。
序列一律對齊同一組時間格：`start`、`end`（epoch 秒）、`step`，第 i 個值的時間為 `start + i·step`，長度 `(end − start) / step + 1`；
該時間沒有樣本（離線、尚未抓取、NaN）為 `null`（前端畫成斷點，不是 0）。百分比取到小數一位。`range`／`days` 不合法 `400`。

`GET /api/metrics/fleet?range=24h`（member；`range` 同 `/api/metrics/hosts/{name}` 的 1h|6h|24h|7d|30d，step 亦同，預設 `24h`）— 首頁
```json
{"range": "24h", "step": 300, "start": 1790000000, "end": 1790086400,
 "gpus_busy": [97, 98, null, …], "gpus_idle": [37, 36, null, …],
 "groups": [{"group": "gpu", "hosts_total": 5, "hosts_up": 4, "gpu_util": [55.2, …], "cpu_pct": [31.0, …]}]}
```
`gpus_idle` 與看板同一規則（使用率 < 5% 且記憶體用量 < 1 GiB），`gpus_busy` = 有使用率序列的卡數 − 閒置數；該時間沒有任何主機回報時兩者皆 `null`。
`groups`（依名稱排序）：`hosts_total` = DB 內該群組全部主機，`hosts_up` = 目前 `up` 的監控中主機；`gpu_util` = 該群組所有卡的平均使用率，
`cpu_pct` = 忙碌核心數 ÷ 總核心數（依核心數加權）；沒有 GPU 的群組 `gpu_util` 全為 `null`。

`GET /api/metrics/history/gpus?range=1h`（member；`range` 1h|6h|24h → step 60|300|900，預設 `1h`）— GPU 看板每張卡的 sparkline
```json
{"range": "1h", "step": 60, "start": …, "end": …, "hosts": {"gpu01": {"GPU-…": [97.0, null, …]}}}
```
以 `uuid` 對應 `/api/metrics/gpus` 的卡；沒有資料的主機或卡不出現。

`GET /api/metrics/history/hosts?range=6h`（member；`range` 同上，預設 `6h`）— 主機列表每列的 sparkline
```json
{"range": "6h", "step": 300, "start": …, "end": …, "hosts": {"gpu01": {"cpu_pct": [43.1, …], "gpu_util": [55.0, …] | null}}}
```
`gpu_util` = 該主機 GPU 平均使用率，沒有 GPU 序列時為 `null`；完全沒有資料的主機不出現。

`GET /api/metrics/disk/filesystems`（member）— 各主機實體檔案系統（fstype 排除規則同 `/api/metrics/hosts/{name}`）
```json
{"hosts": [{"host": "gpu01", "group": "gpu",
            "filesystems": [{"mountpoint": "/", "device": "/dev/sda1", "size_bytes": 9.4e11, "used_bytes": 5.6e11, "avail_bytes": 3.3e11}]}]}
```
`used_bytes` = size − free（同 `df`；root 保留區塊不算可用，所以 used + avail 可能小於 size）。同一 device 掛在多處（bind mount）只列最短的掛載點。
列出所有監控中主機（順序同 GPU 看板），沒有資料時 `filesystems: []`。

`GET /api/metrics/disk/trend?days=30`（member；`days` 7–90，預設 30）— 各使用者磁碟用量趨勢（前 10 名）
```json
{"days": 30, "step": 86400, "start": …, "end": …, "owners": [{"owner": "alice", "bytes": [1.2e12, null, …]}]}
```
每天一點：各主機 `lab_user_disk_bytes` 2 天內的最後一個值（`last_over_time(…[2d])`，錯過一晚的掃描不會掉成 0）依 owner 加總；
所有主機都沒有值的日子為 `null`（例如第一次掃描之前）。依最新一點由大到小取前 10 名。

`GET /api/metrics/gpu-monthly?month=YYYY-MM`（member，預設上個月）— GPU 使用月報
```json
{"month": "2026-08", "by_user": [{"user": "alice", "gpu_hours": 812.5}],
 "by_host": [{"host": "gpu01", "gpu_hours": 1600.0}],
 "by_user_host": [{"user": "alice", "host": "gpu01", "gpu_hours": 400.0}]}
```
計算：同一使用者在同一張卡上的多個 process 只算一次，每分鐘取樣（`count by (instance, uuid, user)` 的 1m subquery）。
`GET /api/metrics/gpu-monthly.csv?month=` → CSV（user, host, gpu_hours）。

## 我的帳號

`GET /api/me`（member；不改變任何狀態，重新整理看到的內容相同）
```json
{"person": {…同 session.user…},
 "accounts": [{"host": "gpu01", "username": "alice", "uid": 20001, "exists": true, "locked": false,
               "expires": "2028-07-31", "last_active": "…", "desired": "present", "primary": false,
               "address": "192.0.2.11", "job_status": "ok" | null}],
 "keys": [{"id": 1, "fingerprint": "SHA256:…", "type": "ED25519", "comment": "alice@laptop", "state": "active", "added_at": "…"}],
 "temp_password": null | "…", "account_setup": null | "pending" | "failed"}
```
- `address`：主機位址（給本人的 `ssh <username>@<address>` 與 `~/.ssh/config`）；`job_status`：這台主機最新一筆指派工作的狀態（沒被指派過為 `null`）。
- `temp_password`：runner 為建立帳號產生臨時密碼時先標記為未就緒（`people.temp_password_pending`）；**至少一個建立此人帳號的工作成功後**
  才回傳，之後每次 GET 都回傳同一個，直到本人 `POST /api/me/temp-password/ack`（「我已記下」）把它刪除。每日備份一律不含臨時密碼。
- `account_setup`：還沒有可顯示的臨時密碼時，要開通但主機上還不存在的帳號的狀態：有工作進行中（或臨時密碼已產生、工作狀態不明）為 `pending`
  （「帳號建立中，完成後會在這裡顯示臨時密碼」），工作都失敗為 `failed`（「開通失敗，助教已收到通知」）；其餘 `null`。

`GET /api/me/usage`（member）→ `{"gpu_processes": [{"host", "gpu", "pid", "comm", "mem_bytes"}], "cpu_mem": [{"host", "cpu_cores", "mem_bytes", "processes"}], "disk": [{"host", "path", "bytes"}]}`
（以本人在各主機的帳號名稱過濾；`cpu_mem` 同 `/api/metrics/users` 的使用者欄位，只列有程序的主機；Prometheus 無法連線 `502`）

| 方法 | 路徑 | 權限 | body → 回應 |
|---|---|---|---|
| POST | `/api/me/temp-password/ack` | member | → `{}`；刪除臨時密碼（「我已記下」）；稽核 `temp_password_ack` |
| POST | `/api/me/keys` | member | `{pubkey}` → `{key, job_id \| null}`；註解只能是 `[A-Za-z0-9@._+=:-]`、最多 100 字，否則 `400` |
| POST | `/api/me/keys/{id}/revoke` | member | → `{job_id \| null}` |

## 個人通知（選填，預設全部關閉）

兩個管道，各自在設定齊全時才出現（`available`）：**Discord** 需 `DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET` 與 `DISCORD_WEBHOOK_URL`；
**Email** 需 `SMTP_HOST` 與 `SMTP_FROM`（design.md 約定 B）。
- Discord：以 OAuth2 authorization code（scope `identify`）取得使用者 ID，只存 `people.discord_id`、`discord_name`（不存 token）。
  通知發在既有的實驗室頻道 webhook（`DISCORD_WEBHOOK_URL`），內容以 `<@id>` 開頭、`allowed_mentions: {"parse": [], "users": [id]}`
  ——只會提及這個人，公告內容裡的 `@everyone`／角色不會生效。私訊（DM）需要 bot token，刻意不做。
- Email：預設寄到 `people.email`（SSO 提供，視為已驗證）；改用其他地址要先驗證：寄出 6 位數驗證碼（15 分鐘內有效、錯 5 次作廢、
  同一人 60 秒內不可重寄），驗證前仍寄到舊地址。DB 只存驗證碼的 hash，寄出後 outbox 內的信件內容清空。

事件（`events[].key`）：`expiry` 帳號即將到期（到期前 30／7／0 天，與網管頻道的到期提醒同一時機）；
`maintenance` 我有受管帳號（`managed`、`desired=present`）的主機：發布維護公告時、維護開始前 24 小時。
退回的通知不是選項（登記者還沒有這個頁面），一律寄到 SSO 的 email（有設定 SMTP 時）：登記或主機申請被退回時（event `request`，信中附網管填的原因）。
**指派主機不寄任何通知**（不論待指派或快速指派、指派當下或工作完成後；由助教自行告知，網頁上的文字一律是「助教指派後會通知你，也可以隨時回到我的帳號查看」）。
帳號 job 失敗時只通知網管頻道（runner 的 `[失敗] 指派 xiaoming @gpu01（#12）：<原因>`），本人在 `/me` 看到「開通失敗」。

送出：網頁與 runner 的排程只把通知寫進 `outbox`（不在 request 裡連外）；runner 另一條執行緒每 5 秒送出到期的列。
同一事件同一人只排一次（`UNIQUE(channel, dedupe_key)`）；每人每管道每小時最多 10 則，超過的標為 `skipped`；
送出前再確認仍有勾選、仍連結／驗證，否則 `skipped`；失敗於 5、10 分鐘後重試，第 3 次失敗即 `failed`（log 只記錯誤類型與代碼）。

`Notifications`：
```json
{"events": [{"key": "expiry", "label": "帳號即將到期（30／7／0 天前）"}, {"key": "maintenance", "label": "…"}],
 "discord": {"available": true, "linked": true, "name": "Alice"},
 "email": {"available": true, "address": "alice@example.edu", "sso_address": "alice@example.edu", "pending": null | "new@example.org"},
 "prefs": {"discord": ["maintenance"], "email": []}}
```
`address` = 目前收件地址（已驗證的其他地址，否則 SSO email；都沒有為 `null`）；`pending` = 等待驗證的地址。

| 方法 | 路徑 | 權限 | body → 回應 |
|---|---|---|---|
| GET | `/api/me/notifications` | member | → `Notifications` |
| PUT | `/api/me/notifications` | member | `{discord: [event], email: [event]}`（勾選後的完整集合）→ `Notifications`；未知事件 `400`；寫稽核 `notify_prefs` |
| GET | `/auth/discord/start` | member | 302 到 Discord 授權頁（`state` 綁在 session 與本人）；未設定 `404` |
| GET | `/auth/discord/callback` | member | 302 到 `/me?discord=linked`；`state` 不符、被拒、Discord 回應異常 → `/me?discord=error`；該 Discord 帳號已連到其他人 → `/me?discord=taken`；寫稽核 `discord_link` |
| POST | `/api/me/discord/unlink` | member | → `Notifications`；寫稽核 `discord_unlink` |
| POST | `/api/me/email` | member | `{email}` → `Notifications`；等於 SSO email 時直接改回（不需驗證），否則寄驗證碼（`pending`）；格式錯誤 `400`、60 秒內重寄或這一小時寄給本人的 Email 已達上限（驗證碼無法寄出，不留下待驗證狀態） `429`、未設定 SMTP `404` |
| POST | `/api/me/email/verify` | member | `{code}` → `Notifications`；錯誤、過期或錯太多次 `400`；寫稽核 `notify_email` |

Discord 的 redirect URI = `${PUBLIC_URL}/auth/discord/callback`（Caddy 已把 `/auth/*` 轉給 web）。

## 登記與待指派

沒有自行認領：SSO 身分只能**登記需求**，帳號一律由網管（助教）在「待指派」建立或連結，主機也由網管挑選。

`Request`：
```json
{"id": 4, "kind": "account" | "hosts", "person_id": null, "sso_id": "…", "email": "…", "name": "王小明", "username": "xmwang",
 "purpose": "…", "gpus": 2, "min_vram_gb": 24 | null, "until": "2027-06-30",
 "hosts": ["gpu01"], "status": "pending" | "approved" | "rejected", "created_at": "…", "updated_at": "…",
 "decided_by": null, "decided_at": null, "job_id": null, "jobs": [{"host": "gpu01", "job_id": 12, "status": "ok"}],
 "reject_reason": null | "…"}
```
- `kind: "account"`：**登記**（尚未對應人員的 SSO 身分）。`name` 姓名、`username` 希望的帳號名稱（只檢查格式，不檢查是否重複）。
  指派後 `person_id` 為連結或建立的人員。
- `kind: "hosts"`：既有成員「申請使用其他主機」（`person_id`、`username` 為本人，`name: null`）。
- 需求：`purpose` 用途（1–2000 字）、`gpus` GPU 張數（0–64）、`min_vram_gb` 每張最低顯存 GB（選填，1–1024）、`until` 預計使用到（不早於今天）。
- `hosts`：指派的主機；登記功能之前的舊申請為當時申請的主機（`gpus` 等為 `null`）。`jobs`：這次指派排入的工作（每台一個）；
  `job_id` 只有舊版核准的申請才有。`status: "approved"` 在 UI 顯示為「已指派」（只連結、沒有主機時為「已連結」），`rejected` 為「已退回」。
- `reject_reason`：退回時網管填的原因（選填，`requests.decision_note`），只在 `rejected` 時有值；登記者在首頁與登記頁看到「你的登記已被退回（日期）：<原因>。可修改後重新送出」，
  新的登記表單會帶入上次的內容。

| 方法 | 路徑 | 權限 | body → 回應 |
|---|---|---|---|
| GET | `/api/register` | identity | → `{registration: Request \| null（此身分最新一筆登記）, can_register: bool}`（已是人員或有等待中的登記時 `false`） |
| POST | `/api/register` | identity（尚無人員） | `{name, username, purpose, gpus, min_vram_gb?, until}` → `Request`；已有等待中的登記 `409`、已是人員 `403`；稽核 `register`；通知網管 Discord（`[帳號登記] 姓名（sso_id，email）希望帳號 …，GPU …`） |
| PUT | `/api/register` | identity（尚無人員） | 同 POST → `Request`；修改等待中的那一筆（沒有則 `404`）；稽核 `register_update` |
| GET | `/api/me/host-requests` | member | → `{requests: [Request], can_request: bool}`（有等待中的申請時 `false`） |
| POST | `/api/me/host-requests` | member | `{purpose, gpus, min_vram_gb?, until}` → `Request`（`kind: "hosts"`）；已有等待中 `409`；通知網管 Discord |
| GET | `/api/admin/requests` | admin | → `[Request]`（待指派在前） |
| POST | `/api/admin/requests/{id}/assign` | admin | 見下 → `{person_id, jobs: [{host, job_id}]}` |
| POST | `/api/admin/requests/{id}/reject` | admin | `{reason?}`（選填，最多 500 字）→ `Request`；寄退回通知（含原因）；稽核 `request_reject` |
| GET | `/api/admin/assign-hosts?person_id=` | admin | → `AssignHosts`（主機挑選用，見下） |

`POST /api/admin/requests/{id}/assign` `{person_id?, username?, hosts: [name]}`（整個請求一個 transaction，任何錯誤全部不變）：
**指派不設定也不更動 `people.expires_at`**（建立的新人員沒有到期日；連結時保留原值）；登記的 `until`（預計使用到）只顯示給助教參考，到期日在人員頁設定。
舊版 client 送的 `expires_at` 一律忽略。
- 登記（`kind: "account"`）：`person_id`（**連結既有帳號**）與 `username`（**建立新帳號**）恰好給一個，否則 `400`。
  - 連結：人員須存在（`404`）、還沒有 `sso_id`（`409`）、未鎖定（`400`）。設定 `sso_id`；`email`、`name` 原本空白才以登記的值補上。`hosts` 可為空（只連結）。稽核 `sso_link`。
  - 建立：`username` 合 `^[a-z_][a-z0-9_-]{0,31}$`（`400`）且非保留（`400`「admin 是保留名稱，請換一個」；登記時同樣檢查）、不可與任何人員或主機上看到的帳號同名（`409`，同一人請改用連結）；
    以 `allocUid` 分配全實驗室 UID 建立人員（`sso_id`、`email`、`name` 取自登記）。`hosts` 至少一台。稽核 `person_create`。
  - 登記的 SSO ID 已連到其他人員 `409`。
- 主機申請（`kind: "hosts"`）：申請人須仍是有效成員（`409`），`hosts` 至少一台；`person_id`、`username` 忽略。
- 指派 `hosts`（`assignHosts`）：每台先 `grant`（已開通 `400`「已經開通」；同名帳號需先認領等錯誤照舊 `400`／`409`），再各排一個
  **只動這個帳號、自動確認、不預覽**的 users job（`only_user`，design.md 約定 F），並寫一筆 `assignments`（runner 憑它執行）。
  新帳號的臨時密碼照舊只顯示在 `/me` 一次。申請改為 `approved`，`hosts` 為指派的主機，稽核 `request_assign`（不寄通知）。

`AssignHosts`：
```json
{"metrics_ok": true,
 "hosts": [{"name": "gpu01", "group": "gpu", "monitored": true, "up": true, "gpu_summary": "8× RTX 3090", "gpu_count": 8,
            "gpu_vram_gb": 24, "gpus_free": 3, "gpu_util_avg": 55.0, "users": 12,
            "primary_users": [{"username": "alice", "name": "Alice"}],
            "root_free_bytes": 4.0e10, "data_free_bytes": 1.9e12, "granted": false, "blocked": null}]}
```
硬體取自最後收集的 facts；`gpus_free`（閒置卡，規則同 GPU 看板）、`gpu_util_avg`、`up`、磁碟剩餘取自既有的 Prometheus 固定查詢
（`/api/metrics/gpus`、`/api/metrics/disk/filesystems` 同一組，不另外 SSH 收集）。`data_free_bytes` = 符合 `DATA_MOUNT_GLOB` 的檔案系統可用空間合計。
`users` = 這台主機已認領的帳號數：受管且連結到人員（`person_id` 不為空）、`desired=present` 且主機上未鎖定（不算沒人認領的舊帳號、已停用或待刪除的帳號）。未監控或 Prometheus 無法連線時即時欄位為 `null`（`metrics_ok: false`）。`granted`：`person_id` 指定的人員已開通這台。
`blocked`：指派到這台一定會失敗的原因（從未收集到資料，多半是還沒 bootstrap：「尚未收集到資料（可能還沒 bootstrap）」；監控顯示離線：「監控顯示離線」），否則 `null`；
挑選畫面把它標成「未 bootstrap／無法連線，指派會失敗」、排在最後且不能勾選（API 本身不擋）。

## 帳號（admin）

`GET /api/admin/accounts?tab=all|drift|uid|idle|unmanaged&days=365&q=`（每列另有 `reserved`：`root`、bot 與 `RESERVED_USERS`，UI 顯示「保留帳號」、沒有認領或刪除按鈕；`HostDetail.accounts[]` 同）
```json
{"tab": "drift",
 "rows": [{"host": "gpu01", "username": "alice", "uid": 1001, "expected_uid": 1001, "exists": true, "locked": false,
           "expires": null, "last_active": "…", "managed": true, "desired": "present",
           "person": {"id": 3, "username": "alice"} | null, "drift": ["uid 與認領時不同"]}],
 "conflicts": [{"kind": "same_name" | "same_uid", "key": "alice" | "1001",
                "entries": [{"host": "gpu01", "username": "alice", "uid": 1001}]}]}
```
`conflicts` 只在 `tab=uid` 時有內容。

`POST /api/admin/accounts/adopt` `{host, username, person_id?}` → `{person_id}`

`GET /api/admin/accounts/suggestions` — 建議批次認領（未受管、存在於主機上的帳號，依名稱分組）
```json
{"groups": [{"username": "alice", "uid": 1001, "hosts": ["gpu01", "gpu02"], "last_active": "…",
             "existing_person": {"id": 3, "username": "alice"} | null}],
 "conflicts": [{"username": "bob", "reason": "同名帳號的 UID 不同，不一定是同一人",
                "entries": [{"host": "gpu01", "uid": 1003}, {"host": "gpu02", "uid": 1004}]}]}
```
列入 `groups` 的條件：名稱合法且非保留帳號；這個名稱的每一筆紀錄（各主機上的帳號、已認領帳號的 `expected_uid`、同名人員的 `uid`）
都是同一個 uid，且沒有任何其他名稱用這個 uid（與 `tab=uid` 同一套衝突判斷，另加已認領與人員的 uid）。`existing_person` = 已有同名人員。
只因 uid 不符而沒列入的名稱放在 `conflicts`（`reason` 說明原因），需到「UID 衝突」逐台處理。

`POST /api/admin/accounts/adopt-bulk` `{items: [{username, hosts: [name], person_id?}]}`（1–1000 筆）
→ `{adopted: [{username, person_id, hosts}], errors: [{username, error}]}`
每筆各自一個 transaction：伺服器重新計算建議（不採用前端的分組），名稱須仍在 `groups`、`hosts` 須是它的主機（不重複）、
`person_id` 須等於 `existing_person.id`（沒有同名人員時不可給）；再逐台走單筆認領的同一段程式（各自寫稽核）。
任何一台失敗則這筆全部不認領、列入 `errors`，其他筆照常。沒有同名人員時第一台建立人員，uid 一致時設定 `people.uid`。

## 主機健康（admin）

`GET /api/admin/health`
```json
{"updated_at": "…", "metrics_ok": true, "fleet_driver": "550",
 "hosts": [{"host": "gpu01", "group": "gpu",
            "checks": [{"key": "disk_root", "status": "warn", "label": "根目錄空間", "detail": "/ 已用 88%，剩 7.8 GB，照目前速度約 5.2 天後寫滿"}]}]}
```
每台主機（順序同 `/api/hosts`）一律有以下 10 項，`status` 為 `ok|warn|bad|unknown`，`detail` 為給人看的說明：

| key | 來源 | 判斷 |
|---|---|---|
| `reachable` | `up` | 1 ok；0 bad；未監控、未抓取或 Prometheus 無法連線 unknown |
| `collect_age` | `facts_at` | 從未收集 bad；> 2 天 warn；> 7 天 bad |
| `apt` | facts `apt_check_ok`、`apt_update_at`（約定 E） | check 失敗 bad；最後成功更新距收集時間 > 3 天 warn、> 14 天 bad；沒有紀錄 unknown |
| `reboot_required` | facts | 需要重開機 warn（附套件、開機天數） |
| `disk_root` | 固定 PromQL：`/` 的使用率、剩餘、`predict_linear(avail[6h])` 算出的寫滿天數 | ≥ 95% 或（≥ 80% 且 < 3 天寫滿）bad；≥ 85% 或（≥ 80% 且 < 7 天）warn；寫滿天數只在 ≥ 80% 且 < 30 天時顯示 |
| `disk_any` | 同上，所有實體檔案系統 | 最嚴重的一個掛載點 |
| `smart` | `lab_smart_healthy` | 任一顆 0 bad；沒有資料 unknown |
| `gpu_missing` | `lab_gpu_pci_count`／`lab_gpu_smi_count`／`lab_nvidia_smi_ok`，沒有時用 facts | nvidia-smi 失敗或看到的比 lspci 少 bad |
| `driver_drift` | facts `nvidia_driver` | 主版號與全部主機最多的主版號（`fleet_driver`，同數取較新）不同 warn |
| `os_eol` | facts `os` | Ubuntu LTS 標準支援已結束（20.04：2025-06）warn；非 Ubuntu LTS unknown |

Prometheus 無法連線時不回 `502`：`metrics_ok=false`，需要即時資料的項目為 unknown（`gpu_missing` 改用 facts）。

## 人員（admin）

`Person` = session.user 欄位 + `{uid, created_at, hosts_count}`

| 方法 | 路徑 | body → 回應 |
|---|---|---|
| GET | `/api/admin/people` | → `[Person]` |
| GET | `/api/admin/people/{id}` | → `{person: Person, accounts: [同 me.accounts], keys: [同 me.keys], hosts: [{name, group, granted, exists}]}` |
| PUT | `/api/admin/people/{id}` | `{name, email, sso_id, expires_at, status, role?}` → `Person`；**不能改角色**：`role` 與目前不同一律 `403`（升級用下一列，降級只能用伺服器指令 `labdeck demote-admin`，見 admin-guide.md），相同或省略則忽略；不可鎖定自己（`400`）；稽核 `person_update` |
| POST | `/api/admin/people/{id}/promote` | → `Person`；把啟用中、未到期的成員設為管理員；已是管理員直接回傳（冪等，不重複稽核與通知）；鎖定或到期 `400`；不存在 `404`；稽核 `person_promote`、通知網管 Discord（`[管理員] <操作者> 將 <帳號>（<姓名>）設為管理員`） |
| PUT | `/api/admin/people/{id}/grants` | `{hosts: [name]}`（勾選後的完整集合）→ `{errors: [{host, error}]}`；人員頁「停用／恢復主機帳號」：**只能停用或恢復此人已有的受管帳號**（`desired` present ↔ locked），之後按同步（需預覽）；不在其中的主機列入 `errors`（「尚未開通：新主機請用「指派主機」」），新主機只能用 assign |
| POST | `/api/admin/people/{id}/assign` | `{hosts: [name]}` → `{jobs: [{host, job_id}]}`；**快速指派**（人員頁、主機頁「新增使用者」）：同待指派的 `assignHosts`，每台一個自動確認的單帳號 job；人員停用或到期 `400`；不寄通知、不改到期日 |
| POST | `/api/admin/people/{id}/sync` | → `{job_id \| null}` |
| POST | `/api/admin/sync` | → `{job_id \| null}` |

## 工作（admin）

`Job`：`{id, kind, target_hosts: [name], status, actor, created_at, run_at, finished_at, auto_confirm, summary, scoped}`（`target_hosts: []` = 全部主機，
即排程每日收集的 `"all"`；`args.target_hosts` 保留原值）；`summary` 是給人看的描述（`describeJob`，packages/core：「指派 xiaoming @gpu01」、
「刪除 oldgrad @gpu01」、「金鑰部署 alice @gpu01」、「帳號同步 …」、「收集資料（全部主機）」、「安裝監控 @gpu01」），網管頻道的通知用同一句；
`scoped`：管理員指派的單帳號 job（`only_user`）。
`JobDetail` = `Job` + `{args, check_output, output, failure}`；`failure`：失敗（`failed`、`check_failed`）時的一句白話摘要（`failureSummary`：
無法連線／host key 未知／金鑰被拒 →「主機尚未 bootstrap 或無法連線」、sudo 密碼不符、Permission denied、VPN 中斷、狀態已變更），否則 `null`。
`status`：`queued`、`awaiting`（預覽成功，等網管確認）、`confirmed`、`running`、`ok`、`failed`、`cancelled`、`check_failed`（**預檢失敗**：
`--check` 本身的 rc 不是 0 或 2，例如無法連線 rc=4，沒有預覽可確認；UI 置頂紅字「預檢無法連線到 <host>，未產生預覽，請修正後重新排程」，網管頻道 `[預檢失敗]`）。
`kind`：`collect`、`agents`、`users`；已移除的 `power`、`shutdown`、`bmc_check` 只會出現在舊紀錄（照常列出、可取消，但 runner 一律以「已停用的工作類型」標為失敗，不會執行）。

| 方法 | 路徑 | body → 回應 |
|---|---|---|
| GET | `/api/admin/jobs?limit=100` | → `[Job]`（新到舊） |
| GET | `/api/admin/jobs/{id}` | → `JobDetail` |
| POST | `/api/admin/jobs/{id}/confirm` | → `JobDetail`（僅 awaiting；`check_failed` 也是 `409`）；`users` 預覽與目前 DB 不符時 `409` `{"error": "狀態已變更，請重新同步後再確認"}`，job 改為 `cancelled` |
| POST | `/api/admin/jobs/{id}/rerun` | → 新的 `JobDetail`；**重新執行**失敗（`failed`、`check_failed`）的工作，其他狀態 `409`。依目前 DB 重建並重新檢查：`collect`、`agents` 同參數（`validateJob`）；指派的 job（`only_user`）須人員仍啟用、仍開通該主機，寫一筆新的 `assignments`（同一 `request_id`）；其他 `users` job 依同一批 (host, username) 重建，需預覽的重新預覽、只含金鑰的仍只含金鑰；已停用的 kind `400`；稽核 `job_rerun`（`{from}`） |
| POST | `/api/admin/jobs/{id}/cancel` | → `JobDetail` |

## 稽核（admin）

`GET /api/admin/audit?page=1` → `{rows: [{ts, actor, action, target, detail}], page, has_more}`（每頁 100 筆，新到舊；`detail` 為 JSON 物件，沒有細節時為 `{}`）
