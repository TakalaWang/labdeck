import { randomBytes } from 'node:crypto'
import { normalizeNetwork } from './net.ts'
import { ValueErr } from './util.ts'

// 約定 B: settings from the environment (.env through compose). Empty values count as unset.
// `config` is one mutable object so tests can change a setting the way the old tests patched module globals.

function env(name: string, fallback = ''): string {
  return process.env[name] || fallback
}

function int(name: string, fallback: string): number {
  const v = env(name, fallback)
  if (!/^[+-]?\d+$/.test(v.trim())) throw new Error(`invalid ${name} ${JSON.stringify(v)}`)
  return Number(v)
}

export const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/
export const SSO_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * The only playbooks the runner will ever execute (relative to the ansible dir). Jobs of removed kinds
 * (power, shutdown, bmc_check: remote power control, removed for now) stay in the DB for the job history,
 * but validateJob and the runner refuse them.
 */
export const PLAYBOOKS: Record<string, string> = {
  collect: 'playbooks/collect.yaml',
  agents: 'playbooks/monitoring_agents.yaml',
  users: 'playbooks/users.yaml',
}

/** Signs sessions and calendar tokens. Production refuses to start without a real one (next build excepted). */
function sessionSecret(): string {
  const v = env('SESSION_SECRET')
  if (process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build' && v.length < 32) {
    throw new Error('SESSION_SECRET 未設定或少於 32 字元（產生方式：openssl rand -base64 48 | tr -d \'\\n\'）')
  }
  return v || randomBytes(32).toString('base64url') // dev/test only: sessions reset on restart
}

export function loadConfig() {
  const dataDir = env('DATA_DIR', '/data')
  const repoDir = env('REPO_DIR', '/repo')
  const botUser = env('BOT_USER', 'labbot')
  if (!USERNAME_RE.test(botUser)) throw new Error(`BOT_USER 不合法：${JSON.stringify(botUser)}`) // goes into -e ansible_user=
  const nodeExporterPort = int('NODE_EXPORTER_PORT', '9100')
  if (!(nodeExporterPort >= 1 && nodeExporterPort <= 65535)) throw new Error(`invalid NODE_EXPORTER_PORT ${nodeExporterPort}`)
  let monitoringSource = env('MONITORING_SOURCE')
  try {
    monitoringSource = monitoringSource && normalizeNetwork(monitoringSource)
  } catch {
    throw new Error(`invalid MONITORING_SOURCE ${JSON.stringify(monitoringSource)}`)
  }
  const smtpUser = env('SMTP_USER')
  const smtpSecurity = env('SMTP_SECURITY', 'starttls')
  if (!['starttls', 'ssl', 'none'].includes(smtpSecurity)) throw new Error(`invalid SMTP_SECURITY ${JSON.stringify(smtpSecurity)}`)
  if (smtpSecurity === 'none' && smtpUser) {
    throw new Error('SMTP_SECURITY=none cannot be used with SMTP_USER (the password would travel in clear text)')
  }
  const reserved = new Set(['root', botUser, ...env('RESERVED_USERS').split(',').map((u) => u.trim()).filter(Boolean)])
  return {
    dataDir,
    /** Not under /data in the container: a named volume nested in another one races on first start. */
    promSdDir: env('PROM_SD_DIR', `${dataDir}/prom_sd`),
    dbPath: `${dataDir}/portal.db`,
    collectDir: `${dataDir}/collect`,
    jobsDir: `${dataDir}/jobs`,
    backupDir: `${dataDir}/backup`,
    /** Ansible inventory written by the runner from the hosts table (約定 C). */
    inventoryPath: env('INVENTORY_PATH', `${dataDir}/inventory.json`),
    repoDir,
    ansibleDir: `${repoDir}/ansible`,
    publicUrl: env('PUBLIC_URL', 'http://localhost:8000').replace(/\/+$/, ''),
    prometheusUrl: env('PROMETHEUS_URL', 'http://prometheus:9090').replace(/\/+$/, ''),
    discordWebhookUrl: env('DISCORD_WEBHOOK_URL'),
    siteName: env('SITE_NAME', 'LabDeck'),
    sessionSecret: sessionSecret(),
    oauthName: env('OAUTH_NAME', 'NYCU'),
    oauthClientId: env('OAUTH_CLIENT_ID'),
    oauthClientSecret: env('OAUTH_CLIENT_SECRET'),
    oauthAuthorizeUrl: env('OAUTH_AUTHORIZE_URL', 'https://id.nycu.edu.tw/o/authorize/'),
    oauthTokenUrl: env('OAUTH_TOKEN_URL', 'https://id.nycu.edu.tw/o/token/'),
    oauthProfileUrl: env('OAUTH_PROFILE_URL', 'https://id.nycu.edu.tw/api/profile/'),
    oauthScope: env('OAUTH_SCOPE', 'profile'),
    oauthIdField: env('OAUTH_ID_FIELD', 'username'),
    oauthEmailField: env('OAUTH_EMAIL_FIELD', 'email'),
    botUser,
    reserved,
    uidMin: int('UID_MIN', '20000'),
    uidMax: int('UID_MAX', '29999'),
    dataMountGlob: env('DATA_MOUNT_GLOB', '/data*'),
    nodeExporterPort,
    monitoringSource,
    // personal notifications (api.md 個人通知)
    discordClientId: env('DISCORD_CLIENT_ID'),
    discordClientSecret: env('DISCORD_CLIENT_SECRET'),
    discordAuthorizeUrl: env('DISCORD_AUTHORIZE_URL', 'https://discord.com/oauth2/authorize'),
    discordTokenUrl: env('DISCORD_TOKEN_URL', 'https://discord.com/api/oauth2/token'),
    discordProfileUrl: env('DISCORD_PROFILE_URL', 'https://discord.com/api/users/@me'),
    smtpHost: env('SMTP_HOST'),
    smtpPort: int('SMTP_PORT', '587'),
    smtpSecurity: smtpSecurity as 'starttls' | 'ssl' | 'none',
    smtpUser,
    smtpPassword: env('SMTP_PASSWORD'),
    smtpFrom: env('SMTP_FROM', smtpUser),
    /** Owners in /api/metrics/disk/trend. */
    trendTop: 10,
  }
}

export type Config = ReturnType<typeof loadConfig>

export const config: Config = loadConfig()

export function validUsername(u: unknown): u is string {
  return typeof u === 'string' && USERNAME_RE.test(u) && !config.reserved.has(u)
}

/** A new Linux username (registration, 建立新帳號): ValueErr with the reason, a reserved name told apart. */
export function checkNewUsername(u: string): void {
  if (!USERNAME_RE.test(u)) throw new ValueErr('帳號名稱需為小寫英文開頭，只含小寫英數字、_、-，最多 32 字')
  if (config.reserved.has(u)) throw new ValueErr(`${u} 是保留名稱，請換一個`)
}
