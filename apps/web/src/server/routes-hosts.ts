import {
  Conflict, PromError, ValueErr, addHosts, audit, checkHostNames, config, deleteAccount, enqueue, gpuBoard, lockAccount, now, parseHostsCsv,
  pyFloatStr, sortBy, validateHost,
} from '@labdeck/core'
import { type Ctx, admin, member, route } from './app.ts'
import { HttpError, model, opt, optNotNull } from './http.ts'
import {
  ACCOUNT_SQL, csvResponse, currentAnnouncements, hostAccount, hostJson, hostList, monitored, storedHost,
} from './views.ts'

route('GET', '/api/announcements', (ctx) => currentAnnouncements(ctx.con, now()))

/** GPU counts come from one source: the GPU board when Prometheus answers, else the collected facts (idle unknown). */
route('GET', '/api/summary', async (ctx) => {
  member(ctx)
  const { con } = ctx
  const facts = con.all('SELECT facts_json FROM hosts').map((r) => JSON.parse(r.facts_json || '{}'))
  const out: Record<string, unknown> = {
    hosts_total: facts.length, hosts_up: null, gpus_total: facts.reduce((s, f) => s + (f.gpus || []).length, 0),
    gpus_idle: null, announcements: currentAnnouncements(con, now()), metrics_ok: true,
  }
  try {
    const hosts = monitored(con)
    const [board, up] = await gpuBoard(hosts)
    Object.assign(out, {
      hosts_up: hosts.filter(([name]) => up.get(name) === true).length,
      gpus_total: board.reduce((s, h) => s + (h.gpus as unknown[]).length, 0),
      gpus_idle: board.reduce((s, h) => s + (h.gpus as { idle: boolean }[]).filter((g) => g.idle).length, 0),
    })
  } catch (e) {
    if (!(e instanceof PromError)) throw e
    out.metrics_ok = false
  }
  return out
})

route('GET', '/api/hosts', (ctx) => {
  member(ctx)
  return hostList(ctx.con)
})

const CSV_COLUMNS: [string, string][] = [
  ['name', '主機'], ['group', '群組'], ['address', '位址'], ['monitored', '監控'], ['room', '機房'], ['rack', '機櫃'], ['psu', 'PSU'], ['notes', '備註'], ['os', 'OS'],
  ['kernel', 'Kernel'], ['nvidia_driver', 'Driver'], ['cuda', 'CUDA'], ['cpu_model', 'CPU'], ['cpu_count', 'CPU threads'],
  ['mem_gb', 'RAM GB'], ['gpu_count', 'GPU 數'], ['gpu_summary', 'GPU'], ['gpu_pci_count', 'PCI GPU 數'],
  ['disk_count', '硬碟數'], ['facts_at', '資料時間'],
]

route('GET', '/api/hosts.csv', (ctx) => {
  member(ctx)
  const rows = ctx.con.all('SELECT * FROM hosts ORDER BY group_name, name').map((r) => hostJson(r))
  return csvResponse('hosts.csv', CSV_COLUMNS.map(([, label]) => label),
    rows.map((h) => CSV_COLUMNS.map(([k]) => (k === 'mem_gb' && typeof h[k] === 'number' ? pyFloatStr(h[k]) : h[k]))))
})

const BOOTSTRAP = (name: string) =>
  `docker compose run --rm cli ansible-playbook playbooks/bootstrap_bot.yaml -l ${name} -u <既有管理帳號> ` +
  '--ask-pass --ask-become-pass -e @/run/secrets/vault.yml -e monitoring_host_ip=<監控主機 IP>'

route('GET', '/api/hosts/{name}', async (ctx) => {
  const me = member(ctx)
  const { con } = ctx
  const r = storedHost(con, ctx.params.name)
  const accounts = con.all(`${ACCOUNT_SQL} WHERE a.host=? ORDER BY a.exists_on_host DESC, a.username`, r.name)
  const h: Record<string, unknown> = {
    ...(await hostList(con, r.name))[0],
    facts: JSON.parse(r.facts_json || '{}'),
    accounts: accounts.map((a) => hostAccount(a, me.role === 'admin')),
  }
  if (me.role === 'admin') h.bootstrap_command = BOOTSTRAP(r.name)
  return h
})

// --- admin: hosts ----------------------------------------------------------------------

const HOST_IN = {
  name: optNotNull('str', ''), // POST only
  address: 'str' as const,
  group: 'str' as const,
  room: opt('str'),
  rack: opt('str'),
  psu: opt('str'),
  notes: opt('str'),
  monitored: optNotNull('bool', false), // PUT only
  ssh_no_retry: optNotNull('bool', false),
  // bmc_address, bmc_note, bmc_status, console, boot_risk, no_shutdown: removed with remote power control; ignored
}
type HostBody = Record<string, any>

const clip = (v: string | null, n: number) => Array.from((v ?? '').trim()).slice(0, n).join('') || null

function hostFields(name: string, b: HostBody) {
  const h = validateHost({ name, address: b.address, group_name: b.group })
  return {
    ...h, room: clip(b.room, 100), rack: clip(b.rack, 100), psu: clip(b.psu, 100), notes: clip(b.notes, 1000),
    ssh_no_retry: b.ssh_no_retry ? 1 : 0,
  }
}

route('POST', '/api/admin/hosts', async (ctx) => {
  const me = admin(ctx)
  const { data: b } = model<HostBody>(ctx.body(), HOST_IN)
  const h = hostFields(b.name, b)
  const [added] = ctx.con.tx(() => addHosts(ctx.con, me.username, [h]))
  if (!added.length) throw new Conflict(`${h.name} 已存在`)
  return (await hostList(ctx.con, h.name))[0]
})

route('POST', '/api/admin/hosts/import', (ctx) => {
  const me = admin(ctx)
  const { data } = model<{ csv: string }>(ctx.body(), { csv: 'str' })
  const [hosts, errors] = parseHostsCsv(data.csv)
  if (errors.length) return { added: [], skipped: [], errors }
  const [added, skipped] = ctx.con.tx(() => addHosts(ctx.con, me.username, hosts))
  return { added, skipped: skipped.map((name) => ({ name, reason: '已存在' })), errors: [] }
})

route('PUT', '/api/admin/hosts/{name}', async (ctx) => {
  const me = admin(ctx)
  const { con } = ctx
  const { data: b } = model<HostBody>(ctx.body(), HOST_IN)
  const old = storedHost(con, ctx.params.name)
  const name = old.name as string
  const fields: Record<string, unknown> = { ...hostFields(name, b), monitored: b.monitored ? 1 : 0 }
  delete fields.name
  con.tx(() => {
    con.run(`UPDATE hosts SET ${Object.keys(fields).map((k) => `${k}=?`).join(', ')} WHERE name=?`,
      ...(Object.values(fields) as (string | number | null)[]), name)
    checkHostNames(con)
    audit(con, me.username, 'host_edit', name, Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== old[k])))
  })
  return (await hostList(con, name))[0]
})

route('DELETE', '/api/admin/hosts/{name}', (ctx) => {
  const me = admin(ctx)
  const { con } = ctx
  const { data } = model<{ confirm: string }>(ctx.body(), { confirm: 'str' })
  const name = storedHost(con, ctx.params.name).name as string
  if (data.confirm.trim() !== name) throw new ValueErr(`確認文字不符：請輸入 ${name}`)
  con.tx(() => {
    // Managed accounts must be revoked (desired locked) and locked or gone on the host, or deleted; their rows go too.
    const busy = con.all(`SELECT username FROM accounts WHERE host=? AND managed=1
                          AND NOT (desired='locked' AND (exists_on_host=0 OR observed_locked=1))
                          AND NOT (desired='absent' AND exists_on_host=0)
                          ORDER BY username`, name).map((r) => r.username)
    if (busy.length) {
      throw new Conflict(`此主機仍有未停用的受管帳號：${busy.join('、')}；請先在人員頁取消開通並同步，等主機上已鎖定後再刪除`)
    }
    const locked = con.all('SELECT username FROM accounts WHERE host=? AND managed=1 ORDER BY username', name).map((r) => r.username)
    con.run('DELETE FROM accounts WHERE host=?', name)
    con.run('DELETE FROM hosts WHERE name=?', name) // logins and audit are kept
    audit(con, me.username, 'host_delete', name, locked.length ? { locked_accounts: locked } : null)
  })
  return {}
})

const HOST_JOBS: Record<string, string> = { agents: 'agents', collect: 'collect' }

/** 安裝/更新監控 (agents) and 收集資料 (collect) for one host. */
route('POST', '/api/admin/hosts/{name}/{action}', (ctx: Ctx) => {
  const me = admin(ctx)
  const kind = HOST_JOBS[ctx.params.action]
  if (!kind || !Object.hasOwn(HOST_JOBS, ctx.params.action)) throw new HttpError(404, '找不到')
  const name = storedHost(ctx.con, ctx.params.name).name as string
  const args = { target_hosts: name, ...(kind === 'collect' ? { collect_dir: config.collectDir } : {}) }
  return { job_id: ctx.con.tx(() => enqueue(ctx.con, me.username, kind, args)) }
})

route('PUT', '/api/admin/hosts/{name}/accounts/{username}/primary', (ctx) => {
  const me = admin(ctx)
  const { data } = model<{ primary: boolean }>(ctx.body(), { primary: 'bool' })
  const { name, username } = ctx.params
  ctx.con.tx(() => {
    if (!ctx.con.run('UPDATE accounts SET primary_user=? WHERE host=? AND username=? AND managed=1', data.primary ? 1 : 0, name, username).changes) {
      throw new HttpError(404, '找不到這台主機的受管帳號')
    }
    audit(ctx.con, me.username, 'primary_set', `${name}/${username}`, { primary: data.primary })
  })
  return { primary: data.primary }
})

/**
 * Delete one account on this host (managed, or an old one nobody was assigned): a previewed users job, never auto.
 * Removing the home directory needs the username typed as confirmation.
 */
route('POST', '/api/admin/hosts/{name}/accounts/{username}/delete', (ctx) => {
  const me = admin(ctx)
  const { data } = model<{ remove_home: boolean; confirm: string }>(ctx.body(), { remove_home: 'bool', confirm: optNotNull('str', '') })
  const host = storedHost(ctx.con, ctx.params.name).name as string
  const { username } = ctx.params
  if (data.remove_home && data.confirm.trim() !== username) throw new ValueErr(`確認文字不符：刪除家目錄請輸入 ${username}`)
  return { job_id: ctx.con.tx(() => deleteAccount(ctx.con, me.username, host, username, data.remove_home)) }
})

/** Lock one person's account on this host (nothing deleted): a previewed users job, never auto. */
route('POST', '/api/admin/hosts/{name}/accounts/{username}/lock', (ctx) => {
  const me = admin(ctx)
  const host = storedHost(ctx.con, ctx.params.name).name as string
  return { job_id: ctx.con.tx(() => lockAccount(ctx.con, me.username, host, ctx.params.username)) }
})

/** The complete set of primary users over every host: the listed managed accounts are set, all others cleared. */
route('PUT', '/api/admin/primary-users', (ctx) => {
  const me = admin(ctx)
  const { con } = ctx
  const { data } = model<{ items: { host: string; username: string }[] }>(ctx.body(), {
    items: { list: { host: 'str', username: 'str' } },
  })
  const uniq = new Map(data.items.map((i) => [JSON.stringify([i.host, i.username]), [i.host, i.username] as [string, string]]))
  const items = sortBy(uniq.values(), (x) => x)
  con.tx(() => {
    const bad = items.filter(([h, u]) => !con.get('SELECT 1 FROM accounts WHERE host=? AND username=? AND managed=1', h, u)).map(([h, u]) => `${h}/${u}`)
    if (bad.length) throw new ValueErr(`不是受管帳號：${bad.slice(0, 20).join('、')}${bad.length > 20 ? ' 等' : ''}`)
    con.run('UPDATE accounts SET primary_user=0 WHERE primary_user=1')
    for (const [h, u] of items) con.run('UPDATE accounts SET primary_user=1 WHERE host=? AND username=?', h, u)
    audit(con, me.username, 'primary_import', 'accounts', { count: items.length })
  })
  return { items: items.map(([host, username]) => ({ host, username })) }
})
