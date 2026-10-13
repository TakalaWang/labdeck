import {
  type DB, KEY_TYPES, type Row, STATUS, ValueErr, config, describeJob, failureSummary, hostStatus, inventory, iso, PromError, pyRound,
} from '@labdeck/core'
import { HttpError } from './http.ts'

// JSON shapes of docs/api.md built from DB rows.

const USER_FIELDS = ['id', 'username', 'name', 'email', 'sso_id', 'role', 'status', 'expires_at'] as const

export function userJson(p: Row) {
  return Object.fromEntries(USER_FIELDS.map((k) => [k, p[k] ?? null]))
}

// shutdown_job_id / shutdown_cancel* of announcements made before scheduled shutdowns were removed are no longer read.
export const ANN_SQL = 'SELECT a.* FROM announcements a'

/** Announcement (api.md). */
export function annJson(a: Row) {
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    starts_at: iso(a.starts_at),
    ends_at: iso(a.ends_at),
    created_by: a.created_by,
    hosts: a.hosts ? String(a.hosts).split(',') : [],
  }
}

export function currentAnnouncements(con: DB, now: string) {
  return con.all(`${ANN_SQL} WHERE a.ends_at IS NULL OR a.ends_at >= ? ORDER BY a.id DESC`, now).map(annJson)
}

/** gpuBoard's hosts: [name, group, GPUs the last collect saw] of the monitored hosts. */
export function monitored(con: DB): [string, string, number][] {
  return con.all('SELECT name, group_name, facts_json FROM hosts WHERE monitored=1 ORDER BY group_name, name').map((r) => {
    const f = JSON.parse(r.facts_json || '{}')
    return [r.name, r.group_name, Math.max((f.gpus || []).length, f.gpu_pci_count || 0)]
  })
}

export function hostJson(r: Row): Record<string, any> {
  const f = r.facts_json ? JSON.parse(r.facts_json) : {}
  const gpus: Record<string, unknown>[] = f.gpus || []
  const models = new Map<string, number>()
  for (const g of gpus) {
    const m = String(g.name ?? '?').replace('NVIDIA ', '').replace('GeForce ', '')
    models.set(m, (models.get(m) ?? 0) + 1)
  }
  // The IPMI / shutdown columns (bmc_*, console, boot_risk, no_shutdown) are no longer read (remote power control removed).
  return {
    name: r.name, address: r.address, group: r.group_name, monitored: Boolean(r.monitored),
    room: r.room, rack: r.rack, psu: r.psu, notes: r.notes, ssh_no_retry: Boolean(r.ssh_no_retry), facts_at: iso(r.facts_at),
    os: f.os ?? null, kernel: f.kernel ?? null, cpu_model: f.cpu_model ?? null, cpu_count: f.cpu_count ?? null,
    mem_gb: f.mem_mb ? pyRound(f.mem_mb / 1024, 1) : null,
    nvidia_driver: f.nvidia_driver ?? null, cuda: f.cuda ?? null,
    gpu_summary: [...models].map(([m, n]) => `${n}× ${m}`).join(', ') || null,
    gpu_count: r.facts_at ? gpus.length : null, // never collected: unknown, not "no GPU"
    gpu_pci_count: f.gpu_pci_count ?? null,
    disk_count: r.facts_at ? (f.disks || []).length : null,
  }
}

/** {host: primary users} (managed accounts flagged by an admin), by username. */
export function primaryUsers(con: DB): Map<string, { username: string; name: string | null }[]> {
  const primary = new Map<string, { username: string; name: string | null }[]>()
  for (const a of con.all(`SELECT a.host, a.username, p.name FROM accounts a JOIN people p ON p.id = a.person_id
                           WHERE a.managed = 1 AND a.primary_user = 1 ORDER BY a.host, a.username`)) {
    if (!primary.has(a.host)) primary.set(a.host, [])
    primary.get(a.host)!.push({ username: a.username, name: a.name })
  }
  return primary
}

/** [Host] with live status; a Prometheus outage only nulls the status. */
export async function hostList(con: DB, name: string | null = null) {
  const rows = con.all('SELECT * FROM hosts WHERE ? IS NULL OR name = ? ORDER BY group_name, name', name, name)
  let st: Awaited<ReturnType<typeof hostStatus>> | null
  try {
    st = rows.some((r) => r.monitored) ? await hostStatus() : new Map()
  } catch (e) {
    if (!(e instanceof PromError)) throw e
    st = null
  }
  const primary = primaryUsers(con)
  const empty = () => Object.fromEntries(STATUS.map((k) => [k, null]))
  return rows.map((r) => ({
    ...hostJson(r),
    status: r.monitored && st !== null ? (st.get(r.name) ?? empty()) : null,
    primary_users: primary.get(r.name) ?? [],
  }))
}

export function storedHost(con: DB, name: string): Row {
  const h = con.get('SELECT * FROM hosts WHERE name=?', name)
  if (!h) throw new HttpError(404, '找不到主機')
  return h
}

export const ACCOUNT_SQL = `SELECT a.*, p.username AS person_username, p.name AS person_name, p.discord_name AS person_discord,
                        MAX(COALESCE(a.last_login, 0), COALESCE(a.home_mtime, 0), COALESCE((SELECT MAX(ts) FROM logins l
                            WHERE l.host = a.host AND l.username = a.username), 0)) AS last_active
                 FROM accounts a LEFT JOIN people p ON p.id = a.person_id`
export const HOST_ACCOUNT = ['username', 'uid', 'exists', 'locked', 'expires', 'last_active', 'managed', 'desired', 'primary', 'person',
  'reserved']
export const MY_ACCOUNT = ['host', 'username', 'uid', 'exists', 'locked', 'expires', 'last_active', 'desired', 'primary']
export const ADMIN_ACCOUNT = ['host', 'username', 'uid', 'expected_uid', 'exists', 'locked', 'expires', 'last_active', 'managed',
  'desired', 'person', 'drift', 'reserved']

/** Job statuses that will still change on their own. */
export const JOB_LIVE = new Set(['queued', 'awaiting', 'confirmed', 'running'])

/** Why a managed account differs from its desired state; empty = in sync. */
function drift(a: Row): string[] {
  if (!a.managed) return []
  const exists = a.exists_on_host
  const locked = a.observed_locked
  const want = a.desired
  const out: string[] = []
  if (want === 'present' && !exists) out.push('主機上不存在')
  if (want === 'present' && exists && locked) out.push('應開通但已鎖定')
  if (want === 'locked' && exists && !locked) out.push('應停用但未鎖定')
  if (want === 'absent' && exists) out.push('待刪除')
  if (exists && a.uid !== a.expected_uid) out.push('uid 與認領時不同')
  return out
}

export function accountJson(a: Row, fields: string[]): Record<string, any> {
  const full: Record<string, any> = {
    host: a.host, username: a.username, uid: a.uid, expected_uid: a.expected_uid,
    exists: Boolean(a.exists_on_host), locked: Boolean(a.observed_locked), expires: a.observed_expires,
    last_active: iso(a.last_active), managed: Boolean(a.managed), desired: a.desired,
    person: a.person_id ? { id: a.person_id, username: a.person_username } : null,
    primary: Boolean(a.managed && a.primary_user), drift: drift(a),
    reserved: config.reserved.has(a.username), // root, the bot, RESERVED_USERS: never adopted, edited or deleted
  }
  return Object.fromEntries(fields.map((k) => [k, full[k] ?? null]))
}

/** HostDetail.accounts[]: the person's name and Discord name only for admins, or for a primary user of the host. */
export function hostAccount(a: Row, isAdmin: boolean) {
  const out = accountJson(a, HOST_ACCOUNT)
  if (out.person && (isAdmin || out.primary)) out.person = { ...out.person, name: a.person_name, discord_name: a.person_discord }
  return out
}

export function keyJson(k: Row) {
  const [kind, ...rest] = String(k.pubkey).split(' ')
  return {
    id: k.id, fingerprint: k.fingerprint, type: KEY_TYPES[kind] ?? null,
    comment: rest.slice(1).join(' ') || null, state: k.state, added_at: iso(k.added_at),
  }
}

/**
 * A person's accounts and keys (/api/me, the person page). `address`: the host's, for the account owner's ssh
 * command; `job_status`: the latest assignment job of that host for this person (null = never assigned there).
 */
export function accountsAndKeys(con: DB, pid: number) {
  const jobs = new Map(con.all(`SELECT s.host, j.status FROM assignments s JOIN jobs j ON j.id = s.job_id
                                WHERE s.person_id = ? ORDER BY s.id`, pid).map((r) => [r.host as string, r.status as string]))
  const address = new Map(con.all('SELECT name, address FROM hosts').map((h) => [h.name as string, h.address as string]))
  return {
    accounts: con.all(`${ACCOUNT_SQL} WHERE a.person_id=? ORDER BY a.host`, pid).map((a) => ({
      ...(accountJson(a, MY_ACCOUNT) as { host: string; desired: string; exists: boolean }),
      address: address.get(a.host) ?? null,
      job_status: jobs.get(a.host) ?? null,
    })),
    keys: con.all('SELECT * FROM ssh_keys WHERE person_id=? ORDER BY state, id DESC', pid).map(keyJson),
  }
}

/** Request (api.md 待指派): a registration or a member's host request, with the jobs of its assignment. */
export function requestJson(con: DB, r: Row) {
  const jobs = con.all(`SELECT s.host, s.job_id, j.status FROM assignments s JOIN jobs j ON j.id = s.job_id
                        WHERE s.request_id=? ORDER BY s.id`, r.id)
  return {
    id: r.id, kind: r.kind, person_id: r.person_id, sso_id: r.sso_id, email: r.email, name: r.name ?? null, username: r.username,
    purpose: r.reason, gpus: r.gpus ?? null, min_vram_gb: r.min_vram_gb ?? null, until: r.expected_end ?? null,
    hosts: JSON.parse(r.hosts_json), status: r.status, created_at: iso(r.created_at), updated_at: iso(r.updated_at ?? r.created_at),
    decided_by: r.decided_by, decided_at: iso(r.decided_at), job_id: r.job_id ?? null,
    reject_reason: r.status === 'rejected' ? (r.decision_note ?? null) : null,
    jobs: jobs.map((j) => ({ host: j.host, job_id: j.job_id, status: j.status })),
  }
}

export function jobJson(j: Row, detail = false) {
  const args = JSON.parse(j.args_json)
  const th = args.target_hosts // "all" (the scheduler's daily collect) → [] = every host
  const out = {
    id: j.id, kind: j.kind, target_hosts: th === 'all' ? [] : String(th).split(','), status: j.status, actor: j.actor,
    created_at: iso(j.created_at), run_at: iso(j.run_at), finished_at: iso(j.finished_at), auto_confirm: Boolean(j.auto_confirm),
    summary: describeJob(j.kind, args, Boolean(j.auto_confirm)),
    scoped: typeof args.only_user === 'string', // an assignment's job: one account on one host, no preview
  }
  if (!detail) return out
  const failure = j.status === 'check_failed' ? failureSummary(j.check_output, true) : j.status === 'failed' ? failureSummary(j.output) : null
  return { ...out, args, check_output: j.check_output, output: j.output, failure }
}

/** The chosen hosts in inventory order; all must exist. */
export function knownHosts(con: DB, names: string[]): string[] {
  const inv = inventory(con)
  if (!names.length || names.some((h) => !inv.has(h))) throw new ValueErr('請選擇主機')
  return [...inv.keys()].filter((h) => names.includes(h))
}

/** A CSV download (UTF-8 BOM for Excel); cells that a spreadsheet would read as formulas are escaped. */
export function csvResponse(filename: string, header: string[], rows: unknown[][]): Response {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? '1' : '0') : String(v)
    if (['=', '+', '-', '@', '\t', '\r'].includes(s.slice(0, 1))) s = `'${s}`
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  const text = [header, ...rows].map((r) => `${r.map(cell).join(',')}\r\n`).join('')
  return new Response(`\ufeff${text}`, {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` },
  })
}

