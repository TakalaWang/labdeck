# 安全性政策

## 回報漏洞

請**不要**開公開 issue。用 GitHub 的私下回報：repo 的 **Security → Report a vulnerability**
（GitHub Security Advisories）。請附上受影響的版本（commit）、重現步驟與影響範圍；
貼 log 前遮掉主機名稱、IP、帳號與機密。

維護者會盡快回覆，修好後發布修正並在 advisory 中致謝（除非你不希望具名）。
只有 `main` 分支的最新版本會收到安全性修正。

## 威脅模型摘要

LabDeck 能以 root 權限變更所有受管主機（建立／鎖定帳號、裝監控、關機），所以設計上把這個能力集中、縮小在一個地方。
完整約定見 [docs/design.md](docs/design.md)（約定 A：容器與機密、約定 F：runner 的 job、約定 G：Caddy 與 API）。

- **runner 是唯一持有 SSH key 與 vault 的常駐服務。** web 容器看不到 `secrets/`，只能把 job 寫進佇列；
  runner 只執行 allowlist 內的 playbook，參數由程式組成（argv，不經 shell），job 檔以 `!unsafe` 載入，Ansible 不會當樣板展開。
  帳號變更一律先 `--check --diff`，由管理員確認後才套用。
- **bot 帳號**的 SSH key 以 `from=` 限定只能從監控主機登入；sudo 需要密碼，且每台主機的密碼不同
  （由 vault 內的秘密與主機名稱導出），一台主機被攻破拿不到其他台的密碼。
- **對外只有 Caddy。** Prometheus、Alertmanager 不開 port；網頁圖表只經 web 的固定查詢取得。
  node_exporter 走 TLS + basic auth。建議只讓校內網路或 VPN 連得到 Caddy。
- **身分來自 OAuth 登入**（session cookie）；會改變狀態的 API 一律檢查 CSRF token 與 `Origin`；
  回應帶嚴格的 CSP（無 inline script、無外部資源）。

不在範圍內：已取得監控主機 root 或 Docker 權限的攻擊者、OAuth 身分提供者本身被攻破、
以及受管主機上本來就有 sudo 權限的使用者。
