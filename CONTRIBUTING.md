# 參與開發

歡迎提 issue 與 PR。動手改較大的功能前，先開 issue 討論做法，避免白工。
安全性問題請改走 [SECURITY.md](SECURITY.md)。

## 目錄

| 位置 | 內容 |
|---|---|
| `packages/core/` | web 與 runner 共用的 TypeScript：設定、SQLite（`schema.sql`）、驗證、job、通知佇列、Prometheus 查詢；`guide.md`、管理 CLI |
| `apps/web/` | Next.js（App Router）：網頁（`src/views`、`src/app`）與 JSON API（`src/server`），image `labdeck-web` |
| `apps/runner/` | runner（TypeScript；Node 直接執行 `.ts`），image `labdeck-runner`（含 Ansible 與 playbook，runner 與 cli 共用） |
| `ansible/` | `ansible.cfg`、playbooks（inventory 由 runner 從 DB 寫出） |
| `crates/agent/` | labdeck-agent（Rust）：主機端收集程式，playbook 從 runner image 複製到主機 |
| `deploy/` | Caddyfile、Caddy 憑證設定、Prometheus 規則、Alertmanager |
| `e2e/` | 端對端測試（假 OAuth、假 GPU 主機、Playwright） |
| `dev/`、`compose.dev.yaml`、`labdeck` | 開發環境、toolbox image、指令捷徑（docs/docker.md） |
| `docs/` | 設計與介面約定（`design.md`）、API（`api.md`）、部署（`deploy.md`） |

各部件之間的介面寫在 [docs/design.md](docs/design.md)；改介面時同一個 PR 內一併更新文件。

## 開發環境

**只需要 Docker**（compose v2，可跑 privileged 容器；Docker Desktop、OrbStack 皆可）。實驗室規則是主機上除了 Docker 什麼都不裝：
Node.js、Rust、Python、Ansible、Playwright 都在容器內，經 repo 根目錄的 `./labdeck` 使用（細節與疑難排解見 [docs/docker.md](docs/docker.md)）。

```sh
./labdeck dev          # 開發環境：http://localhost:8080 ，任何名稱都能登入，dev 是管理員；改 code 即時生效
./labdeck dev logs -f web runner
./labdeck dev down     # 停止（加 -v 連資料一起清掉）
./labdeck tool bash    # 進 toolbox（Node 24 + Rust），例如跑單一測試：./labdeck tool npx vitest run packages/core
```

開發環境（`compose.dev.yaml`）包含 Next.js dev server、`node --watch` 的 runner、假 OAuth／Discord／SMTP、
一台假的 Ubuntu GPU 主機 `gpu01` 與 Prometheus，不讀 `.env`、不用 `secrets/`。
只改畫面時也可以用內建的假 API（`NEXT_PUBLIC_MOCK=1`，見 docs/docker.md）。

**不要對真實主機跑 ansible 或 e2e**；測試只使用假主機 gpu01。

## 測試

送 PR 前跑與改動相關的部分；CI（`.github/workflows/ci.yml`）在容器內跑同樣的檢查（e2e 除外）。

```sh
./labdeck lint         # 型別檢查、eslint、next build、cargo fmt/clippy、playbook syntax-check、Alertmanager 設定
./labdeck test         # vitest（core、API route handler、runner；不連網、不碰主機）、cargo test、Prometheus 告警規則
./labdeck e2e          # 端對端（約 5–10 分鐘，需空出 8080、9999 port）；KEEP=1 跑完保留環境、SKIP_BUILD=1 不重建 image
./labdeck build        # 建置正式的三個 image（改了 Dockerfile 時）
```

動到登入、job、playbook 或 compose 時請跑 e2e；也可在 GitHub Actions 手動觸發 CI 並勾選 e2e。

## 慣例

- **語言**：網頁文字與文件用繁體中文；程式碼註解沿用該檔案原本的語言與風格。
- **不放站點資料**：repo 內不可有真實的主機名稱、IP、帳號、email 或機密。範例用 `gpu01`、`example.org`、
  文件專用 IP（`192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24`）。
- **保持簡單**：優先用標準函式庫與既有的寫法，不為假想需求加設定或抽象層。
- **安全相關的行為**（runner 的 playbook allowlist、`--check --diff` 預覽、CSRF、`!unsafe` job 檔）改動時要附測試。

## Commit 與 PR

- 一個 commit 做一件事。標題用英文祈使句、70 字元內，可加範圍前綴，例如
  `runner: skip hosts that are all down`、`docs: firewall rule for the compose subnet`；
  內文說明「為什麼」，而不只是「做了什麼」。
- PR 描述寫清楚動機與測試方式，並勾選範本中的檢查項目。
