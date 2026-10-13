import {
  Conflict, type DB, PromError, type Row, SSO_ID_RE, STALE_USERS_JOB, ValueErr, adopt, allocator, assignHosts, audit,
  checkNewUsername, cmp, config, cut, deleteAccount, enqueueUsers, filesystems, gpuBoard, grant, inventory, iso, isPrintable, lockAccount,
  notifications as nt, notify, now, parseDate, pyJson, pyRound, rerunJob, usersJobStale, validUsername,
} from '@labdeck/core'
import { admin, isMember, route } from './app.ts'
import { HttpError, clampBig, model, opt, optNotNull, pathInt, queryInt, queryStr, sqlInt } from './http.ts'
import {
  ACCOUNT_SQL, ADMIN_ACCOUNT, accountJson, accountsAndKeys, hostJson, jobJson, knownHosts, monitored, primaryUsers, requestJson,
  userJson,
} from './views.ts'

// --- 待指派: registrations and host requests; an admin links or creates the person and assigns hosts ----------

route('GET', '/api/admin/requests', (ctx) => {
  admin(ctx)
  const { con } = ctx
  return con.all("SELECT * FROM requests ORDER BY status != 'pending', id DESC").map((r) => requestJson(con, r))
})

function pendingRequest(con: DB, rid: number | bigint): Row {
  const r = con.get('SELECT * FROM requests WHERE id=?', rid)
  if (!r) throw new HttpError(404, '找不到申請')
  if (r.status !== 'pending') throw new Conflict('申請已處理')
  return r
}

/**
 * Fulfil a registration: link it to an existing person without an SSO ID (person_id) or create one (username);
 * or a member's host request. Then assign `hosts`, one scoped auto-confirmed job each. All or nothing.
 */
route('POST', '/api/admin/requests/{rid}/assign', (ctx) => {
  const me = admin(ctx)
  const { con } = ctx
  // No expires_at: an assignment never sets or changes people.expires_at (the registration's until is shown to the
  // admin only); the expiry is edited on the person page.
  const { data: b } = model<{ person_id: number | null; username: string | null; hosts: string[] }>(ctx.body(), {
    person_id: opt('int'), username: opt('str'), hosts: 'str[]',
  })
  const rid = pathInt(ctx.params.rid)
  const out = con.tx(() => {
    const r = pendingRequest(con, rid)
    let pid: number
    if (r.kind === 'hosts') {
      const p = con.get('SELECT * FROM people WHERE id=?', r.person_id)
      if (!isMember(p)) throw new Conflict('申請人的實驗室帳號已停用或到期，請退回申請')
      if (!b.hosts.length) throw new ValueErr('請選擇主機')
      pid = p.id
    } else {
      if ((b.person_id === null) === (b.username === null)) throw new ValueErr('請選擇連結既有帳號，或建立新帳號')
      if (con.get('SELECT 1 FROM people WHERE sso_id=?', r.sso_id)) throw new Conflict(`這個 ${config.oauthName} ID 已連結到其他人員，請退回登記`)
      if (b.person_id !== null) {
        const p = con.get('SELECT * FROM people WHERE id=?', b.person_id)
        if (!p) throw new HttpError(404, '找不到人員')
        if (p.sso_id) throw new Conflict(`${p.username} 已連結 ${config.oauthName} ID`)
        if (p.status !== 'active') throw new ValueErr(`${p.username} 已鎖定，請先在人員頁解除鎖定`)
        con.run(`UPDATE people SET sso_id=?, email=COALESCE(NULLIF(email, ''), ?), name=COALESCE(NULLIF(name, ''), ?)
                 WHERE id=?`, r.sso_id, r.email, r.name, p.id)
        audit(con, me.username, 'sso_link', p.username, { sso_id: r.sso_id, request: r.id })
        pid = p.id
      } else {
        const username = b.username!.trim()
        checkNewUsername(username)
        if (con.get('SELECT 1 FROM people WHERE username=? UNION ALL SELECT 1 FROM accounts WHERE username=?', username, username)) {
          throw new Conflict(`帳號名稱 ${username} 已被使用（人員或主機上的帳號）；若是同一人請改用「連結既有帳號」`)
        }
        if (!b.hosts.length) throw new ValueErr('請選擇主機')
        pid = con.run(
          `INSERT INTO people(username, uid, sso_id, email, name, role, status, created_at) VALUES (?,?,?,?,?,'member','active',?)`,
          username, allocator.allocUid(con), r.sso_id, r.email, r.name, now(),
        ).lastInsertRowid
        audit(con, me.username, 'person_create', username, { sso_id: r.sso_id, request: r.id })
      }
    }
    const jobs = b.hosts.length ? assignHosts(con, me.username, pid, knownHosts(con, b.hosts), r.id) : []
    con.run("UPDATE requests SET status='approved', decided_by=?, decided_at=?, person_id=?, hosts_json=? WHERE id=?",
      me.username, now(), pid, pyJson(jobs.map((j) => j.host)), r.id)
    audit(con, me.username, 'request_assign', r.username, { request: r.id, person_id: pid, hosts: jobs.map((j) => j.host) })
    return { person_id: pid, jobs }
  })
  return out
})

/** 退回: an optional reason, shown to the requester and included in the rejection email. */
route('POST', '/api/admin/requests/{rid}/reject', (ctx) => {
  const me = admin(ctx)
  const { con } = ctx
  const { data } = model<{ reason: string | null }>(ctx.body() ?? {}, { reason: opt('str') }) // the body is optional
  const reason = cut((data.reason ?? '').trim(), 500) || null
  const rid = pathInt(ctx.params.rid)
  con.tx(() => {
    const r = pendingRequest(con, rid)
    con.run("UPDATE requests SET status='rejected', decided_by=?, decided_at=?, decision_note=? WHERE id=?", me.username, now(), reason, r.id)
    audit(con, me.username, 'request_reject', r.username, { request: r.id, ...(reason ? { reason } : {}) })
    nt.requestRejected(con, r, reason)
  })
  return requestJson(con, con.get('SELECT * FROM requests WHERE id=?', rid)!)
})

/**
 * 移除: delete a pending registration or host request without telling anyone (duplicates, mistakes, strangers).
 * Unlike 退回 nothing is shown to or sent to the requester; the identity may register again.
 */
route('DELETE', '/api/admin/requests/{rid}', (ctx) => {
  const me = admin(ctx)
  const { con } = ctx
  const rid = pathInt(ctx.params.rid)
  con.tx(() => {
    const r = pendingRequest(con, rid)
    con.run("DELETE FROM requests WHERE id=? AND status='pending'", r.id)
    audit(con, me.username, 'request_delete', r.username, {
      request: r.id, kind: r.kind, sso_id: r.sso_id, ...(r.name ? { name: r.name } : {}), ...(r.person_id ? { person_id: r.person_id } : {}),
    })
  })
  return {}
})

/** Hosts for the assignment picker: hardware from the last collect, live GPU / disk numbers from Prometheus. */
route('GET', '/api/admin/assign-hosts', async (ctx) => {
  admin(ctx)
  const { con } = ctx
  const pidArg = ctx.url.searchParams.get('person_id')
  const granted = new Set(pidArg
    ? con.all("SELECT host FROM accounts WHERE person_id=? AND managed=1 AND desired='present'", pathInt(pidArg)).map((r) => r.host)
    : [])
  const rows = con.all('SELECT * FROM hosts ORDER BY group_name, name')
  // claimed accounts only: managed, linked to a person, to stay open and not locked there (no unassigned leftovers)
  const users = new Map(con.all(`SELECT host, COUNT(*) AS n FROM accounts WHERE managed=1 AND person_id IS NOT NULL
                                 AND desired='present' AND COALESCE(observed_locked, 0)=0 GROUP BY host`)
    .map((r) => [r.host, r.n as number]))
  const primary = primaryUsers(con)
  let board: Map<string, Record<string, any>> | null = null
  let up: Map<string | undefined, boolean> | null = null
  let disks: Map<string, Record<string, any>[]> | null = null
  try {
    const [b, u] = await gpuBoard(monitored(con))
    const fs = await filesystems(rows.filter((r) => r.monitored).map((r) => [r.name, r.group_name]))
    board = new Map(b.map((h) => [h.host as string, h]))
    up = u
    disks = new Map(fs.hosts.map((h) => [h.host, h.filesystems]))
  } catch (e) {
    if (!(e instanceof PromError)) throw e
  }
  const dataMount = globRe(config.dataMountGlob)
  return {
    metrics_ok: board !== null,
    hosts: rows.map((r) => {
      const isUp = r.monitored && up ? (up.get(r.name) ?? null) : null
      // an assignment's job would only fail there: never collected (not bootstrapped?) or reported down by monitoring
      const blocked = !r.facts_at ? '尚未收集到資料（可能還沒 bootstrap）' : isUp === false ? '監控顯示離線' : null
      const f = JSON.parse(r.facts_json || '{}')
      const h = hostJson(r)
      const live = r.monitored ? board?.get(r.name) : undefined
      const cards: Record<string, any>[] = live?.gpus ?? []
      const vram = Math.max(0, ...(f.gpus || []).map((g: { memory_mb?: number }) => g.memory_mb ?? 0),
        ...cards.map((g) => (g.mem_total_bytes ?? 0) / 2 ** 20))
      const fs = r.monitored ? disks?.get(r.name) : undefined
      const utils = cards.map((g) => g.util_pct).filter((v): v is number => typeof v === 'number')
      return {
        name: r.name, group: r.group_name, monitored: Boolean(r.monitored),
        up: isUp,
        gpu_summary: h.gpu_summary, gpu_count: cards.length || h.gpu_count, gpu_vram_gb: vram ? Math.round(vram / 1024) : null,
        gpus_free: live ? cards.filter((g) => g.idle).length : null,
        gpu_util_avg: utils.length ? pyRound(utils.reduce((a, v) => a + v, 0) / utils.length, 1) : null,
        users: users.get(r.name) ?? 0, primary_users: primary.get(r.name) ?? [],
        root_free_bytes: fs ? (fs.find((x) => x.mountpoint === '/')?.avail_bytes ?? null) : null,
        data_free_bytes: fs ? fs.filter((x) => dataMount.test(x.mountpoint)).reduce((a, x) => a + x.avail_bytes, 0) || null : null,
        granted: granted.has(r.name),
        blocked,
      }
    }),
  }
})

/** DATA_MOUNT_GLOB (shell glob: * and ?) as a regex over one mountpoint. */
function globRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]')}$`)
}

// --- accounts ----------------------------------------------------------------------------

// UID conflicts among the accounts that exist on hosts: the 「UID 衝突」 tab, and never suggested for bulk adoption.
const SAME_NAME_OTHER_UID = 'SELECT username FROM accounts WHERE exists_on_host = 1 GROUP BY username HAVING COUNT(DISTINCT uid) > 1'
const SAME_UID_OTHER_NAME = 'SELECT uid FROM accounts WHERE exists_on_host = 1 GROUP BY uid HAVING COUNT(DISTINCT username) > 1'
export const ACCOUNT_TABS: Record<string, string> = {
  all: '1',
  drift: 'a.managed = 1', // narrowed by drift below
  uid: `a.exists_on_host = 1 AND (a.username IN (${SAME_NAME_OTHER_UID}) OR a.uid IN (${SAME_UID_OTHER_NAME}))`,
  idle: 'a.exists_on_host = 1 AND last_active < ?',
  unmanaged: 'a.managed = 0 AND a.exists_on_host = 1',
}

route('GET', '/api/admin/accounts', (ctx) => {
  admin(ctx)
  const tab = queryStr(ctx.url, 'tab', 'all')
  const days = queryInt(ctx.url, 'days', 365)
  const q = queryStr(ctx.url, 'q')
  if (!Object.hasOwn(ACCOUNT_TABS, tab)) throw new ValueErr('tab 不合法')
  let where = ACCOUNT_TABS[tab]
  const params: (string | number | bigint)[] = []
  if (tab === 'idle') params.push(sqlInt(BigInt(Math.floor(Date.now() / 1000)) - clampBig(days, 1n, 3650n) * 86400n))
  if (q) {
    where += ' AND (a.username LIKE ? OR a.host LIKE ?)'
    params.push(`%${q}%`, `%${q}%`)
  }
  const order = tab === 'uid' ? 'a.uid, a.username, a.host' : 'a.username, a.host'
  let rows = ctx.con.all(`${ACCOUNT_SQL} WHERE ${where} ORDER BY ${order}`, ...params).map((a) => accountJson(a, ADMIN_ACCOUNT))
  if (tab === 'drift') rows = rows.filter((r) => r.drift.length)
  const conflicts: unknown[] = []
  if (tab === 'uid') {
    for (const [kind, key, other] of [['same_name', 'username', 'uid'], ['same_uid', 'uid', 'username']] as const) {
      const groups = new Map<unknown, Record<string, unknown>[]>()
      for (const r of rows) {
        if (!groups.has(r[key])) groups.set(r[key], [])
        groups.get(r[key])!.push({ host: r.host, username: r.username, uid: r.uid })
      }
      for (const [k, g] of groups) {
        if (new Set(g.map((e) => e[other])).size > 1) conflicts.push({ kind, key: String(k), entries: g })
      }
    }
  }
  return { tab, rows, conflicts }
})

route('POST', '/api/admin/accounts/adopt', (ctx) => {
  const me = admin(ctx)
  const { data } = model<{ host: string; username: string; person_id: number | null }>(ctx.body(), {
    host: 'str', username: 'str', person_id: opt('int'),
  })
  return { person_id: ctx.con.tx(() => adopt(ctx.con, me.username, data.host, data.username, data.person_id)) }
})

/**
 * [groups, conflicts] of /api/admin/accounts/suggestions: unmanaged accounts that are very likely one person.
 * A username is suggested when every account with it (on hosts, or already managed, or the person of that name)
 * has the same uid and nothing under another username uses that uid; reserved or invalid names never are.
 * Names that fail only the uid rules are listed in conflicts, to be handled one host at a time.
 */
function adoptSuggestions(con: DB) {
  const rows = con.all(`${ACCOUNT_SQL} WHERE a.managed = 0 AND a.exists_on_host = 1 ORDER BY a.username, a.host`)
  const badNames = new Set(con.all(SAME_NAME_OTHER_UID).map((r) => r.username))
  const badUids = new Set(con.all(SAME_UID_OTHER_NAME).map((r) => r.uid))
  const uidsOf = new Map<string, Set<number | null>>()
  const namesOf = new Map<number | null, Set<string>>()
  for (const { username, uid } of con.all(`SELECT username, uid FROM accounts WHERE exists_on_host = 1
                                           UNION SELECT username, expected_uid FROM accounts WHERE managed = 1
                                           UNION SELECT username, uid FROM people WHERE uid IS NOT NULL`)) {
    if (!uidsOf.has(username)) uidsOf.set(username, new Set())
    uidsOf.get(username)!.add(uid)
    if (!namesOf.has(uid)) namesOf.set(uid, new Set())
    namesOf.get(uid)!.add(username)
  }
  const people = new Map(con.all('SELECT id, username FROM people').map((p) => [p.username, { id: p.id, username: p.username }]))
  const byName = new Map<string, Row[]>()
  for (const a of rows) {
    if (!byName.has(a.username)) byName.set(a.username, [])
    byName.get(a.username)!.push(a)
  }
  const groups: Record<string, any>[] = []
  const conflicts: Record<string, any>[] = []
  for (const [name, accts] of byName) {
    if (!validUsername(name)) continue
    const uids = uidsOf.get(name) ?? new Set()
    const uid = uids.size === 1 ? [...uids][0] : null
    const others = [...(namesOf.get(uid) ?? [])].filter((x) => x !== name).sort(cmp)
    let reason: string
    if (badNames.has(name) || uid === null) reason = '同名帳號的 UID 不同，不一定是同一人'
    else if (badUids.has(uid) || others.length) reason = `UID ${uid} 也被 ${others.join('、') || '其他帳號'} 使用`
    else {
      groups.push({
        username: name, uid, hosts: accts.map((a) => a.host),
        last_active: iso(Math.max(...accts.map((a) => a.last_active))), existing_person: people.get(name) ?? null,
      })
      continue
    }
    conflicts.push({ username: name, reason, entries: accts.map((a) => ({ host: a.host, uid: a.uid })) })
  }
  return [groups, conflicts] as const
}

route('GET', '/api/admin/accounts/suggestions', (ctx) => {
  admin(ctx)
  const [groups, conflicts] = adoptSuggestions(ctx.con)
  return { groups, conflicts }
})

/**
 * Adopt each item's (host, username)s in its own transaction; every rule is checked again here, not taken from
 * the client: the name must still be a suggestion, the hosts among its hosts, person_id its same-name person.
 */
route('POST', '/api/admin/accounts/adopt-bulk', (ctx) => {
  const me = admin(ctx)
  const { con } = ctx
  const { data } = model<{ items: { username: string; hosts: string[]; person_id: number | null }[] }>(ctx.body(), {
    items: { list: { username: 'str', hosts: 'str[]', person_id: opt('int') } },
  })
  if (!data.items.length || data.items.length > 1000) throw new ValueErr('請選擇要認領的帳號')
  const adopted: unknown[] = []
  const errors: unknown[] = []
  for (const it of data.items) {
    try {
      const pid = con.tx(() => {
        const g = adoptSuggestions(con)[0].find((x) => x.username === it.username)
        if (!g) throw new Conflict('已不符合批次認領條件（UID 不一致、已受管理或為保留帳號），請到「UID 衝突」分頁逐台處理')
        const stray = it.hosts.filter((h) => !g.hosts.includes(h))
        if (!it.hosts.length || stray.length || new Set(it.hosts).size !== it.hosts.length) {
          throw new ValueErr(`主機不在建議清單中：${stray.join('、') || '（未選擇）'}`)
        }
        let pid: number | null = g.existing_person ? g.existing_person.id : null
        if (it.person_id !== pid) throw new Conflict(pid ? '已有同名人員，請重新整理後再確認' : '指定的人員與帳號名稱不符')
        for (const h of it.hosts) pid = adopt(con, me.username, h, it.username, pid)
        return pid
      }, 'IMMEDIATE') // the check and the adoption see the same data
      adopted.push({ username: it.username, person_id: pid, hosts: it.hosts })
    } catch (e) {
      if (!(e instanceof ValueErr)) throw e
      errors.push({ username: it.username, error: e.message })
    }
  }
  return { adopted, errors }
})

// --- people ------------------------------------------------------------------------------

const PERSON_SQL = `SELECT p.*, (SELECT COUNT(*) FROM accounts a WHERE a.person_id = p.id AND a.managed = 1
                                AND a.desired = 'present') AS hosts_count FROM people p`

const personJson = (p: Row) => ({
  ...userJson(p), uid: p.uid, created_at: iso(p.created_at), hosts_count: p.hosts_count, removed_at: iso(p.removed_at ?? null),
})

function getPerson(con: DB, pid: number | bigint): Row {
  const p = con.get(`${PERSON_SQL} WHERE p.id=?`, pid)
  if (!p) throw new HttpError(404, '找不到人員')
  return p
}

route('GET', '/api/admin/people', (ctx) => {
  admin(ctx)
  return ctx.con.all(`${PERSON_SQL} ORDER BY p.status, p.username`).map(personJson)
})

route('GET', '/api/admin/people/{pid}', (ctx) => {
  admin(ctx)
  const { con } = ctx
  const p = getPerson(con, pathInt(ctx.params.pid))
  const granted = new Set(con.all("SELECT host FROM accounts WHERE person_id=? AND managed=1 AND desired='present'", p.id).map((r) => r.host))
  // this person's accounts, or a same-name one that would need adopting
  const exists = new Set(con.all('SELECT host FROM accounts WHERE exists_on_host=1 AND (person_id=? OR username=?)', p.id, p.username).map((r) => r.host))
  return {
    person: personJson(p), ...accountsAndKeys(con, p.id),
    hosts: con.all('SELECT name, group_name FROM hosts ORDER BY group_name, name')
      .map((r) => ({ name: r.name, group: r.group_name, granted: granted.has(r.name), exists: exists.has(r.name) })),
  }
})

/**
 * Edit a person. The role is not editable here: promotion has its own endpoint, and demotion is only possible with
 * the server CLI (labdeck demote-admin). A `role` equal to the current one is accepted (a form echoing it back).
 */
route('PUT', '/api/admin/people/{pid}', (ctx) => {
  const me = admin(ctx)
  const { con } = ctx
  const { data: b, set } = model<Record<string, any>>(ctx.body(), {
    name: opt('str'), email: opt('str'), sso_id: opt('str'), expires_at: opt('str'), role: opt('str'), status: 'str',
  })
  const pidRaw = pathInt(ctx.params.pid)
  const p = getPerson(con, pidRaw)
  const pid = p.id as number
  const email = b.email || null
  const ssoId = b.sso_id || null
  if (ssoId && !SSO_ID_RE.test(ssoId)) throw new ValueErr(`${config.oauthName} ID 格式錯誤`)
  if (email && !([...email].every((c) => c.charCodeAt(0) < 0x80) && email.includes('@') && Array.from(email).length <= 200 && isPrintable(email) && !email.includes(' '))) {
    throw new ValueErr('Email 格式錯誤')
  }
  if (set.has('role') && b.role !== p.role) {
    throw new HttpError(403, p.role === 'admin'
      ? '無法在網頁上移除管理員權限；請由伺服器管理者以 labdeck demote-admin 指令處理'
      : '角色不能在這裡修改；請使用「設為管理員」')
  }
  if (!['active', 'locked'].includes(b.status)) throw new ValueErr('狀態不合法')
  if (pid === me.id && b.status !== 'active') throw new ValueErr('不能鎖定自己')
  const fresh: Record<string, unknown> = {
    name: Array.from((b.name ?? '').trim()).slice(0, 100).join('') || null, email, sso_id: ssoId,
    expires_at: b.expires_at ? parseDate(b.expires_at) : null, status: b.status,
  }
  try {
    con.tx(() => {
      // a removed person set back to active is no longer removed (links stay cleared until edited here)
      con.run(`UPDATE people SET name=?, email=?, sso_id=?, expires_at=?, status=?,
               removed_at=CASE WHEN ?='active' THEN NULL ELSE removed_at END WHERE id=?`,
        ...(Object.values(fresh) as (string | null)[]), b.status, pid)
      if (b.status === 'locked') con.run("UPDATE accounts SET desired='locked' WHERE person_id=? AND managed=1", pid)
      audit(con, me.username, 'person_update', p.username, Object.fromEntries(Object.entries(fresh).filter(([k, v]) => v !== p[k])))
    })
  } catch (e) {
    if ((e as { errcode?: number })?.errcode !== undefined && ((e as { errcode: number }).errcode & 0xff) === 19) {
      throw new Conflict(`${config.oauthName} ID 已被其他人員使用`)
    }
    throw e
  }
  return personJson(getPerson(con, pid))
})

/**
 * Make an active member an admin. Idempotent: an admin stays one (no second audit or post). There is no way back
 * on the web: demotion is the server CLI's (labdeck demote-admin).
 */
route('POST', '/api/admin/people/{pid}/promote', async (ctx) => {
  const me = admin(ctx)
  const { con } = ctx
  const pid = getPerson(con, pathInt(ctx.params.pid)).id as number
  const promoted = con.tx<Row | null>(() => {
    const p = getPerson(con, pid) // re-read inside the write transaction
    if (p.role === 'admin') return null
    const who = p.username as string
    if (!isMember(p)) throw new ValueErr(`${who} 已鎖定或到期，不能設為管理員`)
    con.run("UPDATE people SET role='admin' WHERE id=? AND role='member'", pid)
    audit(con, me.username, 'person_promote', p.username, { role: 'admin' })
    return p
  })
  if (promoted) {
    await notify(`[管理員] ${me.username} 將 ${promoted.username}${promoted.name ? `（${promoted.name}）` : ' '}設為管理員`)
  }
  return personJson(getPerson(con, pid))
})

/** The person's host accounts 移除成員 decides on: managed ones, except those already deleted. */
const REMOVABLE_SQL = `SELECT * FROM accounts WHERE person_id=? AND managed=1 AND NOT (desired='absent' AND exists_on_host=0)
                       ORDER BY host`

type HostChoice = { host: string; action: string; remove_home: boolean; confirm: string }

/**
 * 移除成員 (offboarding): one choice per host account — lock (default) or delete, with or without the home
 * directory — each a previewed job for that one account (never auto). The person is locked and marked removed, their
 * SSO identity and notification links are cleared (no member login any more), pending requests are closed; the row
 * stays (history). Not oneself, never the last active admin.
 */
route('POST', '/api/admin/people/{pid}/remove', async (ctx) => {
  const me = admin(ctx)
  const { con } = ctx
  const { data } = model<{ hosts: HostChoice[] }>(ctx.body(), {
    hosts: { list: { host: 'str', action: 'str', remove_home: optNotNull('bool', false), confirm: optNotNull('str', '') } },
  })
  const pid = getPerson(con, pathInt(ctx.params.pid)).id as number
  const out = con.tx(() => {
    const p = getPerson(con, pid) // re-read inside the write transaction
    if (p.removed_at) throw new Conflict(`${p.username} 已經移除`)
    // the same rule as labdeck demote-admin; the acting admin is always active, so it bites when one removes oneself
    if (p.role === 'admin' && p.status === 'active' &&
        !con.value<number>("SELECT COUNT(*) FROM people WHERE role='admin' AND status='active' AND id != ?", pid)) {
      throw new ValueErr('不能移除最後一位啟用中的管理員')
    }
    if (pid === me.id) throw new ValueErr('不能移除自己')
    const accounts = con.all(REMOVABLE_SQL, pid)
    const byHost = new Map(data.hosts.map((c) => [c.host, c]))
    if (byHost.size !== data.hosts.length) throw new ValueErr('每台主機只能選一次')
    const stray = data.hosts.filter((c) => !accounts.some((a) => a.host === c.host)).map((c) => c.host)
    if (stray.length) throw new ValueErr(`${p.username} 在這些主機沒有帳號：${stray.join('、')}`)
    const missing = accounts.filter((a) => !byHost.has(a.host)).map((a) => a.host)
    if (missing.length) throw new ValueErr(`請為每台主機選擇鎖定或刪除：${missing.join('、')}`)
    const jobs: { host: string; action: string; remove_home: boolean; job_id: number }[] = []
    for (const a of accounts) {
      const c = byHost.get(a.host)!
      if (c.action !== 'lock' && c.action !== 'delete') throw new ValueErr(`${a.host}：請選擇鎖定或刪除`)
      const home = c.action === 'delete' && c.remove_home
      if (c.action === 'lock' && c.remove_home) throw new ValueErr(`${a.host}：鎖定不會刪除家目錄`)
      if (home && c.confirm.trim() !== a.username) throw new ValueErr(`${a.host}：確認文字不符，刪除家目錄請輸入 ${a.username}`)
      try {
        const job = c.action === 'lock' ? lockAccount(con, me.username, a.host, a.username) : deleteAccount(con, me.username, a.host, a.username, home)
        jobs.push({ host: a.host, action: c.action, remove_home: home, job_id: job })
      } catch (e) {
        if (e instanceof ValueErr) e.message = `${a.host}：${e.message}`
        throw e
      }
    }
    con.run(`UPDATE people SET status='locked', removed_at=?, sso_id=NULL, discord_id=NULL, discord_name=NULL, notify_email=NULL,
             notify_prefs=NULL, temp_password=NULL, temp_password_pending=0 WHERE id=?`, now(), pid)
    con.run('DELETE FROM email_verifications WHERE person_id=?', pid)
    con.run("UPDATE outbox SET status='skipped', error='人員已移除' WHERE person_id=? AND status='queued'", pid)
    const closed = con.run(`UPDATE requests SET status='rejected', decided_by=?, decided_at=?, decision_note='人員已移除'
                            WHERE status='pending' AND (person_id=? OR sso_id=?)`, me.username, now(), pid, p.sso_id ?? '').changes
    audit(con, me.username, 'person_remove', p.username, {
      sso_id: p.sso_id ?? null, closed_requests: closed,
      hosts: Object.fromEntries(jobs.map((j) => [j.host, j.action === 'lock' ? 'lock' : j.remove_home ? 'delete_home' : 'delete'])),
      jobs: jobs.map((j) => j.job_id),
    })
    return { p, jobs }
  })
  const what = out.jobs.map((j) => `${j.host} ${j.action === 'lock' ? '鎖定' : j.remove_home ? '刪除（含家目錄）' : '刪除'}`)
  await notify(`[移除成員] ${me.username} 移除了 ${out.p.username}${out.p.name ? `（${out.p.name}）` : ''}` +
    (what.length ? `：${what.join('、')}；${what.length} 個預覽工作待確認` : '：沒有主機帳號'))
  return { person: personJson(getPerson(con, pid)), jobs: out.jobs.map(({ host, action, job_id }) => ({ host, action, job_id })) }
})

/**
 * 停用／恢復主機帳號: lock (unchecked) or reopen (checked) the person's existing managed accounts, applied by a
 * previewed sync. New hosts are only added by an assignment (指派主機), so a host without an account is an error.
 */
route('PUT', '/api/admin/people/{pid}/grants', (ctx) => {
  const me = admin(ctx)
  const { con } = ctx
  const { data } = model<{ hosts: string[] }>(ctx.body(), { hosts: 'str[]' })
  const pid = getPerson(con, pathInt(ctx.params.pid)).id as number
  const mine = new Map(con.all("SELECT host, desired FROM accounts WHERE person_id=? AND managed=1 AND desired IN ('present', 'locked')", pid)
    .map((r) => [r.host as string, r.desired as string]))
  const current = new Set([...mine].filter(([, d]) => d === 'present').map(([h]) => h))
  const errors: { host: string; error: string }[] = []
  for (const h of data.hosts.filter((x) => !mine.has(x))) errors.push({ host: h, error: '尚未開通：新主機請用「指派主機」' })
  for (const h of inventory(con).keys()) {
    if (!mine.has(h)) continue
    if (data.hosts.includes(h) !== current.has(h)) {
      try {
        con.tx(() => grant(con, me.username, pid, h, data.hosts.includes(h)))
      } catch (e) {
        if (!(e instanceof ValueErr)) throw e
        errors.push({ host: h, error: e.message })
      }
    }
  }
  return { errors }
})

/** Quick assign (person page, host page): one scoped auto-confirmed job per host, no preview. */
route('POST', '/api/admin/people/{pid}/assign', (ctx) => {
  const me = admin(ctx)
  const { con } = ctx
  const { data } = model<{ hosts: string[] }>(ctx.body(), { hosts: 'str[]' })
  const p = getPerson(con, pathInt(ctx.params.pid))
  const who = p.username as string
  if (!isMember(p)) throw new ValueErr(`${who} 已停用或到期，請先在人員頁更新`)
  return con.tx(() => ({ jobs: assignHosts(con, me.username, p.id, knownHosts(con, data.hosts)) }))
})

route('POST', '/api/admin/people/{pid}/sync', (ctx) => {
  const me = admin(ctx)
  const pid = getPerson(ctx.con, pathInt(ctx.params.pid)).id as number
  return { job_id: ctx.con.tx(() => enqueueUsers(ctx.con, me.username, pid)) }
})

route('POST', '/api/admin/sync', (ctx) => {
  const me = admin(ctx)
  return { job_id: ctx.con.tx(() => enqueueUsers(ctx.con, me.username)) }
})

// --- jobs, audit --------------------------------------------------------------------

function getJob(con: DB, jid: number | bigint): Row {
  const j = con.get('SELECT * FROM jobs WHERE id=?', jid)
  if (!j) throw new HttpError(404, '找不到工作')
  return j
}

route('GET', '/api/admin/jobs', (ctx) => {
  admin(ctx)
  const limit = Number(clampBig(queryInt(ctx.url, 'limit', 100), 1n, 1000n))
  return ctx.con.all(`SELECT id, kind, args_json, status, actor, created_at, run_at, finished_at, auto_confirm
                      FROM jobs ORDER BY id DESC LIMIT ?`, limit).map((j) => jobJson(j))
})

route('GET', '/api/admin/jobs/{jid}', (ctx) => {
  admin(ctx)
  return jobJson(getJob(ctx.con, pathInt(ctx.params.jid)), true)
})

export const JOB_CANCEL = "UPDATE jobs SET status='cancelled', finished_at=? WHERE id=? AND status IN ('queued','awaiting','confirmed')"
const JOB_CONFIRM = "UPDATE jobs SET status='confirmed' WHERE id=? AND status='awaiting'"

route('POST', '/api/admin/jobs/{jid}/{action}', (ctx) => {
  const me = admin(ctx)
  const { con } = ctx
  const jid = pathInt(ctx.params.jid)
  const action = ctx.params.action
  if (action !== 'confirm' && action !== 'cancel' && action !== 'rerun') throw new HttpError(404, '找不到')
  const j = getJob(con, jid)
  if (action === 'rerun') {
    // the same job again from the current DB, every rule checked again (rerunJob); answers the new job
    return jobJson(getJob(con, con.tx(() => rerunJob(con, me.username, getJob(con, jid)), 'IMMEDIATE')), true)
  }
  if (action === 'confirm' && j.kind === 'users' && j.status === 'awaiting' && usersJobStale(con, JSON.parse(j.args_json))) {
    con.tx(() => {
      // the preview no longer matches the DB: never apply it
      if (con.run(JOB_CANCEL, now(), jid).changes) audit(con, me.username, 'job_cancel', `job/${j.id}`, { reason: 'stale' })
    })
    throw new Conflict(STALE_USERS_JOB)
  }
  con.tx(() => {
    const changed = action === 'confirm' ? con.run(JOB_CONFIRM, jid).changes : con.run(JOB_CANCEL, now(), jid).changes
    if (!changed) throw new Conflict('狀態已改變，無法執行')
    audit(con, me.username, `job_${action}`, `job/${j.id}`)
  })
  return jobJson(getJob(con, jid), true)
})

route('GET', '/api/admin/audit', (ctx) => {
  admin(ctx)
  const page = queryInt(ctx.url, 'page', 1)
  const p = page < 1n ? 1n : page
  const rows = ctx.con.all('SELECT * FROM audit ORDER BY id DESC LIMIT 101 OFFSET ?', sqlInt((p - 1n) * 100n))
  return {
    rows: rows.slice(0, 100).map((r) => ({
      ts: iso(r.ts), actor: r.actor, action: r.action, target: r.target, detail: JSON.parse(r.detail_json || '{}'),
    })),
    page: Number(p),
    has_more: rows.length > 100,
  }
})

