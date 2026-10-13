-- Portal-generated times are local ISO strings (YYYY-MM-DDTHH:MM:SS, in the container TZ);
-- times observed on hosts (last_login, home_mtime, logins.ts, seen_at, facts_at) are epoch seconds.

CREATE TABLE IF NOT EXISTS people (
  id            INTEGER PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  uid           INTEGER UNIQUE,
  sso_id        TEXT UNIQUE,
  email         TEXT,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked')),
  expires_at    TEXT,
  temp_password TEXT,
  created_at    TEXT NOT NULL,
  -- personal notifications (opt-in, docs/api.md 通知)
  discord_id    TEXT UNIQUE,  -- linked Discord user (OAuth2 scope identify): mentioned in the lab channel
  discord_name  TEXT,
  notify_email  TEXT,         -- a verified address other than `email`; NULL = `email` (from SSO)
  notify_prefs  TEXT,         -- JSON {"discord": [event], "email": [event]}; NULL = all off
  -- 1 = temp_password was set for an account-creation job that has not succeeded yet: not shown to its owner
  temp_password_pending INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS accounts (
  host             TEXT NOT NULL,
  username         TEXT NOT NULL,
  -- observed by collect (ingest only writes these)
  uid              INTEGER,
  last_login       INTEGER,
  home_mtime       INTEGER,
  observed_locked  INTEGER,
  observed_expires TEXT,
  exists_on_host   INTEGER NOT NULL DEFAULT 0,
  seen_at          INTEGER,
  -- desired state (portal only)
  person_id        INTEGER REFERENCES people(id),
  managed          INTEGER NOT NULL DEFAULT 0,
  -- absent: delete the account (a previewed users job; person_id may be NULL for an old unassigned account)
  desired          TEXT CHECK (desired IN ('present', 'locked', 'absent')),
  expected_uid     INTEGER,
  primary_user     INTEGER NOT NULL DEFAULT 0,  -- managed rows: one of this host's primary users (shown on host pages)
  remove_home      INTEGER NOT NULL DEFAULT 0,  -- desired absent: also remove the home directory
  PRIMARY KEY (host, username)
);
CREATE INDEX IF NOT EXISTS accounts_person ON accounts(person_id);

CREATE TABLE IF NOT EXISTS ssh_keys (
  id          INTEGER PRIMARY KEY,
  person_id   INTEGER NOT NULL REFERENCES people(id),
  pubkey      TEXT NOT NULL,
  fingerprint TEXT UNIQUE NOT NULL,
  state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  added_at    TEXT NOT NULL
);

-- 約定 C; the runner writes the Ansible inventory from it. Validated by validateHost (packages/core).
CREATE TABLE IF NOT EXISTS hosts (
  name        TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  group_name  TEXT NOT NULL,
  bmc_address TEXT,
  -- IPMI: last bmc_check result (NULL = never checked); bmc_status is also set/cleared by admins. bmc_note: admin note.
  bmc_status  TEXT CHECK (bmc_status IN ('ok', 'fault')),
  bmc_power   TEXT CHECK (bmc_power IN ('on', 'off')),
  bmc_checked_at TEXT,
  bmc_note    TEXT,
  console     TEXT,                        -- where to reach it on site, e.g. "KVM 10"
  boot_risk   INTEGER NOT NULL DEFAULT 0,  -- a remote reboot may hang in BIOS (e.g. dead CMOS battery)
  ssh_no_retry INTEGER NOT NULL DEFAULT 0, -- bans source IPs opening frequent SSH connections: ansible_ssh_retries 0
  monitored   INTEGER NOT NULL DEFAULT 0,
  no_shutdown INTEGER NOT NULL DEFAULT 0,
  room        TEXT,
  rack        TEXT,
  psu         TEXT,
  notes       TEXT,
  facts_json  TEXT,
  facts_at    INTEGER,
  created_at  TEXT
);

CREATE TABLE IF NOT EXISTS logins (
  host     TEXT NOT NULL,
  username TEXT NOT NULL,
  src      TEXT,
  ts       INTEGER NOT NULL,
  UNIQUE (host, username, ts)
);

-- kind 'account': registration of an SSO identity without a person (登記; an admin links or creates the person);
-- 'hosts': a member asking for more hosts (person_id set). Both state needs, never hosts: an admin picks them (待指派).
-- reason = 用途, expected_end = 預計使用到; name / username = 姓名 / 希望的帳號名稱 (registrations), gpus, min_vram_gb.
-- hosts_json: the hosts assigned (rows before registrations: the hosts asked for). job_id: legacy single job of an
-- approved request; assignments record the jobs of an assignment.
CREATE TABLE IF NOT EXISTS requests (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'account' CHECK (kind IN ('account', 'hosts')),
  person_id    INTEGER REFERENCES people(id),
  sso_id       TEXT NOT NULL,
  email        TEXT,
  username     TEXT NOT NULL,
  hosts_json   TEXT NOT NULL,
  reason       TEXT NOT NULL,
  expected_end TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by   TEXT,
  decided_at   TEXT,
  job_id       INTEGER REFERENCES jobs(id),
  created_at   TEXT NOT NULL,
  name         TEXT,
  gpus         INTEGER,
  min_vram_gb  INTEGER,
  updated_at   TEXT,
  decision_note TEXT  -- the reason an admin gave for a rejection (shown to the requester, in the email)
);

-- An admin assigned `host` to a person (待指派, or quick assign on the person / host page): the auto-confirmed users
-- job scoped to that one account (only_user). The runner runs a scoped job only when its row here exists (約定 F).
CREATE TABLE IF NOT EXISTS assignments (
  id         INTEGER PRIMARY KEY,
  job_id     INTEGER UNIQUE NOT NULL REFERENCES jobs(id),
  person_id  INTEGER NOT NULL REFERENCES people(id),
  host       TEXT NOT NULL,
  request_id INTEGER REFERENCES requests(id),  -- NULL: quick assign
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('collect', 'agents', 'users', 'power', 'shutdown', 'bmc_check')),
  args_json    TEXT NOT NULL,
  actor        TEXT NOT NULL,
  run_at       TEXT NOT NULL,
  auto_confirm INTEGER NOT NULL DEFAULT 0,
  -- check_failed: the --check preview itself failed (e.g. unreachable); nothing to confirm
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'awaiting', 'confirmed', 'running', 'ok', 'failed', 'cancelled', 'check_failed')),
  check_output TEXT,
  output       TEXT,
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  detail_json TEXT
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

CREATE TABLE IF NOT EXISTS announcements (
  id              INTEGER PRIMARY KEY,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  starts_at       TEXT,
  ends_at         TEXT,
  shutdown_job_id INTEGER REFERENCES jobs(id),
  hosts           TEXT,  -- maintenance window: affected hosts, comma-separated (NULL = none named)
  -- cancel-shutdown was called; shutdown_cancel_job_id = its `shutdown -c` job when the shutdown may already be armed
  shutdown_cancelled_at  TEXT,
  shutdown_cancel_job_id INTEGER REFERENCES jobs(id),
  reminded_at     TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

-- Admin-edited site content (Markdown), e.g. key 'guide'; no row = the built-in default.
CREATE TABLE IF NOT EXISTS pages (
  key        TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Pending change of people.notify_email: a 6-digit code mailed to the new address (only its hash is kept).
CREATE TABLE IF NOT EXISTS email_verifications (
  person_id  INTEGER PRIMARY KEY REFERENCES people(id),
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Personal notifications: web and runner queue, the runner's sender thread delivers (notifications.py).
CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY,
  person_id  INTEGER REFERENCES people(id),  -- NULL: to_addr only (a rejected request has no person)
  channel    TEXT NOT NULL CHECK (channel IN ('discord', 'email')),
  event      TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  to_addr    TEXT,  -- email: fixed recipient (verification code, request result); NULL = the person's address at send time
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    TEXT NOT NULL,
  error      TEXT,
  created_at TEXT NOT NULL,
  sent_at    TEXT,
  UNIQUE (channel, dedupe_key)
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_at);

-- Removed tables (the unassigned-logins list; SSO identities are linked to people by admins, 待指派).
DROP TABLE IF EXISTS unassigned_logins;
