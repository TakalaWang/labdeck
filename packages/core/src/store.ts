import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { config, validUsername } from './config.ts'
import type { DB, Row } from './db.ts'
import { checkHostNames, inventory } from './inventory.ts'
import { now } from './time.ts'
import { Conflict, ValueErr, cmp, jsonEqual, pyJson, sortBy } from './util.ts'
import { type HostIn, validateJob } from './validate.ts'

// Accounts, jobs and ingest: the state changes web and runner share (約定 F). Callers own the transaction.

export function audit(con: DB, actor: string, action: string, target: string | null, detail?: Record<string, unknown> | null): void {
  con.run(
    'INSERT INTO audit(ts, actor, action, target, detail_json) VALUES (?,?,?,?,?)',
    now(),
    actor,
    action,
    target,
    pyJson(detail ?? {}, { sortKeys: true, ensureAscii: false }),
  )
}

/** Insert validated hosts, skipping names that already exist. Returns [added, skipped] names. */
export function addHosts(con: DB, actor: string, hosts: HostIn[]): [string[], string[]] {
  const existing = new Set(con.all<{ name: string }>('SELECT name FROM hosts').map((r) => r.name))
  const added = hosts.filter((h) => !existing.has(h.name))
  for (const given of added) {
    const h: Record<string, any> = { ssh_no_retry: 0, room: null, rack: null, psu: null, notes: null, ...given }
    // The IPMI / shutdown columns (bmc_*, console, boot_risk, no_shutdown) stay in the schema but are no longer written.
    con.run(
      `INSERT INTO hosts(name, address, group_name, room, rack, psu, notes, ssh_no_retry, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      h.name, h.address, h.group_name, h.room, h.rack, h.psu, h.notes, h.ssh_no_retry, now(),
    )
    audit(con, actor, 'host_add', h.name, h)
  }
  checkHostNames(con)
  return [added.map((h) => h.name), hosts.filter((h) => existing.has(h.name)).map((h) => h.name)]
}

export const allocator = {
  /** The lowest free UID in UID_MIN–UID_MAX (people, observed and adopted accounts). Replaceable in tests. */
  allocUid(con: DB): number {
    const used = new Set(
      con
        .all<{ uid: number | null }>('SELECT uid FROM people UNION SELECT uid FROM accounts UNION SELECT expected_uid FROM accounts')
        .map((r) => r.uid),
    )
    for (let u = config.uidMin; u <= config.uidMax; u++) if (!used.has(u)) return u
    throw new ValueErr(`UID ${config.uidMin}–${config.uidMax} 已用完`)
  },
}

export function allocUid(con: DB): number {
  return allocator.allocUid(con)
}

export type JobArgs = Record<string, unknown> & { target_hosts: string }

export function enqueue(con: DB, actor: string, kind: string, args: JobArgs, runAt?: string | null, autoConfirm = false): number {
  validateJob(kind, args, con)
  const t = now()
  const id = con.run(
    'INSERT INTO jobs(kind, args_json, actor, run_at, auto_confirm, created_at) VALUES (?,?,?,?,?,?)',
    kind, pyJson(args, { ensureAscii: false }), actor, runAt || t, autoConfirm ? 1 : 0, t,
  ).lastInsertRowid
  audit(con, actor, 'enqueue', `job/${id}`, { kind, target_hosts: args.target_hosts, run_at: runAt ?? null })
  return id
}

// --- account management ----------------------------------------------------------------

export type UserEntry = {
  username: string
  uid: number
  state: string
  expires: string | null
  keys_add: string[]
  keys_remove: string[]
  /** state absent only: also remove the home directory */
  remove_home?: boolean
}
type Keys = Map<number, { active: string[]; revoked: string[] }>

/**
 * users job.json (約定 F) from account rows joined with people.expires_at.
 * rows: host, username, expected_uid, desired, managed, person_id, remove_home, expires_at. Never includes temp_password.
 * A row without a person counts only when it is to be deleted (an old account nobody was assigned).
 */
export function usersPayload(rows: Row[], keys: Keys): { target_hosts: string; accounts: Record<string, UserEntry[]> } {
  const accounts: Record<string, UserEntry[]> = {}
  const order: string[] = []
  for (const r of sortBy(rows, (r) => [r.host, r.username])) {
    if (!r.managed || (!r.person_id && r.desired !== 'absent')) continue
    const k = r.desired === 'present' ? keys.get(r.person_id) : undefined
    if (!(r.host in accounts)) {
      accounts[r.host] = []
      order.push(r.host)
    }
    const absent = r.desired === 'absent'
    accounts[r.host].push({
      username: r.username,
      uid: r.expected_uid,
      state: r.desired,
      expires: absent ? null : (r.expires_at ?? null),
      keys_add: [...(k?.active ?? [])],
      keys_remove: [...(k?.revoked ?? [])],
      ...(absent ? { remove_home: Boolean(r.remove_home) } : {}),
    })
  }
  return { target_hosts: order.join(','), accounts }
}

const USERS_SQL = `SELECT a.host, a.username, a.expected_uid, a.desired, a.managed, a.person_id, a.remove_home, p.expires_at
                   FROM accounts a LEFT JOIN people p ON p.id = a.person_id WHERE a.managed = 1`
/** An account already deleted (or never created) that is still marked absent: nothing left to do. */
const NOT_GONE = " AND NOT (a.desired = 'absent' AND a.exists_on_host = 0)"
export const STALE_USERS_JOB = '狀態已變更，請重新同步後再確認'

/** usersPayload's keys argument from the ssh_keys table. */
export function personKeys(con: DB): Keys {
  const keys: Keys = new Map()
  for (const k of con.all('SELECT person_id, pubkey, state FROM ssh_keys ORDER BY id')) {
    if (!keys.has(k.person_id)) keys.set(k.person_id, { active: [], revoked: [] })
    keys.get(k.person_id)![k.state as 'active' | 'revoked'].push(k.pubkey)
  }
  return keys
}

/** Queue a users job for one person (or everyone). keyOnly → existing, present accounts, auto-confirmed. */
export function enqueueUsers(con: DB, actor: string, personId: number | null = null, keyOnly = false): number | null {
  let q = USERS_SQL + NOT_GONE
  const params: number[] = []
  if (personId !== null) {
    q += ' AND a.person_id = ?'
    params.push(personId)
  }
  if (keyOnly) q += " AND a.exists_on_host = 1 AND a.desired = 'present'"
  const inv = inventory(con)
  const rows = con.all(q, ...params).filter((r) => inv.has(r.host))
  const payload = usersPayload(rows, personKeys(con))
  if (!Object.keys(payload.accounts).length) return null
  return enqueue(con, actor, 'users', payload, null, keyOnly)
}

/**
 * Queue a users job for one person's account on one host only (only_user), auto-confirmed, and record the admin's
 * assignment behind it: the runner skips the preview only for a job with that record, and the playbook ignores
 * every other account, so no other pending change on that host is applied.
 */
export function enqueueHostAccount(
  con: DB, actor: string, personId: number, host: string, requestId: number | null = null,
): number | null {
  const rows = con.all(`${USERS_SQL} AND a.person_id = ? AND a.host = ?`, personId, host)
  const payload = usersPayload(rows, personKeys(con))
  if (!inventory(con).has(host) || !Object.keys(payload.accounts).length) return null
  const job = enqueue(con, actor, 'users', { ...payload, only_user: rows[0].username }, null, true)
  con.run('INSERT INTO assignments(job_id, person_id, host, request_id, actor, created_at) VALUES (?,?,?,?,?,?)',
    job, personId, host, requestId, actor, now())
  return job
}

/**
 * An admin assigns hosts to a person (待指派 or quick assign): grant each one and queue one scoped, auto-confirmed
 * job per host. A host the person already has, or one that can't be granted, fails the whole call (caller's tx).
 */
export function assignHosts(
  con: DB, actor: string, personId: number, hosts: string[], requestId: number | null = null,
): { host: string; job_id: number }[] {
  const inv = inventory(con)
  if (!hosts.length || new Set(hosts).size !== hosts.length) throw new ValueErr('請選擇主機')
  const jobs: { host: string; job_id: number }[] = []
  for (const h of hosts) {
    if (!inv.has(h)) throw new ValueErr(`主機不存在：${h}`)
    if (con.get("SELECT 1 FROM accounts WHERE person_id=? AND host=? AND managed=1 AND desired='present'", personId, h)) {
      throw new ValueErr(`${h}：已經開通`)
    }
    try {
      grant(con, actor, personId, h, true)
    } catch (e) {
      if (e instanceof ValueErr) e.message = `${h}：${e.message}`
      throw e
    }
    jobs.push({ host: h, job_id: enqueueHostAccount(con, actor, personId, h, requestId)! })
  }
  return jobs
}

/**
 * Mark one account on one host for deletion (desired absent; an unassigned one becomes managed without a person)
 * and queue a users job for just that account. Never auto-confirmed: an admin confirms its preview.
 */
export function deleteAccount(con: DB, actor: string, host: string, username: string, removeHome: boolean): number {
  const a = con.get('SELECT * FROM accounts WHERE host=? AND username=?', host, username)
  if (!a || !a.exists_on_host) throw new ValueErr('主機上沒有這個帳號')
  if (!validUsername(username)) throw new ValueErr('保留帳號或名稱不合法的帳號不能刪除')
  const uid = a.managed ? a.expected_uid : a.uid
  if (!Number.isInteger(uid) || uid < 1000 || uid !== a.uid) throw new ValueErr('帳號 UID 與紀錄不符，請先處理 UID 衝突')
  con.run(
    "UPDATE accounts SET managed=1, desired='absent', remove_home=?, expected_uid=?, primary_user=0 WHERE host=? AND username=?",
    removeHome ? 1 : 0, uid, host, username,
  )
  audit(con, actor, 'account_delete', `${host}/${username}`, { remove_home: removeHome, person_id: a.person_id ?? null })
  const payload = usersPayload(con.all(`${USERS_SQL} AND a.host = ? AND a.username = ?`, host, username), personKeys(con))
  return enqueue(con, actor, 'users', payload)
}

/**
 * 重新執行 a failed job (or a failed preview): queue it again from the current DB, every rule checked again.
 * collect / agents: the same args (validated again). An assignment's job (only_user): a new assignment of the same
 * person and host, only while that person is active and still assigned there. Other users jobs: entries rebuilt for
 * the same (host, username)s; a previewed job is previewed again, a key-only (auto-confirmed) one stays key-only.
 */
export function rerunJob(con: DB, actor: string, j: Row): number {
  if (j.status !== 'failed' && j.status !== 'check_failed') throw new Conflict('只有失敗的工作可以重新執行')
  const args = JSON.parse(j.args_json)
  let id: number | null
  if (j.kind === 'collect' || j.kind === 'agents') {
    id = enqueue(con, actor, j.kind, args)
  } else if (j.kind === 'users' && typeof args.only_user === 'string') {
    const a = con.get('SELECT person_id, request_id FROM assignments WHERE job_id=?', j.id)
    const p = a ? con.get('SELECT * FROM people WHERE id=?', a.person_id) : undefined
    if (!a || !p || p.status !== 'active' || p.username !== args.only_user) throw new ValueErr('人員已停用或已變更，無法重新指派')
    if (!con.get("SELECT 1 FROM accounts WHERE person_id=? AND host=? AND managed=1 AND desired='present'", p.id, args.target_hosts)) {
      throw new ValueErr(`${p.username} 在 ${args.target_hosts} 已不是開通狀態，無法重新指派`)
    }
    id = enqueueHostAccount(con, actor, p.id, args.target_hosts, a.request_id ?? null)
  } else if (j.kind === 'users') {
    const inv = inventory(con)
    const only = j.auto_confirm ? " AND a.exists_on_host = 1 AND a.desired = 'present'" : NOT_GONE
    const rows = Object.entries(args.accounts as Record<string, UserEntry[]>)
      .flatMap(([host, entries]) => entries.map((e) => con.get(`${USERS_SQL}${only} AND a.host = ? AND a.username = ?`, host, e.username)))
      .filter((r): r is Row => r !== undefined && inv.has(r.host))
    const payload = usersPayload(rows, personKeys(con))
    if (!Object.keys(payload.accounts).length) throw new ValueErr('這些帳號已沒有需要套用的變更，請改用「同步」')
    id = enqueue(con, actor, 'users', payload, null, Boolean(j.auto_confirm))
  } else {
    throw new ValueErr('已停用的工作類型不能重新執行')
  }
  if (id === null) throw new ValueErr('主機已不在清冊中，無法重新執行')
  audit(con, actor, 'job_rerun', `job/${id}`, { from: j.id })
  return id
}

/**
 * True when a users job's entries differ from what the DB gives for the same (host, username) now,
 * e.g. a preview confirmed after a key was revoked or the person was locked.
 */
export function usersJobStale(con: DB, args: { accounts: Record<string, UserEntry[]> }): boolean {
  const keys = personKeys(con)
  for (const [host, entries] of Object.entries(args.accounts)) {
    for (const e of entries) {
      const r = con.get(`${USERS_SQL} AND a.host = ? AND a.username = ?`, host, e.username)
      if (!r || !jsonEqual(usersPayload([r], keys).accounts[host] ?? null, [e])) return true
    }
  }
  return false
}

/** Start managing one observed (host, username); link to personId or create a person. Returns person id. */
export function adopt(con: DB, actor: string, host: string, username: string, personId: number | null = null): number {
  const a = con.get('SELECT * FROM accounts WHERE host=? AND username=?', host, username)
  if (!a || !a.exists_on_host) throw new ValueErr('找不到該主機帳號')
  // an old account marked for deletion without a person (its preview cancelled) can still be adopted
  if (a.managed && !(a.person_id === null && a.desired === 'absent')) throw new Conflict('該帳號已受管理')
  if (!validUsername(username)) throw new ValueErr('帳號名稱不符規則或為保留帳號，無法管理')
  if (personId === null) {
    if (con.get('SELECT 1 FROM people WHERE username=?', username)) {
      throw new Conflict('已有同名人員；若為同一人請指定連結，否則需人工處理')
    }
    personId = con.run('INSERT INTO people(username, created_at) VALUES (?,?)', username, now()).lastInsertRowid
  }
  const p = con.get('SELECT * FROM people WHERE id=?', personId)
  if (!p) throw new ValueErr('人員不存在')
  if (con.get('SELECT 1 FROM accounts WHERE person_id=? AND host=? AND managed=1', personId, host)) {
    throw new Conflict('該人員在此主機已有受管帳號')
  }
  const desired = a.observed_locked || p.status === 'locked' ? 'locked' : 'present'
  con.run(
    'UPDATE accounts SET person_id=?, managed=1, expected_uid=uid, desired=?, remove_home=0 WHERE host=? AND username=?',
    personId, desired, host, username,
  )
  // people.uid := the one uid all adopted accounts share, unless another username uses it anywhere.
  const uids = new Set(
    con.all<{ u: number | null }>('SELECT expected_uid AS u FROM accounts WHERE person_id=? AND managed=1', personId).map((r) => r.u),
  )
  if (p.uid === null && uids.size === 1 && !uids.has(null)) {
    const uid = [...uids][0]
    const clash = con.get(
      `SELECT 1 FROM accounts WHERE (uid=? OR expected_uid=?)
         AND username NOT IN (SELECT username FROM accounts WHERE person_id=? AND managed=1)
       UNION ALL SELECT 1 FROM people WHERE uid=? AND id!=?`,
      uid, uid, personId, uid, personId,
    )
    if (!clash) con.run('UPDATE people SET uid=? WHERE id=?', uid, personId)
  }
  audit(con, actor, 'adopt', `${host}/${username}`, { person: p.username, uid: a.uid, desired })
  return personId
}

/** Check (on=true) or uncheck a host for a person. Throws ValueErr with a message for the admin. */
export function grant(con: DB, actor: string, personId: number, host: string, on: boolean): void {
  const p = con.get('SELECT * FROM people WHERE id=?', personId)!
  const mine = con.get('SELECT 1 FROM accounts WHERE person_id=? AND host=? AND managed=1', personId, host)
  if (!on) {
    con.run("UPDATE accounts SET desired='locked' WHERE person_id=? AND host=? AND managed=1", personId, host)
  } else if (p.status !== 'active') {
    throw new ValueErr('人員已鎖定，請先解除鎖定')
  } else if (mine) {
    con.run("UPDATE accounts SET desired='present', remove_home=0 WHERE person_id=? AND host=? AND managed=1", personId, host)
  } else {
    const a = con.get('SELECT * FROM accounts WHERE host=? AND username=?', host, p.username)
    const gone = a?.desired === 'absent' && !a.exists_on_host // a deleted account's leftover row: free again
    if (a?.managed && !gone) throw new Conflict('該主機的同名帳號已連結到其他人員')
    if (a?.exists_on_host) throw new Conflict('該主機已有同名帳號，請先認領（adopt）')
    let uid = p.uid as number | null
    if (uid === null) {
      // Adopted people whose UIDs differ per host: their existing accounts keep their UIDs; new accounts all
      // share one fresh lab-wide UID, stored once in people.uid.
      const adopted = con.get('SELECT 1 FROM accounts WHERE person_id=? AND managed=1', personId)
      if (!adopted && con.get('SELECT 1 FROM accounts WHERE username=? AND exists_on_host=1', p.username)) {
        throw new ValueErr('UID 衝突，需人工處理')
      }
      uid = allocUid(con)
      con.run('UPDATE people SET uid=? WHERE id=?', uid, personId)
    }
    if (con.get('SELECT 1 FROM accounts WHERE host=? AND (uid=? OR expected_uid=?)', host, uid, uid)) {
      throw new ValueErr('UID 衝突，需人工處理')
    }
    con.run(
      `INSERT INTO accounts(host, username, person_id, managed, desired, expected_uid)
       VALUES (?,?,?,1,'present',?)
       ON CONFLICT(host, username) DO UPDATE SET person_id=excluded.person_id, managed=1,
         desired='present', expected_uid=excluded.expected_uid, remove_home=0, primary_user=0`,
      host, p.username, personId, uid,
    )
  }
  audit(con, actor, on ? 'grant' : 'revoke', `${host}/${p.username}`, { person_id: personId })
}

// --- ingest (runner) -------------------------------------------------------------------

function req(o: unknown, key: string): any {
  if (!o || typeof o !== 'object' || Array.isArray(o) || !(key in o)) throw new Error(`KeyError ${key}`)
  return (o as Record<string, unknown>)[key]
}

/** Python int(): numbers truncate, integer strings parse, anything else throws. */
function pyInt(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v)
  throw new Error(`invalid int ${String(v)}`)
}

const opt = (o: Record<string, unknown>, k: string) => (o[k] === undefined ? null : (o[k] as any))

/**
 * Import collect JSON (約定 E) newer than `since` (epoch seconds). Commits per host; never touches desired-state
 * columns. `"accounts": null` (the host couldn't list its accounts) keeps the stored accounts as they are.
 */
export function ingest(con: DB, since = 0): string[] {
  const inv = inventory(con)
  const done: string[] = []
  let files: string[]
  try {
    files = readdirSync(config.collectDir).filter((f) => f.endsWith('.json')).sort(cmp)
  } catch {
    return done
  }
  for (const f of files) {
    const file = path.join(config.collectDir, f)
    try {
      if (statSync(file).mtimeMs / 1000 < since) continue
      const d = JSON.parse(readFileSync(file, 'utf8'))
      const host = req(d, 'host')
      const seen = pyInt(req(d, 'collected_at'))
      if (!inv.has(host) || f.slice(0, -5) !== host) continue
      con.tx(() => {
        con.run('UPDATE hosts SET facts_json=?, facts_at=? WHERE name=?', pyJson(d.facts || {}), seen, host)
        for (const a of d.accounts || []) {
          con.run(
            `INSERT INTO accounts(host, username, uid, last_login, home_mtime, observed_locked,
                                  observed_expires, exists_on_host, seen_at)
             VALUES (?,?,?,?,?,?,?,1,?) ON CONFLICT(host, username) DO UPDATE SET
               uid=excluded.uid, last_login=excluded.last_login, home_mtime=excluded.home_mtime,
               observed_locked=excluded.observed_locked, observed_expires=excluded.observed_expires,
               exists_on_host=1, seen_at=excluded.seen_at`,
            host, String(req(a, 'username')), opt(a, 'uid'), opt(a, 'last_login'), opt(a, 'home_mtime'),
            a.locked ? 1 : 0, opt(a, 'expires'), seen,
          )
        }
        if (d.accounts !== null && d.accounts !== undefined) {
          con.run('UPDATE accounts SET exists_on_host=0 WHERE host=? AND seen_at IS NOT ?', host, seen)
        }
        for (const x of d.logins || []) {
          con.run('INSERT OR IGNORE INTO logins(host, username, src, ts) VALUES (?,?,?,?)', host, String(req(x, 'username')),
            opt(x, 'src'), pyInt(req(x, 'ts')))
        }
      })
      done.push(host)
    } catch (e) {
      console.warn(`ingest ${f} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return done
}
