# Docker：正式環境、開發與測試

**實驗室規則：主機上除了 Docker 之外什麼都不裝。** 部署、開發、測試都只需要 Docker Engine（或 Docker Desktop／OrbStack）與 compose v2；
不需要在主機上裝 Node.js、npm、Rust、Python、Ansible、openssl 或 git。需要的工具都在 image 裡：

| Image | 來源 | 用途 |
|---|---|---|
| `labdeck-web`、`labdeck-runner`、`labdeck-caddy` | `apps/web/Dockerfile`、`apps/runner/Dockerfile`、`deploy/caddy.Dockerfile`；CI 推到 GHCR | 正式環境（`compose.yaml`）。runner image 也有 ansible、`ansible-vault`、playbook 與 `labdeck-init-secrets` |
| `labdeck-toolbox:local` | `dev/toolbox.Dockerfile` | 開發工具：Node 24、Rust（rustfmt、clippy）、ssh-keygen；跑檢查、測試與 Next.js dev server |
| `labdeck-e2e-driver:local` | `e2e/Dockerfile` | 端對端測試：Playwright（含瀏覽器）與 docker CLI |
| `labdeck-e2e-host:local` | `e2e/target/Dockerfile` | 假的受管主機 gpu01（e2e 與開發環境） |

## `./labdeck`

repo 根目錄的小腳本（POSIX sh，只呼叫 docker），每個子指令都對應一兩行 docker compose，看腳本就知道實際跑了什麼：

| 指令 | 內容 |
|---|---|
| `./labdeck dev` | 開發環境（`compose.dev.yaml`）：建置並啟動，http://localhost:8080 |
| `./labdeck dev <compose 參數>` | 對開發環境下 compose 指令，例如 `./labdeck dev logs -f web runner`、`./labdeck dev down`（加 `-v` 連資料一起清掉） |
| `./labdeck tool <指令>` | 在 toolbox 容器內執行任何指令，例如 `./labdeck tool npm run -w @labdeck/web lint`、`./labdeck tool bash` |
| `./labdeck test` | vitest、`cargo test`、Prometheus 規則測試 |
| `./labdeck lint` | typecheck、eslint、`next build`、`cargo fmt --check`、clippy、ansible syntax-check、Alertmanager 設定檢查 |
| `./labdeck e2e [playwright 參數]` | 端對端測試（= `e2e/run.sh`） |
| `./labdeck test-updater` | 自動更新（`deploy/updater/`）的測試：本機 registry + 拋棄式 compose 專案（= `scripts/test-updater.sh`，`KEEP=1` 不拆） |
| `./labdeck build` | 從原始碼建置正式的三個 image（= `docker compose build`） |
| `./labdeck prod-up` | 正式環境：`docker compose pull && docker compose up -d` |
| `./labdeck logs [服務]` | 正式環境的 log（`docker compose logs -f`） |

## 正式環境（預先建好的 image）

安裝與升級步驟見 [deploy.md](deploy.md)。重點：

- 監控主機只需要 `compose.yaml`、`deploy/`、`.env`、`secrets/` 四樣東西，不需要 clone repo。
- image 由 GitHub Actions 建置並推到 GHCR（`.github/workflows/ci.yml` 的 `images` job，只做 linux/amd64）：
  `ghcr.io/<owner>/labdeck-{web,runner,caddy}`，tag 有 `sha-<commit>`、`main`（main 分支最新）、`<版本>` 與 `<主.次>`（`v*` tag），
  以及 `latest`（最新的正式版 tag）。
- `.env` 的 `LABDECK_IMAGE_PREFIX`（預設 `ghcr.io/takalawang/labdeck`）與 `LABDECK_VERSION`（預設 `latest`）決定用哪個 image；
  建議固定成某個版本，升級時改版本號再 `docker compose pull && docker compose up -d`。
- 自動更新（選用）：compose 的 `updater` 服務（profile `autoupdate`）以官方 `docker:*-cli` image 執行從部署目錄掛入的
  `deploy/updater/updater.sh`，定時拉 `LABDECK_VERSION` 的新 image、健康檢查失敗自動回復，不需要另外的 image。見 [deploy.md](deploy.md#自動更新cd)。
- 從原始碼建置：在 checkout 內把 `.env` 設成 `LABDECK_IMAGE_PREFIX=labdeck`、`LABDECK_VERSION=local`，再 `docker compose build`（`./labdeck build`）。
  建置時需要連得到 npm、PyPI、crates.io 與 Docker Hub；runner image 內的 labdeck-agent（Rust）只在建置時需要 crates.io，執行時不用。
  不改這兩個變數直接建置，image 會用 GHCR 的名稱，之後的 `docker compose pull` 會把它換掉。
- 機密：`docker compose run --rm --no-deps --user 0:0 -v "$PWD/secrets:/secrets" runner labdeck-init-secrets /secrets`
  （checkout 內等同 `scripts/init-secrets.sh`）；修改 vault：`docker compose run --rm -v "$PWD/secrets:/w" cli ansible-vault edit /w/vault.yml`。

## 開發環境

```sh
./labdeck dev                 # 第一次要建置 image（runner image 會編譯 labdeck-agent，需要幾分鐘）
```

開 http://localhost:8080 ，在假的登入頁輸入任何名稱即可登入；`dev` 是管理員（啟動時以 `labdeck add-admin dev dev` 建立）。內容：

| 服務 | 說明 |
|---|---|
| `web` | `next dev`（toolbox image），原始碼從工作目錄掛入，改了即時生效（hot reload） |
| `runner` | runner image，`apps/runner/src`、`packages/core/src` 與 `ansible/` 從工作目錄掛入，`node --watch` 改了就重啟 |
| `deps`、`seed`、`secrets` | 啟動時跑一次：`package-lock.json` 有變動才 `npm ci`；建 DB 與管理員；在 volume 內產生測試用 secrets |
| `mock-oauth` | 假 OAuth／Discord／SMTP（`e2e/mock_oauth.py`），收到的通知在 http://localhost:9999/_sink |
| `gpu01` | 假的受管主機（Ubuntu 20.04 + systemd + sshd，管理帳號 `admin`／`adminpw`） |
| `prometheus`、`alertmanager` | 同正式環境的設定（`deploy/`） |

沒有 Caddy 與 TLS，web 直接開在 http://localhost:8080 。不讀 `.env`、不用 `secrets/`：同一份 checkout 是正式部署也不會互相影響。
資料（DB、Prometheus 的抓取目標、secrets）在 `labdeck-dev_*` volume，`./labdeck dev down -v` 清掉重來。

要讓 runner 管理 gpu01：在網頁 `/admin/hosts` 新增主機 `gpu01`（位址 `gpu01`），再 bootstrap bot 帳號（密碼都是 `adminpw`）：

```sh
./labdeck dev exec runner ansible-playbook /repo/ansible/playbooks/bootstrap_bot.yaml -l gpu01 -u admin -k -K \
  -e @/run/secrets/vault.yml -e monitoring_host_ip=172.31.251.0/24
```

之後就能在網頁上按「安裝監控」「收集資料」。

只改畫面、不需要後端時，可改用內建的假 API（`?mock_role=anon|identity|member|admin` 切換身分，見 `apps/web/README.md`）：
`./labdeck dev stop web && ./labdeck dev run --rm --no-deps -p 127.0.0.1:3000:3000 -e NEXT_PUBLIC_MOCK=1 web`，開 http://localhost:3000 。

## 檢查與測試

```sh
./labdeck test     # vitest（core、API route handler、runner）、cargo test、promtool test rules
./labdeck lint     # 型別、eslint、next build、cargo fmt/clippy、ansible syntax-check、amtool check-config
./labdeck e2e      # 端對端（約 5–10 分鐘）
./labdeck test-updater   # 自動更新：v1→v2、停著的服務不動、壞版本回復且不重試（約 3 分鐘）
```

toolbox 的 `node_modules`、`.next` 與 cargo 的快取與編譯結果放在 volume（`labdeck-dev_node_modules` 等），不會寫進工作目錄，
也不會和主機上（如果有）的 `node_modules` 混在一起。`package-lock.json` 改變時，下次執行會自動 `npm ci`。
toolbox 以工作目錄的 owner 身分執行（Linux 上就是你自己），寫進 repo 的檔案不會變成 root 的。CI 跑的是同一組指令。

### 端對端測試

`e2e/run.sh`（`./labdeck e2e`）會先建 `labdeck-e2e-driver:local`，再在其中重跑自己：容器經主機的 Docker socket
（`/var/run/docker.sock`）操作 compose，repo 以相同路徑掛進容器，所以 compose 的相對路徑在主機上一樣成立。
它把 repo 複製到 `e2e/.work/app`、產生測試用 `.env` 與 `secrets/`、建置 image、起 `compose.yaml` + `e2e/compose.e2e.yaml`（專案 `labdeck-e2e`），
然後把自己接上 `labdeck-e2e_lab` 網路，以 socat 把容器內的 localhost:8080／9999 轉給 caddy 與 mock-oauth，再跑 Playwright。

- `KEEP=1`：跑完保留環境（主機上 http://localhost:8080 ，以 `tester` 或任何名稱登入）；`SKIP_BUILD=1`：不重建 image。
- 參數傳給 Playwright，例如 `./labdeck e2e -g CSRF`。瀏覽器是 headless（在容器內），`--headed` 不能用。
- 失敗時 log 在 `e2e/.work/logs/`，Playwright 報告在 `e2e/playwright-report/index.html`（含失敗測試的 trace）。

## 疑難排解

- **port 8080／9999 被占用**：開發環境與 e2e 都用這兩個 port（只綁 127.0.0.1），不能同時跑。`docker ps` 找 `labdeck-dev-*`、`labdeck-e2e-*`，
  `./labdeck dev down` 或照 e2e 印出的拆除指令處理。
- **改了程式但開發環境沒反應**：Docker Desktop 偶爾收不到檔案變更通知；在 `compose.dev.yaml` 的 web 加 `WATCHPACK_POLLING: "true"`。
  改了 `package.json`／`package-lock.json` 後重啟 web（`./labdeck dev restart deps web`），改了 runner 的相依套件或 Dockerfile 則 `./labdeck dev`（重建 image）。
- **node_modules 壞了**、想重新安裝：`docker volume rm labdeck-dev_node_modules labdeck-dev_web_node_modules`（先 `./labdeck dev down`）。
- **e2e 的 `docker network connect` 失敗**：上一次中斷的 e2e 留下了容器或網路，`docker compose -p labdeck-e2e down -v` 後重跑。
- **Docker socket 不在 `/var/run/docker.sock`**（rootless Docker）：e2e 需要它；Docker Desktop 與 OrbStack 在容器內都有這個路徑。
- **Linux 上 `secrets/` 讀不到**：檔案 owner 是容器內的使用者（1000、65534），用 `sudo` 讀或經容器操作（`docker compose run --rm cli …`）。
- **arm64 的機器**（Apple Silicon）：labdeck-agent 永遠以 linux/amd64 建置（主機是 x86_64），在 arm64 上是模擬執行，第一次建置 runner image 比較久。
