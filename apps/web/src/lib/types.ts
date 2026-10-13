// Shapes from docs/api.md — the single source of truth for the portal JSON API.
// Timestamps are ISO 8601 strings with offset; dates are YYYY-MM-DD; missing values are null.

export type ISODateTime = string
export type ISODate = string

// ---- Session -------------------------------------------------------------

export type Role = 'admin' | 'member'
export type PersonStatus = 'active' | 'locked'

export interface User {
  id: number
  username: string
  name: string | null
  email: string | null
  sso_id: string | null
  role: Role
  status: PersonStatus
  expires_at: ISODate | null
}

export interface Session {
  site: { name: string; oauth_name: string }
  csrf: string
  user: User | null
  identity: { sso_id: string; email: string | null } | null
}

// ---- Summary / announcements --------------------------------------------

export interface Announcement {
  id: number
  title: string
  body: string
  starts_at: ISODateTime | null
  ends_at: ISODateTime | null
  created_by: string
  /** Maintenance window: affected hosts ([] = none named). */
  hosts: string[]
}

export interface Summary {
  hosts_total: number
  hosts_up: number | null
  gpus_total: number
  gpus_idle: number | null
  announcements: Announcement[]
  metrics_ok: boolean
}

export interface AnnouncementInput {
  title: string
  body: string
  starts_at: ISODateTime | null
  ends_at: ISODateTime | null
  /** Maintenance window: affected hosts (optional). */
  hosts?: string[]
}

// ---- Hosts ---------------------------------------------------------------

export interface HostStatus {
  /** null = not scraped yet (no data), not offline */
  up: boolean | null
  cpu_pct: number | null
  mem_pct: number | null
  root_pct: number | null
  gpu_util_avg: number | null
  net_rx_bps: number | null
  net_tx_bps: number | null
}

export interface Host {
  name: string
  address: string
  group: string
  /** the host bans IPs opening SSH connections often: ansible never retries a failed connection */
  ssh_no_retry: boolean
  monitored: boolean
  room: string | null
  rack: string | null
  psu: string | null
  notes: string | null
  facts_at: ISODateTime | null
  os: string | null
  kernel: string | null
  cpu_model: string | null
  cpu_count: number | null
  mem_gb: number | null
  nvidia_driver: string | null
  cuda: string | null
  gpu_summary: string | null
  gpu_count: number | null
  gpu_pci_count: number | null
  disk_count: number | null
  status: HostStatus | null
  /** managed accounts flagged as this host's primary users (visible to members) */
  primary_users: { username: string; name: string | null }[]
}

export interface FactGpu {
  index: number
  name: string
  uuid: string
  memory_mb: number | null
}
export interface FactDisk {
  name: string
  size_bytes: number | null
  model: string | null
  serial: string | null
  rota: boolean | null
}
export interface FactMount {
  mountpoint: string
  size_bytes: number | null
  used_bytes: number | null
}
/** collect JSON facts, passed through as-is (design.md 約定 E) — every field may be absent. */
export interface Facts {
  os?: string
  kernel?: string
  cpu_model?: string
  cpu_count?: number
  mem_mb?: number
  nvidia_driver?: string
  cuda?: string
  gpu_pci_count?: number
  gpus?: FactGpu[]
  disks?: FactDisk[]
  mounts?: FactMount[]
  [key: string]: unknown
}

export interface PersonRef {
  id: number
  username: string
}

/** absent: to be deleted on that host (an admin queued it; previewed) */
export type Desired = 'present' | 'locked' | 'absent'

export interface HostAccount {
  username: string
  uid: number | null
  exists: boolean
  locked: boolean
  expires: ISODate | null
  last_active: ISODateTime | null
  managed: boolean
  desired: Desired | null
  primary: boolean
  /** name / discord_name only for admins, or when this account is a primary user of the host */
  person: (PersonRef & { name?: string | null; discord_name?: string | null }) | null
  /** root, the bot, RESERVED_USERS: never adopted, edited or deleted */
  reserved: boolean
}

/** GET /api/metrics/hosts/{name}/gpu-hours */
export interface HostGpuHours {
  days: number
  users: { user: string; gpu_hours: number }[]
}

export interface HostDetail extends Host {
  facts: Facts | null
  accounts: HostAccount[]
  bootstrap_command?: string // admin only
}

export interface HostInput {
  name?: string
  address: string
  group: string
  ssh_no_retry?: boolean
  room?: string | null
  rack?: string | null
  psu?: string | null
  notes?: string | null
  monitored?: boolean
}

export interface HostImportResult {
  added: string[]
  skipped: { name: string; reason: string }[]
  errors: { line: number; error: string }[]
}

export interface JobRef {
  job_id: number
}

// ---- Metrics -------------------------------------------------------------

export type Range = '1h' | '6h' | '24h' | '7d' | '30d'
/** [epoch seconds, value] */
export type Point = [number, number]
export type SeriesMap = Record<string, Point[]>

export interface HostMetrics {
  range: Range
  step: number
  cpu_pct: Point[]
  mem_pct: Point[]
  net_rx_bps: SeriesMap
  net_tx_bps: SeriesMap
  disk_pct: SeriesMap
  gpu_util_pct: SeriesMap
  gpu_mem_pct: SeriesMap
}

export interface GpuProcess {
  user: string
  pid: number
  comm: string
  mem_bytes: number
}

export interface Gpu {
  index: number | null
  uuid: string
  name: string
  util_pct: number | null
  mem_used_bytes: number | null
  mem_total_bytes: number | null
  temp_c: number | null
  power_w: number | null
  idle: boolean
  processes: GpuProcess[]
}

export interface GpuHost {
  host: string
  group: string
  /** null = no data yet */
  up: boolean | null
  nvidia_ok: boolean | null
  gpus: Gpu[]
}

export interface GpuBoard {
  updated_at: ISODateTime
  hosts: GpuHost[]
}

export interface UserLoad {
  user: string
  /** null = only seen on a GPU (labdeck-agent procs has no row for this user) */
  cpu_cores: number | null
  /** sum of RSS: shared memory counts once per process */
  mem_bytes: number | null
  processes: number | null
  gpu_count: number
  gpu_mem_bytes: number
}

export interface HostLoad {
  host: string
  group: string
  /** null = no data yet */
  up: boolean | null
  cpu_count: number | null
  cpu_used_cores: number | null
  mem_total_bytes: number | null
  mem_used_bytes: number | null
  /** heaviest first; [] = the host reports no per-user data */
  users: UserLoad[]
}

export interface UserLoadBoard {
  updated_at: ISODateTime
  hosts: HostLoad[]
}

export interface DiskUsage {
  owners: { owner: string; bytes: number; paths: number }[]
  rows: { host: string; root: string; path: string; owner: string; bytes: number }[]
  last_scan: { host: string; root: string; at: ISODateTime | null }[]
}

/** History charts: values on one grid, value i at `start + i·step` (epoch seconds); null = no sample (a gap). */
export interface Grid {
  step: number
  start: number
  end: number
}
export type Values = (number | null)[]

export interface FleetGroup {
  group: string
  hosts_total: number
  hosts_up: number
  gpu_util: Values
  cpu_pct: Values
}

export interface FleetHistory extends Grid {
  range: Range
  gpus_busy: Values
  gpus_idle: Values
  groups: FleetGroup[]
}

export interface GpuHistory extends Grid {
  range: '1h' | '6h' | '24h'
  /** host → GPU uuid → utilization % */
  hosts: Record<string, Record<string, Values>>
}

export interface HostHistory extends Grid {
  range: '1h' | '6h' | '24h'
  hosts: Record<string, { cpu_pct: Values | null; gpu_util: Values | null }>
}

export interface Filesystem {
  mountpoint: string
  device: string
  size_bytes: number
  used_bytes: number
  avail_bytes: number
}

export interface FilesystemBoard {
  hosts: { host: string; group: string; filesystems: Filesystem[] }[]
}

export interface DiskTrend extends Grid {
  days: number
  owners: { owner: string; bytes: Values }[]
}

export interface GpuMonthly {
  month: string
  by_user: { user: string; gpu_hours: number }[]
  by_host: { host: string; gpu_hours: number }[]
  by_user_host: { user: string; host: string; gpu_hours: number }[]
}

// ---- Me ------------------------------------------------------------------

export interface MyAccount {
  host: string
  username: string
  uid: number | null
  exists: boolean
  locked: boolean
  expires: ISODate | null
  last_active: ISODateTime | null
  desired: Desired
  primary: boolean
  /** the host's address, for `ssh <username>@<address>` */
  address: string | null
  /** latest assignment job of this host for the person; null = never assigned there */
  job_status: JobStatus | null
}

export interface SshKey {
  id: number
  fingerprint: string
  type: string
  comment: string | null
  state: 'active' | 'revoked'
  added_at: ISODateTime
}

export interface Me {
  person: User
  accounts: MyAccount[]
  keys: SshKey[]
  /** shown once a job creating one of the accounts succeeded, until POST /api/me/temp-password/ack */
  temp_password: string | null
  /** pending: accounts are being created; failed: their jobs failed (the admins were notified) */
  account_setup: 'pending' | 'failed' | null
}

export type NotifyChannel = 'discord' | 'email'

/** GET /api/me/notifications — personal notifications (opt-in; a channel is hidden when not `available`). */
export interface NotifySettings {
  events: { key: string; label: string }[]
  discord: { available: boolean; linked: boolean; name: string | null }
  email: { available: boolean; address: string | null; sso_address: string | null; pending: string | null }
  prefs: Record<NotifyChannel, string[]>
}

export interface MyUsage {
  gpu_processes: { host: string; gpu: number; pid: number; comm: string; mem_bytes: number }[]
  cpu_mem: { host: string; cpu_cores: number | null; mem_bytes: number | null; processes: number | null }[]
  disk: { host: string; path: string; bytes: number }[]
}

// ---- Registrations / host requests (待指派) ---------------------------------

export type RequestStatus = 'pending' | 'approved' | 'rejected'

/** What a newcomer or a member needs; an admin picks the hosts. */
export interface Needs {
  purpose: string
  gpus: number
  /** per card, GB; null = any */
  min_vram_gb: number | null
  until: ISODate
}

export interface AccountRequest {
  id: number
  /** account: registration of an SSO identity (登記); hosts: a member asking for more hosts */
  kind: 'account' | 'hosts'
  person_id: number | null
  sso_id: string
  email: string | null
  /** 姓名 (registrations) */
  name: string | null
  /** 希望的帳號名稱 (registrations) or the member's username */
  username: string
  purpose: string
  /** null on requests made before registrations */
  gpus: number | null
  min_vram_gb: number | null
  until: ISODate | null
  /** the hosts assigned (requests from before registrations: the hosts asked for) */
  hosts: string[]
  status: RequestStatus
  created_at: ISODateTime
  updated_at: ISODateTime
  decided_by: string | null
  decided_at: ISODateTime | null
  /** legacy: the single job of an approved request */
  job_id: number | null
  /** the scoped jobs of the assignment, one per host */
  jobs: { host: string; job_id: number; status: JobStatus }[]
  /** the admin's reason for a rejection (退回) */
  reject_reason: string | null
}

export interface RegisterPage {
  registration: AccountRequest | null
  can_register: boolean
}

export interface RegisterInput extends Needs {
  name: string
  username: string
}

export interface HostRequestPage {
  requests: AccountRequest[]
  can_request: boolean
}

/** GET /api/admin/assign-hosts: one row per host for the assignment picker. */
export interface AssignHost {
  name: string
  group: string
  monitored: boolean
  up: boolean | null
  gpu_summary: string | null
  gpu_count: number | null
  gpu_vram_gb: number | null
  /** idle cards now (as on the GPU board); null = no live data */
  gpus_free: number | null
  gpu_util_avg: number | null
  /** active accounts on the host */
  users: number
  primary_users: { username: string; name: string | null }[]
  root_free_bytes: number | null
  data_free_bytes: number | null
  /** the person (?person_id=) already has this host */
  granted: boolean
  /** why an assignment there would fail (never collected / down); null = assignable */
  blocked: string | null
}

export interface AssignHosts {
  metrics_ok: boolean
  hosts: AssignHost[]
}

export interface AssignInput {
  person_id?: number | null
  username?: string | null
  hosts: string[]
}

export interface AssignResult {
  person_id: number
  jobs: { host: string; job_id: number }[]
}

// ---- Admin: accounts / people -------------------------------------------

export type AccountTab = 'all' | 'drift' | 'uid' | 'idle' | 'unmanaged'

export interface AdminAccountRow extends HostAccount {
  host: string
  expected_uid: number | null
  drift: string[]
}

export interface UidConflict {
  kind: 'same_name' | 'same_uid'
  key: string
  entries: { host: string; username: string; uid: number | null }[]
}

export interface AdminAccounts {
  tab: AccountTab
  rows: AdminAccountRow[]
  conflicts: UidConflict[]
}

/** GET /api/admin/accounts/suggestions: same name, same uid everywhere, uid used by no other name. */
export interface AdoptGroup {
  username: string
  uid: number
  hosts: string[]
  last_active: string | null
  existing_person: PersonRef | null
}

export interface AdoptConflict {
  username: string
  reason: string
  entries: { host: string; uid: number | null }[]
}

export interface AdoptSuggestions {
  groups: AdoptGroup[]
  conflicts: AdoptConflict[]
}

export interface AdoptBulkResult {
  adopted: { username: string; person_id: number; hosts: string[] }[]
  errors: { username: string; error: string }[]
}

export type HealthStatus = 'ok' | 'warn' | 'bad' | 'unknown'
export type HealthKey =
  | 'reachable'
  | 'collect_age'
  | 'apt'
  | 'reboot_required'
  | 'disk_root'
  | 'disk_any'
  | 'smart'
  | 'gpu_missing'
  | 'driver_drift'
  | 'os_eol'

export interface HealthCheck {
  key: HealthKey
  status: HealthStatus
  label: string
  detail: string
}

export interface HostHealth {
  host: string
  group: string
  checks: HealthCheck[]
}

/** GET /api/admin/health */
export interface HealthBoard {
  updated_at: string
  metrics_ok: boolean
  fleet_driver: string | null
  hosts: HostHealth[]
}

export interface Person extends User {
  uid: number | null
  created_at: ISODateTime
  hosts_count: number
  /** 移除成員: when an admin removed (offboarded) this person; null = not removed */
  removed_at: ISODateTime | null
}

/** 移除成員: one choice per host account (POST /api/admin/people/{id}/remove). */
export interface RemoveHostChoice {
  host: string
  action: 'lock' | 'delete'
  remove_home: boolean
  confirm: string
}

export interface RemovePersonResult {
  person: Person
  jobs: { host: string; action: 'lock' | 'delete'; job_id: number }[]
}

export interface PersonDetail {
  person: Person
  accounts: MyAccount[]
  keys: SshKey[]
  hosts: { name: string; group: string; granted: boolean; exists: boolean }[]
}

/** The role is not editable here: POST /api/admin/people/{id}/promote; demotion only with the server CLI. */
export interface PersonInput {
  name: string | null
  email: string | null
  sso_id: string | null
  expires_at: ISODate | null
  status: PersonStatus
}

export interface JobIdMaybe {
  job_id: number | null
}

// ---- Admin: jobs ---------------------------------------------------------

/** check_failed: the users preview itself failed (預檢失敗), nothing to confirm */
export type JobStatus = 'queued' | 'awaiting' | 'confirmed' | 'running' | 'ok' | 'failed' | 'cancelled' | 'check_failed'
/** power, shutdown, bmc_check: removed kinds, only in the job history */
export type JobKind = 'collect' | 'agents' | 'users' | 'power' | 'shutdown' | 'bmc_check' | (string & {})

export interface Job {
  id: number
  kind: JobKind
  target_hosts: string[]
  status: JobStatus
  actor: string | null
  created_at: ISODateTime
  run_at: ISODateTime | null
  finished_at: ISODateTime | null
  auto_confirm: boolean
  /** in human terms, e.g. 指派 xiaoming @gpu01 */
  summary: string
  /** an assignment's job: one account on one host, applied without a preview */
  scoped: boolean
}

export interface JobDetail extends Job {
  args: Record<string, unknown> | null
  check_output: string | null
  output: string | null
  /** plain-language summary of a failed job / preview; null otherwise */
  failure: string | null
}

// ---- Admin: audit -------------------------------------------------------

export interface AuditPage {
  rows: { ts: ISODateTime; actor: string | null; action: string; target: string | null; detail: Record<string, unknown> | null }[]
  page: number
  has_more: boolean
}

// ---- Guide / calendar ----------------------------------------------------

export interface GuideMeta {
  updated_at: ISODateTime | null
  updated_by: string | null
  is_default: boolean
}

export interface Guide extends GuideMeta {
  /** Markdown with {{placeholders}} already filled in. */
  markdown: string
  /** Members-only part; null for applicants / inactive accounts, or when empty. */
  members_markdown: string | null
}

export interface AdminGuide extends GuideMeta {
  source: string
  default: string
  placeholders: Record<string, string>
  members_source: string
}

export interface CalendarData {
  start: ISODate
  end: ISODate
  events: Announcement[]
  subscribe_url: string
}
