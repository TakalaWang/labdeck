import { chmodSync, lstatSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import {
  type DB, PLAYBOOKS, adopt, config, enqueue, enqueueHostAccount, enqueueUsers, grant, localIso,
  usersJobStale, validateJob,
} from '@labdeck/core'
import { argv, agentsDone, playbookEnv, finish, recapOk, runJob, runnerIo, scheduled, writeInventory, writeTargets } from '../src/runner.ts'
import '../../web/src/server/index.ts'
import { NOTIFIED, TMP, addDaysIso, fresh, keygen, observe, offline, person, prometheus, raises, row, today, val, vec } from '../../../packages/core/test/helpers.ts'
import { err, get, login, ok, post, put, setSession } from '../../web/test/client.ts'

afterEach(() => offline())

type Call = { argv: string[]; data: Record<string, any>; mode: number; env: NodeJS.ProcessEnv }

/** Like ansible-playbook: a recap line per target host, failed ones when rc != 0. */
function fakeAnsible(calls: Call[], rc = 0, after?: (data: Record<string, any>) => void) {
  return async (cmd: string[], opts: { env: NodeJS.ProcessEnv }) => {
    const file = cmd.find((a) => a.startsWith(`@${config.jobsDir}/`))!.slice(1)
    const text = readFileSync(file, 'utf8')
    expect(text.startsWith('!unsafe {'), text.slice(0, 50)).toBe(true) // Ansible never templates a job file value
    const data = JSON.parse(text.slice('!unsafe '.length))
    calls.push({ argv: cmd, data, mode: statSync(file).mode & 0o777, env: opts.env })
    after?.(data)
    const recap = String(data.target_hosts ?? '').split(',').filter(Boolean)
      .map((h) => `${h}  : ok=3 changed=1 unreachable=0 failed=${rc !== 0 ? 1 : 0} skipped=0\n`).join('')
    return { rc, out: `PLAY RECAP pw=${data.temp_password ?? '-'}\n${recap}` }
  }
}

const realRun = runnerIo.run
afterEach(() => {
  runnerIo.run = realRun
})

const job = (con: DB, id: number) => row(con, 'SELECT * FROM jobs WHERE id=?', id)!

test('runner argv', () => {
  const kinds: [string, string][] = [['collect', 'collect.yaml'], ['agents', 'monitoring_agents.yaml'], ['users', 'users.yaml']]
  expect(new Set(Object.keys(PLAYBOOKS))).toEqual(new Set(kinds.map(([k]) => k)))
  for (const [kind, playbook] of kinds) { // 約定 F (inventory: the file the runner writes from the hosts table)
    expect(argv(kind, '/data/jobs/7.yml')).toEqual([
      'ansible-playbook', '-i', config.inventoryPath, `/repo/ansible/playbooks/${playbook}`,
      '--private-key', '/home/app/.ssh/id_ed25519', '--vault-password-file', '/run/secrets/vault_pass',
      '-e', '@/run/secrets/vault.yml', '-e', 'ansible_user=labbot',
      '-e', "ansible_become_password={{ (vault_bot_become_password ~ inventory_hostname) | hash('sha256') }}",
      '-e', '@/data/jobs/7.yml'])
  }
  expect(config.inventoryPath).toBe(`${config.dataDir}/inventory.json`)
  expect(argv('users', '/data/jobs/7.yml', true).slice(-2)).toEqual(['--check', '--diff'])
  raises(() => argv('rm -rf', 'x'))
  raises(() => argv('execute_script', 'x'))
})

test('ansible-playbook gets an allowlisted environment', async () => {
  const con = fresh()
  const secrets = {
    SESSION_SECRET: 's', OAUTH_CLIENT_SECRET: 's', DISCORD_CLIENT_SECRET: 's', DISCORD_WEBHOOK_URL: 's', SMTP_PASSWORD: 's',
    CLOUDFLARE_API_TOKEN: 's', TUNNEL_TOKEN: 's', NODE_OPTIONS: '--require /tmp/x.js', LD_PRELOAD: '/tmp/x.so',
  }
  const kept = {
    PATH: '/usr/bin', HOME: '/home/app', TZ: 'Asia/Taipei', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ANSIBLE_VAULT_PASSWORD_FILE: '/run/secrets/vault_pass',
    BOT_USER: 'labbot', MONITORING_SOURCE: '192.0.2.0/24', KNOWN_HOSTS: '/data/known_hosts', PYTHONUNBUFFERED: '1',
  }
  expect(playbookEnv({ ...secrets, ...kept })).toEqual(kept)
  const saved = { ...process.env }
  Object.assign(process.env, secrets, { LC_CTYPE: 'C.UTF-8', ANSIBLE_FORKS: '3' })
  const calls: Call[] = []
  runnerIo.run = fakeAnsible(calls)
  try {
    await runJob(con, job(con, con.tx(() => enqueue(con, 'boss', 'agents', { target_hosts: 'gpu01' }))))
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  }
  const env = calls[0].env
  for (const k of Object.keys(secrets)) expect(env, k).not.toHaveProperty(k)
  for (const k of Object.keys(env)) expect(k).toMatch(/^(PATH|HOME|TZ|LANG|LC_.*|ANSIBLE_.*|PYTHON.*|BOT_USER|MONITORING_SOURCE|KNOWN_HOSTS|DATA_DIR)$/)
  expect([env.LC_CTYPE, env.ANSIBLE_FORKS, env.PATH, env.DATA_DIR]).toEqual(['C.UTF-8', '3', process.env.PATH, config.dataDir])
})

test('users job: preview, confirm, temp password', async () => {
  const con = fresh()
  const bob = person(con, 'bob')
  const jid = con.tx(() => {
    grant(con, 'admin', bob, 'gpu02', true)
    return enqueueUsers(con, 'admin', bob)!
  })
  const calls: Call[] = []
  runnerIo.run = fakeAnsible(calls)
  await runJob(con, job(con, jid))
  expect(job(con, jid).status).toBe('awaiting')
  expect(calls[0].argv).toContain('--check')
  expect(calls[0].data).not.toHaveProperty('temp_password')
  con.tx(() => con.run("UPDATE jobs SET status='confirmed' WHERE id=?", jid))
  await runJob(con, job(con, jid))
  const j = job(con, jid)
  const password = calls[1].data.temp_password
  expect(j.status).toBe('ok')
  expect(calls[1].argv).not.toContain('--check')
  expect(calls[1].mode).toBe(0o600)
  const env = calls[1].env
  expect([env.ANSIBLE_HOST_KEY_CHECKING, env.ANSIBLE_CONFIG, env.DATA_DIR]).toEqual(['True', '/repo/ansible/ansible.cfg', config.dataDir])
  expect(env.ANSIBLE_SSH_ARGS).toContain(`UserKnownHostsFile=${config.dataDir}/known_hosts -o StrictHostKeyChecking=yes`)
  expect(env.ANSIBLE_SSH_ARGS).toContain('ControlPersist')
  for (const c of calls) { // † injected for the preview and the real run, never stored
    expect(c.data.reserved_users).toEqual(['backup', 'labbot', 'ops', 'root'])
    expect(c.data).not.toHaveProperty('keys_only') // previewed and confirmed: may create / lock / unlock
  }
  expect(j.args_json).not.toContain('reserved_users')
  expect(j.args_json).not.toContain(password)
  expect(j.output).not.toContain(password)
  expect(j.output).toContain('********')
  expect(val(con, 'SELECT temp_password FROM people WHERE id=?', bob)).toBe(password)
  expect(readdirSync(config.jobsDir)).toEqual([])
  const follow = row(con, "SELECT * FROM jobs WHERE kind='collect'")!
  expect(JSON.parse(follow.args_json).target_hosts).toBe('gpu02')
  // an auto-confirmed job must never create accounts
  const jid2 = con.tx(() => enqueue(con, 'bob', 'users', JSON.parse(j.args_json), null, true))
  await runJob(con, job(con, jid2))
  expect(Object.values(row(con, 'SELECT status, output FROM jobs WHERE id=?', jid2)!))
    .toEqual(['failed', '[runner] 自動確認的 job 不可建立帳號，請改用「同步」（需預覽）'])
  // tampered payload in the DB is rejected by the runner before anything runs
  con.tx(() => {
    con.run("UPDATE jobs SET status='queued', args_json=? WHERE id=?", JSON.stringify({ target_hosts: 'gpu01; reboot' }), jid2)
    con.run("UPDATE jobs SET kind='agents' WHERE id=?", jid2)
  })
  await runJob(con, job(con, jid2))
  expect(val(con, 'SELECT output FROM jobs WHERE id=?', jid2).startsWith('[runner] payload rejected')).toBe(true)
})

test('key-only job', async () => {
  // An auto-confirmed job (nobody previewed it) tells users.yaml to only sync keys of existing accounts (†).
  const con = fresh()
  const bob = person(con, 'bob')
  const key = keygen('ed', '-t', 'ed25519')
  const jid = con.tx(() => {
    grant(con, 'admin', bob, 'gpu02', true)
    con.run("UPDATE accounts SET exists_on_host=1, uid=20000 WHERE username='bob'")
    con.run("INSERT INTO ssh_keys(person_id, pubkey, fingerprint, added_at) VALUES (?, ?, 'SHA256:b', ?)", bob, key, localIso(new Date()))
    return enqueueUsers(con, 'bob', bob, true)!
  })
  const j = job(con, jid)
  expect(j.auto_confirm).toBe(1)
  expect(j.args_json).not.toContain('keys_only')
  const calls: Call[] = []
  runnerIo.run = fakeAnsible(calls)
  await runJob(con, j)
  expect(calls.length).toBe(1)
  expect(calls[0].argv).not.toContain('--check') // no preview
  const data = calls[0].data
  expect(data.keys_only).toBe(true)
  expect(data).not.toHaveProperty('temp_password')
  expect(data.accounts.gpu02[0].keys_add).toEqual([key])
  expect(val(con, 'SELECT status FROM jobs WHERE id=?', jid)).toBe('ok')
  raises(() => enqueue(con, 'bob', 'users', { ...JSON.parse(j.args_json), keys_only: false })) // never web input
})

test('a stale users job is never applied', async () => {
  // Confirming an old preview must not re-add a revoked key, unlock a person locked since, and so on.
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const bob = person(con, 'bob', { expires_at: '2027-01-31' })
  login(boss)
  const kid = con.tx(() => {
    grant(con, 'boss', bob, 'gpu02', true)
    con.run("UPDATE accounts SET exists_on_host=1, uid=20000 WHERE username='bob'")
    return con.run("INSERT INTO ssh_keys(person_id, pubkey, fingerprint, added_at) VALUES (?, ?, 'SHA256:b', ?)", bob,
      keygen('ed', '-t', 'ed25519'), localIso(new Date())).lastInsertRowid
  })
  const previewed = (): [number, any] => {
    const jid = con.tx(() => {
      const id = enqueueUsers(con, 'boss', bob)!
      con.run("UPDATE jobs SET status='awaiting' WHERE id=?", id)
      return id
    })
    return [jid, JSON.parse(val(con, 'SELECT args_json FROM jobs WHERE id=?', jid))]
  }
  let [jid, args] = previewed()
  expect(usersJobStale(con, args)).toBe(false)
  con.tx(() => con.run("UPDATE ssh_keys SET state='revoked' WHERE id=?", kid)) // after the preview
  err(await post(`/api/admin/jobs/${jid}/confirm`), 409, '狀態已變更，請重新同步後再確認')
  expect(val(con, 'SELECT status FROM jobs WHERE id=?', jid)).toBe('cancelled')
  expect(JSON.parse(val(con, "SELECT detail_json FROM audit WHERE action='job_cancel'"))).toEqual({ reason: 'stale' })
  for (const change of ["UPDATE people SET expires_at='2028-01-31'", "UPDATE people SET status='locked'", "UPDATE accounts SET desired='locked'",
    'UPDATE accounts SET managed=0', "INSERT INTO ssh_keys(person_id, pubkey, fingerprint, added_at) VALUES (2, 'ssh-ed25519 AAAA', 'SHA256:n', 't')"]) {
    con.exec('SAVEPOINT s')
    con.exec(change)
    expect(usersJobStale(con, args), change).toBe(true)
    con.exec('ROLLBACK TO s')
    con.exec('RELEASE s')
  }

  // the runner re-checks right before applying: the person was locked after the confirm
  con.tx(() => con.run("UPDATE ssh_keys SET state='active' WHERE id=?", kid))
  ;[jid, args] = previewed()
  expect(ok(await post(`/api/admin/jobs/${jid}/confirm`)).status).toBe('confirmed') // still current
  ok(await put(`/api/admin/people/${bob}`, { role: 'member', status: 'locked', expires_at: '2027-01-31' }))
  const calls: Call[] = []
  runnerIo.run = fakeAnsible(calls)
  await runJob(con, job(con, jid))
  expect(calls).toEqual([])
  expect(Object.values(row(con, 'SELECT status, output FROM jobs WHERE id=?', jid)!)).toEqual(['failed', '[runner] 狀態已變更，請重新同步後再確認'])
})

test('the schedule is idempotent', async () => {
  let con = fresh()
  const soon = person(con, 'soon', { expires_at: addDaysIso(5) })
  person(con, 'later', { expires_at: addDaysIso(90) })
  con.tx(() => {
    con.run("UPDATE people SET temp_password='Temp-Secret-4711' WHERE id=?", soon)
    con.run("UPDATE hosts SET monitored=1 WHERE name='gpu01'") // nightly collect only targets monitored hosts
  })
  const t = new Date()
  t.setHours(10, 0, 0, 0)
  await scheduled(con, t)
  await scheduled(con, t)
  expect(val(con, "SELECT COUNT(*) FROM audit WHERE action='expiry_reminder'")).toBe(1)
  expect(NOTIFIED.filter((m) => m.includes('到期')).length).toBe(1)
  expect(NOTIFIED[0]).toContain('soon')
  expect(val(con, "SELECT COUNT(*) FROM jobs WHERE kind='collect' AND actor='scheduler'")).toBe(1)
  const backupFile = path.join(config.backupDir, `portal-${today().replaceAll('-', '')}.db`)
  expect(statSync(backupFile).mode & 0o777).toBe(0o600)
  expect(readFileSync(backupFile).includes(Buffer.from('Temp-Secret-4711'))).toBe(false)
  const b = new DatabaseSync(backupFile)
  expect(b.prepare('SELECT username, temp_password FROM people ORDER BY id').all().map((r) => [r.username, r.temp_password]))
    .toEqual([['soon', null], ['later', null]])
  b.close()
  expect(val(con, 'SELECT temp_password FROM people WHERE id=?', soon)).toBe('Temp-Secret-4711') // live DB untouched
  login(person(con, 'boss', { role: 'admin' }))
  const listed = ok(await get('/api/admin/jobs'))
  expect(listed.map((x: any) => [x.kind, x.target_hosts])).toEqual([['collect', ['gpu01']]]) // no IPMI check any more
  expect(ok(await get(`/api/admin/jobs/${listed[0].id}`)).args.target_hosts).toBe('gpu01')
  rmSync(backupFile)
  con = fresh()
  con.tx(() => con.run('UPDATE hosts SET monitored=1'))
  const at = (h: number, m: number) => {
    const d = new Date()
    d.setHours(h, m, 0, 0)
    return d
  }
  await scheduled(con, at(2, 59))
  expect(con.all('SELECT kind FROM jobs').map((r) => r.kind)).toEqual([])
  await scheduled(con, at(3, 0))
  await scheduled(con, at(3, 35))
  expect(con.all('SELECT kind FROM jobs ORDER BY id').map((r) => r.kind)).toEqual(['collect'])
})

// --- runner: monitoring -----------------------------------------------------------------

test('targets.json', () => {
  const con = fresh()
  con.tx(() => {
    con.run("UPDATE hosts SET monitored=1 WHERE name IN ('gpu01', 'gpu03')")
    con.run("UPDATE hosts SET address='2001:db8::13' WHERE name='gpu03'")
  })
  const file = path.join(config.promSdDir, 'targets.json')
  rmSync(file, { force: true })
  expect(writeTargets(con)).toBe(true)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([
    { targets: ['192.0.2.11:9100'], labels: { instance: 'gpu01', group: 'gpu' } },
    { targets: ['[2001:db8::13]:9100'], labels: { instance: 'gpu03', group: 'legacy' } }])
  expect(statSync(file).mode & 0o777).toBe(0o644)
  const umask = process.umask(0o077) // prometheus runs as another user: 0644 even under a strict umask
  try {
    con.tx(() => con.run("UPDATE hosts SET address='192.0.2.21' WHERE name='gpu01'"))
    expect(writeTargets(con)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o644)
    con.tx(() => con.run("UPDATE hosts SET address='192.0.2.11' WHERE name='gpu01'"))
    expect(writeTargets(con)).toBe(true)
  } finally {
    process.umask(umask)
  }
  const before = [statSync(file).ino, statSync(file).mtimeMs]
  expect(writeTargets(con)).toBe(false)
  expect([statSync(file).ino, statSync(file).mtimeMs]).toEqual(before)
  con.tx(() => con.run("UPDATE hosts SET monitored=0 WHERE name='gpu03'"))
  expect(writeTargets(con)).toBe(true)
  expect(JSON.parse(readFileSync(file, 'utf8')).map((t: any) => t.labels.instance)).toEqual(['gpu01'])
  const port = config.nodeExporterPort
  config.nodeExporterPort = 19100 // NODE_EXPORTER_PORT is honoured
  try {
    expect(writeTargets(con)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))[0].targets).toEqual(['192.0.2.11:19100'])
  } finally {
    config.nodeExporterPort = port
  }
})

test('the inventory file the runner writes for ansible-playbook -i (replaces inventory/portal.py)', () => {
  const con = fresh()
  con.tx(() => {
    con.run("UPDATE hosts SET ssh_no_retry=1 WHERE name='gpu02'")
    con.run("INSERT INTO hosts(name, address, group_name) VALUES ('cpu01', 'cpu01.example.org', 'cpu')")
  })
  rmSync(config.inventoryPath, { force: true })
  expect(writeInventory(con)).toBe(true)
  // YAML-inventory JSON: groups → hosts → hostvars; never ansible_user, nor the BMC addresses still in the hosts table
  expect(JSON.parse(readFileSync(config.inventoryPath, 'utf8'))).toEqual({ all: { children: {
    cpu: { hosts: { cpu01: { ansible_host: 'cpu01.example.org' } } },
    gpu: { hosts: { gpu01: { ansible_host: '192.0.2.11' },
      gpu02: { ansible_host: '192.0.2.12', ansible_ssh_retries: 0 } } },
    legacy: { hosts: { gpu03: { ansible_host: '192.0.2.13' } } },
  } } })
  expect(statSync(config.inventoryPath).mode & 0o777).toBe(0o600)
  expect(writeInventory(con)).toBe(false)
  chmodSync(config.inventoryPath, 0o644) // e.g. written by an older runner: the mode is corrected though the content is the same
  expect(writeInventory(con)).toBe(false)
  expect(statSync(config.inventoryPath).mode & 0o777).toBe(0o600)
  const victim = path.join(TMP, 'victim')
  writeFileSync(victim, 'x')
  symlinkSync(victim, config.inventoryPath.replace(/\.json$/, '.tmp')) // a planted temp file is replaced, not followed
  con.tx(() => con.run("UPDATE hosts SET address='192.0.2.21' WHERE name='gpu01'"))
  const umask = process.umask(0o077) // and a strict umask never leaves the inventory with another mode
  try {
    expect(writeInventory(con)).toBe(true)
  } finally {
    process.umask(umask)
  }
  expect(readFileSync(victim, 'utf8')).toBe('x')
  expect(lstatSync(config.inventoryPath).isFile()).toBe(true)
  expect(statSync(config.inventoryPath).mode & 0o777).toBe(0o600)
  con.tx(() => con.run("DELETE FROM hosts WHERE name='cpu01'"))
  expect(writeInventory(con)).toBe(true)
  expect(JSON.parse(readFileSync(config.inventoryPath, 'utf8')).all.children.cpu).toBeUndefined()
})

test('SSH jobs are skipped while every host is down', async () => {
  const con = fresh()
  const jid = con.tx(() => enqueue(con, 'boss', 'collect', { collect_dir: config.collectDir, target_hosts: 'all' }))
  const calls: Call[] = []
  runnerIo.run = fakeAnsible(calls)
  prometheus([['sum(up{job="node"}) == 0', [vec(0)]]]) // sum(up) == 0 → VPN down
  await runJob(con, job(con, jid))
  expect(calls).toEqual([])
  expect(val(con, 'SELECT status FROM jobs WHERE id=?', jid)).toBe('failed')
})

test('injected fields; agents marks hosts monitored', async () => {
  const con = fresh()
  let agents = 0
  const collect = con.tx(() => {
    agents = enqueue(con, 'boss', 'agents', { target_hosts: 'gpu02' })
    return enqueue(con, 'boss', 'collect', { collect_dir: config.collectDir, target_hosts: 'all' })
  })
  const calls: Call[] = []
  runnerIo.run = fakeAnsible(calls, 1)
  await runJob(con, job(con, collect))
  await runJob(con, job(con, agents))
  expect(val(con, "SELECT monitored FROM hosts WHERE name='gpu02'")).toBe(0) // failed → not listed
  agents = con.tx(() => enqueue(con, 'boss', 'agents', { target_hosts: 'gpu02' }))
  runnerIo.run = fakeAnsible(calls, 0)
  await runJob(con, job(con, agents))
  expect(calls.map((c) => c.data)).toEqual([
    { collect_dir: config.collectDir, target_hosts: 'all', data_mount_glob: '/srv/data*' },
    { target_hosts: 'gpu02', data_mount_glob: '/srv/data*', node_exporter_port: 9100, monitoring_source: '' },
    { target_hosts: 'gpu02', data_mount_glob: '/srv/data*', node_exporter_port: 9100, monitoring_source: '' }])
  expect(calls[1].argv[3]).toContain('monitoring_agents.yaml')
  expect(con.all('SELECT args_json FROM jobs').some((r) => r.args_json.includes('data_mount_glob'))).toBe(false)
  expect(val(con, "SELECT monitored FROM hosts WHERE name='gpu02'")).toBe(1)
  expect(val(con, "SELECT target FROM audit WHERE action='host_monitored'")).toBe('gpu02')
  agentsDone(con, 'gpu01,gpu03')
  expect(val(con, 'SELECT COUNT(*) FROM hosts WHERE monitored=1')).toBe(3)
  con.tx(() => con.run("UPDATE jobs SET status='queued', args_json=? WHERE id=?", JSON.stringify({ target_hosts: 'gpu02', data_mount_glob: '/' }), agents))
  await runJob(con, job(con, agents)) // a stored payload that already carries a † field is refused before anything runs
  expect(val(con, 'SELECT output FROM jobs WHERE id=?', agents).startsWith('[runner] payload rejected')).toBe(true)
})

test('agents marks each successful host', () => {
  const recap = `PLAY RECAP *********************************************************************
gpu01                      : ok=16   changed=13   unreachable=0    failed=0    skipped=2    rescued=0    ignored=1
gpu02                      : ok=0    changed=0    unreachable=1    failed=0    skipped=0    rescued=0    ignored=0
gpu03                      : ok=10   changed=8    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
`
  expect(recapOk(recap, ['gpu01', 'gpu02', 'gpu03'])).toEqual(['gpu01']) // ignored errors are fine
  expect(recapOk(recap, ['gpu02'])).toEqual([])
  expect(recapOk('', ['gpu01'])).toEqual([])
})

// --- removed job kinds --------------------------------------------------------------------

test('jobs of the removed kinds (power, shutdown, bmc_check) stay in the history but never run', async () => {
  const con = fresh()
  const old = con.tx(() => ['power', 'shutdown', 'bmc_check'].map((kind) => con.run(
    "INSERT INTO jobs(kind, args_json, actor, run_at, created_at) VALUES (?, ?, 'boss', '2026-01-01T00:00:00', '2026-01-01T00:00:00')",
    kind, JSON.stringify({ target_hosts: 'gpu01' })).lastInsertRowid))
  const calls: Call[] = []
  runnerIo.run = fakeAnsible(calls)
  for (const jid of old) await runJob(con, job(con, jid))
  expect(calls).toEqual([])
  expect(con.all('SELECT kind, status, output FROM jobs ORDER BY id').map(Object.values)).toEqual([
    ['power', 'failed', '[runner] 已停用的工作類型 power，未執行'],
    ['shutdown', 'failed', '[runner] 已停用的工作類型 shutdown，未執行'],
    ['bmc_check', 'failed', '[runner] 已停用的工作類型 bmc_check，未執行']])
  for (const kind of ['power', 'shutdown', 'bmc_check']) raises(() => argv(kind, 'x'))
  await finish(con, old[0], 'ok', 'late') // only a running job is ever finished
  expect(val(con, 'SELECT status FROM jobs WHERE id=?', old[0])).toBe('failed')
  login(person(con, 'boss', { role: 'admin' })) // still listed, read-only
  expect(ok(await get('/api/admin/jobs')).map((j: any) => [j.kind, j.status])).toEqual([
    ['bmc_check', 'failed'], ['shutdown', 'failed'], ['power', 'failed']])
  expect(ok(await get(`/api/admin/jobs/${old[0]}`)).args).toEqual({ target_hosts: 'gpu01' })
})

// --- admin assignments: scoped single-user jobs; deletions -------------------------------------

/** Run every runnable users job like the runner loop (fake ansible). */
async function runJobs(con: DB, calls: Call[], rc = 0): Promise<void> {
  runnerIo.run = fakeAnsible(calls, rc)
  for (;;) {
    const j = row(con, "SELECT * FROM jobs WHERE status IN ('queued', 'confirmed') AND kind='users' ORDER BY id LIMIT 1")
    if (!j) break
    await runJob(con, j)
  }
}

test('a registration assigned to N hosts runs N scoped jobs without a preview', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const bob = person(con, 'bob', { uid: 20500 })
  observe(con, 'gpu02', 'bob', 20500)
  con.tx(() => {
    adopt(con, 'boss', 'gpu02', 'bob', bob)
    con.run("UPDATE accounts SET desired='locked' WHERE username='bob'") // pending drift on gpu02 that nobody previewed
  })
  setSession({ sso_id: 'N001', email: 'n@example.edu', csrf: 'tok' })
  ok(await post('/api/register', { name: 'New', username: 'newbie', purpose: 'p', gpus: 1, until: '2099-01-01' }))
  login(boss)
  const rid = val(con, "SELECT id FROM requests WHERE sso_id='N001'")
  const a = ok(await post(`/api/admin/requests/${rid}/assign`, { username: 'newbie', hosts: ['gpu01', 'gpu02'] }))
  const pid = a.person_id
  const calls: Call[] = []
  await runJobs(con, calls)
  expect(calls.length).toBe(2) // one per host, both applied directly
  for (const [i, host] of ['gpu01', 'gpu02'].entries()) {
    const c = calls[i]
    expect(c.argv).not.toContain('--check')
    expect([c.data.target_hosts, c.data.only_user, Object.keys(c.data.accounts)]).toEqual([host, 'newbie', [host]])
    expect(c.data).not.toHaveProperty('keys_only')
    expect(c.data.accounts[host].map((e: any) => e.username)).toEqual(['newbie']) // bob's pending lock is not in it
  }
  // one temp password for the new person, the same on every host while it hasn't been shown
  expect(calls[0].data.temp_password).toBeTruthy()
  expect(calls[1].data.temp_password).toBe(calls[0].data.temp_password)
  expect(val(con, 'SELECT temp_password FROM people WHERE id=?', pid)).toBe(calls[0].data.temp_password)
  expect(a.jobs.map((j: any) => val(con, 'SELECT status FROM jobs WHERE id=?', j.job_id))).toEqual(['ok', 'ok'])
  expect(val(con, "SELECT desired FROM accounts WHERE username='bob'")).toBe('locked') // still pending, not applied
  for (const j of a.jobs) expect(val(con, 'SELECT output FROM jobs WHERE id=?', j.job_id)).not.toContain(calls[0].data.temp_password)
})

test('scoped users job rules: the runner needs an assignment record', async () => {
  const con = fresh()
  const alice = person(con, 'alice', { uid: 20000 })
  const bob = person(con, 'bob', { uid: 20001 })
  con.tx(() => {
    grant(con, 'admin', alice, 'gpu01', true)
    grant(con, 'admin', alice, 'gpu02', true)
    grant(con, 'admin', bob, 'gpu01', true)
  })
  const entry = { username: 'alice', uid: 20000, state: 'present', expires: null, keys_add: [], keys_remove: [] }
  const one = { target_hosts: 'gpu01', accounts: { gpu01: [entry] }, only_user: 'alice' }
  validateJob('users', one, con)
  for (const bad of [{ ...one, only_user: 'bob' }, { ...one, only_user: 'root' },
    { ...one, accounts: { gpu01: [entry, { ...entry, username: 'bob' }] } }, { ...one, accounts: { gpu01: [{ ...entry, state: 'locked' }] } },
    { ...one, target_hosts: 'gpu01,gpu02', accounts: { gpu01: [entry], gpu02: [entry] } }]) {
    raises(() => validateJob('users', bad, con))
  }
  raises(() => validateJob('users', { ...one, keys_only: false }, con)) // still never web input
  const refused = '[runner] 單一帳號的 job 沒有對應的管理員指派紀錄，未執行'
  const calls: Call[] = []

  // queued by hand, without the record enqueueHostAccount writes: refused before anything runs
  const bare = con.tx(() => enqueue(con, 'admin', 'users', one, null, true))
  // a record for another host or another person does not count either
  const [wrongHost, wrongPerson, notAuto] = con.tx(() => {
    const w1 = enqueue(con, 'admin', 'users', one, null, true)
    con.run("INSERT INTO assignments(job_id, person_id, host, actor, created_at) VALUES (?,?,'gpu02','admin','t')", w1, alice)
    const w2 = enqueue(con, 'admin', 'users', one, null, true)
    con.run("INSERT INTO assignments(job_id, person_id, host, actor, created_at) VALUES (?,?,'gpu01','admin','t')", w2, bob)
    const w3 = enqueue(con, 'admin', 'users', one, null, false) // previewed and confirmed: still not an assignment's job
    con.run("INSERT INTO assignments(job_id, person_id, host, actor, created_at) VALUES (?,?,'gpu01','admin','t')", w3, alice)
    con.run("UPDATE jobs SET status='confirmed' WHERE id=?", w3)
    return [w1, w2, w3]
  })
  await runJobs(con, calls)
  expect(calls).toEqual([])
  for (const jid of [bare, wrongHost, wrongPerson, notAuto]) {
    expect(Object.values(row(con, 'SELECT status, output FROM jobs WHERE id=?', jid)!)).toEqual(['failed', refused])
  }
  // the real thing; and refused again once the person is locked
  const good = con.tx(() => enqueueHostAccount(con, 'admin', alice, 'gpu01'))!
  await runJobs(con, calls)
  const locked = con.tx(() => {
    const j = enqueueHostAccount(con, 'admin', alice, 'gpu02')!
    con.run("UPDATE people SET status='locked' WHERE id=?", alice)
    return j
  })
  await runJobs(con, calls)
  expect(calls.map((c) => c.data.target_hosts)).toEqual(['gpu01'])
  expect(val(con, 'SELECT status FROM jobs WHERE id=?', good)).toBe('ok')
  expect(val(con, 'SELECT status FROM jobs WHERE id=?', locked)).toBe('failed')
  // the playbook narrows to only_user as well (and asserts one account on one host)
  const pb = readFileSync(path.resolve(import.meta.dirname, '../../../ansible/playbooks/users.yaml'), 'utf8')
  expect(pb).toContain("selectattr('username', '==', only_user)")
  expect(pb).toContain('only_user is not defined or')
})

test('account deletion: previewed, then applied; the playbook guards the home directory', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  observe(con, 'gpu01', 'old', 1005)
  login(boss)
  const jid = ok(await post('/api/admin/hosts/gpu01/accounts/old/delete', { remove_home: true, confirm: 'old' })).job_id
  const calls: Call[] = []
  await runJobs(con, calls)
  expect(val(con, 'SELECT status FROM jobs WHERE id=?', jid)).toBe('awaiting')
  expect(calls[0].argv).toContain('--check')
  expect(calls[0].data.accounts.gpu01).toEqual([
    { username: 'old', uid: 1005, state: 'absent', expires: null, keys_add: [], keys_remove: [], remove_home: true }])
  ok(await post(`/api/admin/jobs/${jid}/confirm`))
  await runJobs(con, calls)
  expect(calls.length).toBe(2)
  expect(calls[1].argv).not.toContain('--check')
  expect(calls[1].data).not.toHaveProperty('keys_only')
  expect(calls[1].data).not.toHaveProperty('temp_password')
  expect(val(con, 'SELECT status FROM jobs WHERE id=?', jid)).toBe('ok')
  // an auto-confirmed (key-only) job never carries a deletion
  con.tx(() => con.run("UPDATE accounts SET exists_on_host=1 WHERE username='old'"))
  expect(con.tx(() => enqueueUsers(con, 'x', null, true))).toBeNull()
  const pb = readFileSync(path.resolve(import.meta.dirname, '../../../ansible/playbooks/users.yaml'), 'utf8')
  expect(pb).toContain("home | basename == item.item.username")
  expect(pb).toContain('remove: "{{ item.remove_home | default(false) }}"')
})

test('cli dynamic inventory: script format with _meta.hostvars, same hosts as the runner file', async () => {
  const { scriptInventory } = await import('../src/inventory.ts')
  const inv = scriptInventory({ all: { children: {
    no_shutdown: { hosts: { gpu02: {} } },
    gpu: { hosts: { gpu01: { ansible_host: '192.0.2.11' }, gpu02: { ansible_host: '192.0.2.12', ansible_ssh_retries: 0 } } },
  } } })
  expect(inv).toEqual({
    no_shutdown: { hosts: ['gpu02'] },
    gpu: { hosts: ['gpu01', 'gpu02'] },
    _meta: { hostvars: { gpu01: { ansible_host: '192.0.2.11' }, gpu02: { ansible_host: '192.0.2.12', ansible_ssh_retries: 0 } } },
  })
})


// --- what the member and the admins see of an assignment's jobs ----------------------------------

test('the temp password shows once an account-creation job succeeded, until its owner acknowledges it', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  setSession({ sso_id: 'N007', email: 'n7@example.edu', csrf: 'tok' })
  ok(await post('/api/register', { name: 'New', username: 'newbie', purpose: 'p', gpus: 1, until: '2099-01-01' }))
  login(boss)
  const rid = val(con, "SELECT id FROM requests WHERE sso_id='N007'")
  const a = ok(await post(`/api/admin/requests/${rid}/assign`, { username: 'newbie', hosts: ['gpu01', 'gpu02'] }))
  setSession({ sso_id: 'N007', csrf: 'tok' })
  let me = ok(await get('/api/me'))
  expect([me.temp_password, me.account_setup]).toEqual([null, 'pending']) // 帳號建立中
  expect(me.accounts.map((x: any) => [x.host, x.address, x.job_status])).toEqual([['gpu01', '192.0.2.11', 'queued'], ['gpu02', '192.0.2.12', 'queued']])

  // both jobs fail (e.g. unreachable): the password the runner made is never shown, the member sees the failure
  const calls: Call[] = []
  await runJobs(con, calls, 4)
  expect(calls[0].data.temp_password).toBeTruthy()
  expect(val(con, 'SELECT temp_password_pending FROM people WHERE id=?', a.person_id)).toBe(1)
  me = ok(await get('/api/me'))
  expect([me.temp_password, me.account_setup]).toEqual([null, 'failed']) // 開通失敗
  expect(me.accounts.map((x: any) => x.job_status)).toEqual(['failed', 'failed'])
  expect(NOTIFIED.filter((m) => m.startsWith('[失敗]'))[0]).toBe(`[失敗] 指派 newbie @gpu01（#${a.jobs[0].job_id}）：工作失敗，請看下方輸出\n`
    + `https://portal.test/admin/jobs/${a.jobs[0].job_id}`)

  // the admin re-runs one of them: a new assignment of the same person and host; it succeeds → the password shows
  login(boss)
  const again = ok(await post(`/api/admin/jobs/${a.jobs[0].job_id}/rerun`))
  expect([again.kind, again.status, again.summary, again.scoped]).toEqual(['users', 'queued', '指派 newbie @gpu01', true])
  expect(row(con, 'SELECT person_id, host, request_id FROM assignments WHERE job_id=?', again.id))
    .toEqual({ person_id: a.person_id, host: 'gpu01', request_id: rid })
  setSession({ sso_id: 'N007', csrf: 'tok' })
  expect(ok(await get('/api/me')).account_setup).toBe('pending')
  await runJobs(con, calls, 0)
  expect(calls.at(-1)!.data.temp_password).toBe(calls[0].data.temp_password) // the same one, never shown before
  me = ok(await get('/api/me'))
  expect([me.temp_password, me.account_setup]).toEqual([calls[0].data.temp_password, null])
  expect(ok(await get('/api/me')).temp_password).toBe(me.temp_password) // a reload shows it again
  ok(await post('/api/me/temp-password/ack')) // 我已記下
  expect(ok(await get('/api/me')).temp_password).toBeNull()
  expect(val(con, 'SELECT temp_password FROM people WHERE id=?', a.person_id)).toBeNull()

  // only a failed job can be re-run, and only while it still makes sense
  login(boss)
  err(await post(`/api/admin/jobs/${again.id}/rerun`), 409, '只有失敗的工作')
  con.tx(() => con.run("UPDATE people SET status='locked' WHERE id=?", a.person_id))
  err(await post(`/api/admin/jobs/${a.jobs[1].job_id}/rerun`), 400, '人員已停用')
  expect(con.all("SELECT detail_json FROM audit WHERE action='job_rerun'").map((r) => JSON.parse(r.detail_json)))
    .toEqual([{ from: a.jobs[0].job_id }])
})

test('a preview that could not run (unreachable) is 預檢失敗, never awaiting confirmation', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  observe(con, 'gpu01', 'old', 1005)
  login(boss)
  const jid = ok(await post('/api/admin/hosts/gpu01/accounts/old/delete', { remove_home: false })).job_id
  const fatal = 'fatal: [gpu01]: UNREACHABLE! => {"changed": false, "msg": "Failed to connect to the host via ssh: '
    + 'No ED25519 host key is known for 192.0.2.11 and you have requested strict checking.\\r\\nHost key verification failed.", "unreachable": true}'
  runnerIo.run = async () => ({ rc: 4, out: `PLAY [users]\n${fatal}\nPLAY RECAP\ngpu01 : ok=0 changed=0 unreachable=1 failed=0\n` })
  await runJob(con, job(con, jid))
  const j = ok(await get(`/api/admin/jobs/${jid}`))
  expect([j.status, j.output, j.finished_at === null]).toEqual(['check_failed', null, false])
  expect(j.check_output).toContain('[rc=4]')
  expect(j.summary).toBe('刪除 old @gpu01')
  expect(j.failure).toBe('預檢無法連線到 gpu01，未產生預覽，請修正後重新排程（主機尚未 bootstrap 或無法連線（監控主機不認得它的 SSH host key））')
  expect(NOTIFIED.at(-1)).toBe(`[預檢失敗] 刪除 old @gpu01（#${jid}）：${j.failure}\nhttps://portal.test/admin/jobs/${jid}`)
  err(await post(`/api/admin/jobs/${jid}/confirm`), 409) // nothing to confirm
  // rc 2 (a task failed on the host) still gives a preview to read: awaiting
  const jid2 = ok(await post(`/api/admin/jobs/${jid}/rerun`)).id
  expect(ok(await get(`/api/admin/jobs/${jid2}`)).summary).toBe('刪除 old @gpu01')
  runnerIo.run = async () => ({ rc: 2, out: 'fatal: [gpu01]: FAILED! => {"msg": "x"}\n' })
  await runJob(con, job(con, jid2))
  expect(val(con, 'SELECT status FROM jobs WHERE id=?', jid2)).toBe('awaiting')
  expect(NOTIFIED.at(-1)).toBe(`[待確認] 刪除 old @gpu01（#${jid2}）預覽完成（rc=2）：https://portal.test/admin/jobs/${jid2}`)
})
