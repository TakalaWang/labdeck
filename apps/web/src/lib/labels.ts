import type { AccountTab, Desired, HealthStatus, JobStatus, RequestStatus } from '@/lib/types'

export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'crit' | 'muted'

export const JOB_STATUS: Record<JobStatus, { label: string; tone: Tone }> = {
  queued: { label: '排隊中', tone: 'info' },
  awaiting: { label: '待確認', tone: 'warn' },
  confirmed: { label: '已確認', tone: 'info' },
  running: { label: '執行中', tone: 'info' },
  ok: { label: '成功', tone: 'ok' },
  failed: { label: '失敗', tone: 'crit' },
  cancelled: { label: '已取消', tone: 'muted' },
  check_failed: { label: '預檢失敗', tone: 'crit' },
}

/** Job statuses that change on their own and should be polled. */
export const JOB_LIVE: JobStatus[] = ['queued', 'confirmed', 'running']

export const JOB_KIND: Record<string, string> = {
  collect: '收集資料',
  agents: '安裝監控',
  users: '帳號同步',
  // removed with remote power control; old jobs still show in the history
  power: '電源控制（已停用）',
  shutdown: '排程關機（已停用）',
  bmc_check: '檢查 IPMI（已停用）',
}

/** Days without login or activity after which an account counts as idle (主機帳號「閒置」分頁的預設值). */
export const ACCOUNT_IDLE_DAYS = 365

/** accounts.desired as shown to admins */
export const DESIRED_LABEL: Record<Desired, string> = { present: '開通', locked: '停用', absent: '刪除' }

export const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: Tone }> = {
  pending: { label: '等待指派', tone: 'warn' },
  approved: { label: '已指派', tone: 'ok' },
  rejected: { label: '已退回', tone: 'crit' },
}

/** The badge of a request: an approved registration linked to an existing person without hosts is 已連結. */
export function requestStatus(r: { status: RequestStatus; hosts: string[] }): { label: string; tone: Tone } {
  return r.status === 'approved' && r.hosts.length === 0 ? { label: '已連結', tone: 'ok' } : REQUEST_STATUS[r.status]
}

/** Audit action codes in words (the code stays in a tooltip). Unknown codes (older versions) show as they are. */
export const AUDIT_ACTION: Record<string, string> = {
  account_delete: '刪除主機帳號',
  add_admin: '新增管理員（伺服器指令）',
  admin_demote: '移除管理員（伺服器指令）',
  adopt: '認領帳號',
  announce: '發布公告',
  discord_link: '連結 Discord',
  discord_unlink: '解除 Discord',
  enqueue: '排入工作',
  expiry_reminder: '到期提醒',
  grant: '開通主機',
  revoke: '停用主機帳號',
  guide_update: '編輯指南',
  host_add: '新增主機',
  host_delete: '刪除主機',
  host_edit: '編輯主機',
  host_monitored: '列入監控',
  host_request: '申請主機',
  job_cancel: '取消工作',
  job_confirm: '確認工作',
  job_rerun: '重新執行工作',
  key_add: '新增 SSH 金鑰',
  key_revoke: '撤銷 SSH 金鑰',
  notify_email: '變更通知 Email',
  notify_email_code: '寄送 Email 驗證碼',
  notify_prefs: '變更通知設定',
  person_create: '建立人員',
  person_promote: '設為管理員',
  person_update: '編輯人員',
  primary_import: '匯入主要使用者',
  primary_set: '設定主要使用者',
  register: '登記',
  register_update: '修改登記',
  request_assign: '指派',
  request_reject: '退回',
  sso_link: '連結 SSO 身分',
  temp_password_ack: '已記下臨時密碼',
}

/** Linux usernames the portal manages (USERNAME_RE in packages/core; reserved names are checked by the API). */
export const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/

/** /admin/accounts tabs: the API's tabs plus 建議認領 (its own endpoint). */
export type AccountsPageTab = AccountTab | 'suggest'

export const ACCOUNT_TABS: { id: AccountsPageTab; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'drift', label: '漂移' },
  { id: 'uid', label: 'UID 衝突' },
  { id: 'idle', label: '閒置' },
  { id: 'unmanaged', label: '未認領' },
  { id: 'suggest', label: '建議認領' },
]

export const HEALTH_STATUS: Record<HealthStatus, { label: string; tone: Tone }> = {
  bad: { label: '異常', tone: 'crit' },
  warn: { label: '注意', tone: 'warn' },
  unknown: { label: '未知', tone: 'muted' },
  ok: { label: '正常', tone: 'ok' },
}

export const ROLE_LABEL = { admin: '管理員', member: '成員' } as const
export const PERSON_STATUS_LABEL = { active: '啟用', locked: '鎖定' } as const

/** Usage level → tone for resource bars (CPU/MEM/disk). */
export function levelTone(pct: number | null | undefined): Tone {
  if (pct === null || pct === undefined) return 'muted'
  if (pct >= 90) return 'crit'
  if (pct >= 75) return 'warn'
  return 'info'
}

export const TONE_COLOR: Record<Tone, string> = {
  neutral: 'var(--foreground)',
  info: 'var(--primary)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  crit: 'var(--destructive)',
  muted: 'var(--muted-foreground)',
}
