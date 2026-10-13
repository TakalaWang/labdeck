import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import {
  addHosts, adopt, allocUid, audit, config, DB, db, loadConfig, openDb, diskCheck, enqueue, enqueueUsers, grant, ingest, initDb, inventory,
  inventoryHostvars, iso, notifications, parseDate, parseDatetime, parsePubkey, promql, pyFixed, schemaSql, strings,
  usersPayload, validAddress, validateHost, validateJob, validUsername, PLAYBOOKS, PROMQL, normalizeNetwork, describeJob, failureHint,
  failureSummary,
} from '../src/index.ts'
import { HOSTS, TMP, fresh, keygen, observe, person, raises, row, val } from './helpers.ts'

// --- validators ---------------------------------------------------------------------------

test('username validator', () => {
  for (const bad of ['alice; rm -rf /', 'root', 'labbot', 'ops', 'backup', 'Alice', 'a'.repeat(33), '', '1abc', 'alice\n', 'al ice',
    '-x', '$(id)', '../x', null, 5]) {
    expect(validUsername(bad), String(bad)).toBe(false)
  }
  for (const good of ['alice', '_x', 'a'.repeat(32), 'b0b-1_']) expect(validUsername(good), good).toBe(true)
})

test('pubkey validator', () => {
  const ed = keygen('ed', '-t', 'ed25519')
  const [line, fp] = parsePubkey(`${ed}\n`)
  expect(line).toBe(ed)
  expect(fp.startsWith('SHA256:')).toBe(true)
  expect(parsePubkey(keygen('rsa3k', '-t', 'rsa', '-b', '3072'))[1].startsWith('SHA256:')).toBe(true)
  raises(() => parsePubkey(keygen('rsa2k', '-t', 'rsa', '-b', '2048')), '3072')
  const blob = ed.split(' ')[1]
  for (const bad of [`command="rm -rf /" ${ed}`, `from="192.0.2.1" ${ed}`, `no-pty ${ed}`, `${ed}\n${ed}`,
    `ssh-ed25519 ${blob} a\nb`, `ssh-rsa ${blob} x`, `ssh-dss ${blob}`, 'ssh-ed25519 AAAAnotakey',
    `ssh-ed25519 ${blob} ${'c'.repeat(101)}`, `ssh-ed25519  ${blob}`, '']) {
    raises(() => parsePubkey(bad))
  }
  // the comment ends up in an Ansible job: nothing that could be template code
  for (const comment of ['x{{ 7*7 }}y', '{% raw %}', '{#', 'a}', 'my laptop', "o'brien", 'a;b', '$(id)', '`id`', '\\']) {
    raises(() => parsePubkey(`ssh-ed25519 ${blob} ${comment}`), '註解只能包含英數字')
  }
  for (const comment of ['alice@laptop', 'a.b_c+d=e:f-g', 'x'.repeat(100)]) {
    expect(parsePubkey(`ssh-ed25519 ${blob} ${comment}`)[0]).toBe(`ssh-ed25519 ${blob} ${comment}`)
  }
  expect(parsePubkey(`ssh-ed25519 ${blob}`)[0]).toBe(`ssh-ed25519 ${blob}`)
})

test('date validators', () => {
  expect(parseDate('2027-07-31')).toBe('2027-07-31')
  expect(parseDatetime('2026-09-27T10:00')).toBe('2026-09-27T10:00:00')
  for (const bad of ['2026-13-01', '2026-01-01; x', '27/07/2027', '', null]) raises(() => parseDate(bad))
  expect(parseDatetime('2026-09-27T02:00:00.123Z')).toBe('2026-09-27T10:00:00') // offsets → container TZ
  expect(parseDatetime('2026-09-27T10:00+08:00')).toBe('2026-09-27T10:00:00')
  raises(() => parseDatetime("2026-09-27 10:00' OR 1=1"))
  raises(() => parseDatetime('2026-09-27T10:00+8'))
  expect(iso('2026-09-27T10:00:00')).toBe('2026-09-27T10:00:00+08:00')
  expect(iso(1790000000)!.endsWith('+08:00')).toBe(true)
  expect(iso(null)).toBeNull()
  expect(iso(0)).toBeNull()
})

test('validate_job', () => {
  const con = fresh()
  const entry = { username: 'alice', uid: 20000, state: 'present', expires: null, keys_add: [] as string[], keys_remove: [] as string[] }
  const okUsers = { target_hosts: 'gpu01', accounts: { gpu01: [entry] } }
  validateJob('users', okUsers, con)
  validateJob('collect', { collect_dir: config.collectDir, target_hosts: 'all' }, con)
  validateJob('agents', { target_hosts: 'gpu01,gpu03' }, con)
  const bad: [string, Record<string, unknown>][] = [
    ['nope', { target_hosts: 'gpu01' }],
    ['collect', { collect_dir: '/etc', target_hosts: 'all' }],
    // † fields are injected by the runner only; unknown keys never pass
    ['collect', { collect_dir: config.collectDir, target_hosts: 'all', data_mount_glob: '/' }],
    ['agents', { target_hosts: 'gpu01', data_mount_glob: '/' }],
    ['agents', { target_hosts: 'gpu01', node_exporter_port: 22 }],
    ['agents', { target_hosts: 'gpu01', monitoring_source: '0.0.0.0/0' }],
    ['agents', { target_hosts: 'gpu01', extra: 1 }],
    ['agents', { target_hosts: 'all' }],
    ['agents', { target_hosts: 'gpu99' }],
    ['users', { ...okUsers, reserved_users: [] }],
    // remote power control was removed: its kinds never validate, whatever the payload
    ['bmc_check', { target_hosts: 'gpu01' }],
    ['power', { target_hosts: 'gpu01', power_state: 'on' }],
    ['shutdown', { target_hosts: 'gpu01', action: 'poweroff', delay_min: 10 }],
    ['agents', { target_hosts: 'gpu01,gpu01' }],
    ['agents', { target_hosts: 'gpu01;reboot' }],
    ['users', { ...okUsers, temp_password: 'leak' }],
    ['users', { target_hosts: 'gpu01,gpu02', accounts: okUsers.accounts }],
  ]
  for (const [field, value] of [['username', 'root'], ['username', 'x;id'], ['uid', 0], ['uid', '20000'], ['state', 'absent'],
    ['expires', 'never'], ['keys_add', ['command="x" ssh-ed25519 AAAA']]] as [string, unknown][]) {
    bad.push(['users', { target_hosts: 'gpu01', accounts: { gpu01: [{ ...entry, [field]: value }] } }])
  }
  for (const [kind, args] of bad) raises(() => validateJob(kind, args, con))
  // Jinja markers anywhere in a payload (e.g. a key queued before comments were restricted) never reach Ansible
  for (const key of ["ssh-ed25519 AAAA x{{ lookup('pipe', 'id') }}", 'ssh-ed25519 AAAA {% x %}', 'ssh-ed25519 AAAA }']) {
    for (const field of ['keys_add', 'keys_remove']) {
      raises(() => validateJob('users', { target_hosts: 'gpu01', accounts: { gpu01: [{ ...entry, [field]: [key] }] } }, con), '{ 或 }')
    }
  }
  raises(() => validateJob('collect', { collect_dir: config.collectDir, target_hosts: '{{ x }}' }, con), '{ 或 }')
  raises(() => validateJob('agents', { target_hosts: 'gpu01', '{{ x }}': 1 }, con), '{ 或 }') // object keys too
  expect([...strings({ a: ['b', { c: 1, d: [null, 'e'] }] })]).toEqual(['a', 'b', 'c', 'd', 'e'])
  const stored = { ...entry, keys_add: ['ssh-ed25519 AAAA an old comment with spaces'] } // accepted before the comment rule
  validateJob('users', { target_hosts: 'gpu01', accounts: { gpu01: [stored] } }, con)
  // deletion: remove_home (a boolean) exactly on state absent, which carries no expiry or keys
  const gone = { ...entry, state: 'absent', remove_home: true }
  validateJob('users', { target_hosts: 'gpu01', accounts: { gpu01: [gone] } }, con)
  for (const e of [{ ...entry, state: 'absent' }, { ...entry, remove_home: false }, { ...gone, remove_home: 'yes' },
    { ...gone, expires: '2027-01-01' }, { ...gone, keys_add: ['ssh-ed25519 AAAA a'] }]) {
    raises(() => validateJob('users', { target_hosts: 'gpu01', accounts: { gpu01: [e] } }, con))
  }
  raises(() => validateJob('users', { target_hosts: 'gpu01', accounts: { gpu01: [gone] }, only_user: 'alice' }, con), 'only_user')
})

// --- core logic ---------------------------------------------------------------------------

test('payload builder', () => {
  const base = { desired: 'present', managed: 1, expires_at: '2027-01-01' }
  const rows = [
    { ...base, host: 'gpu02', username: 'alice', expected_uid: 1005, person_id: 1 },
    { ...base, host: 'gpu01', username: 'alice', expected_uid: 1001, person_id: 1 },
    { ...base, host: 'gpu01', username: 'bob', expected_uid: 1002, person_id: 2, managed: 0 },
    { ...base, host: 'gpu03', username: 'carol', expected_uid: 1003, person_id: null },
    { ...base, host: 'gpu03', username: 'dave', expected_uid: 20000, person_id: 4, desired: 'locked', expires_at: null },
  ]
  const keys = new Map([
    [1, { active: ['ssh-ed25519 AAAA a'], revoked: ['ssh-ed25519 BBBB r'] }],
    [4, { active: ['ssh-ed25519 CCCC d'], revoked: [] }],
  ])
  const p = usersPayload(rows, keys)
  expect(p.target_hosts).toBe('gpu01,gpu02,gpu03')
  expect(p.accounts.gpu01).toEqual([{ username: 'alice', uid: 1001, state: 'present', expires: '2027-01-01',
    keys_add: ['ssh-ed25519 AAAA a'], keys_remove: ['ssh-ed25519 BBBB r'] }])
  expect(p.accounts.gpu02[0].uid).toBe(1005)
  expect(p.accounts.gpu03).toEqual([{ username: 'dave', uid: 20000, state: 'locked', expires: null, keys_add: [], keys_remove: [] }])
  expect(JSON.stringify(p)).not.toContain('temp_password')
  validateJob('users', p, fresh())
  // to delete: rows without a person count too (an old account nobody was assigned); no keys or expiry
  const del = usersPayload([
    { ...base, host: 'gpu01', username: 'old', expected_uid: 1007, person_id: null, desired: 'absent', remove_home: 1 },
    { ...base, host: 'gpu01', username: 'alice', expected_uid: 1001, person_id: 1, desired: 'absent', remove_home: 0 },
  ], keys)
  expect(del.accounts.gpu01).toEqual([
    { username: 'alice', uid: 1001, state: 'absent', expires: null, keys_add: [], keys_remove: [], remove_home: false },
    { username: 'old', uid: 1007, state: 'absent', expires: null, keys_add: [], keys_remove: [], remove_home: true }])
  validateJob('users', del, fresh())
})

test('enqueue_users never stores the password', () => {
  const con = fresh()
  const pid = person(con, 'bob')
  let jid = 0
  con.tx(() => {
    con.run("UPDATE people SET temp_password='hunter2hunter2' WHERE id=?", pid)
    grant(con, 'admin', pid, 'gpu01', true)
    jid = enqueueUsers(con, 'admin', pid)!
  })
  expect(val(con, 'SELECT args_json FROM jobs WHERE id=?', jid)).not.toContain('hunter2')
  con.tx(() => expect(enqueueUsers(con, 'bob', pid, true)).toBeNull()) // key-only: nothing exists yet → no job
})

test('audit is append-only', () => {
  const con = fresh()
  con.tx(() => audit(con, 't', 'x', 'y'))
  for (const sql of ["UPDATE audit SET actor='evil'", 'DELETE FROM audit']) raises(() => con.exec(sql), 'append-only')
  expect(val(con, 'SELECT actor FROM audit')).toBe('t')
})

test('ingest', () => {
  const con = fresh()
  const pid = person(con, 'alice')
  observe(con, 'gpu01', 'alice', 1001)
  observe(con, 'gpu01', 'gone', 1009)
  con.tx(() => con.run("UPDATE accounts SET managed=1, person_id=?, desired='present', expected_uid=1001 WHERE username='alice'", pid))
  const data = {
    host: 'gpu01', collected_at: 1790000000,
    facts: { os: 'Ubuntu 22.04.4 LTS', gpus: [], gpu_pci_count: 0, disks: [], mounts: [] },
    accounts: [{ username: 'alice', uid: 1001, last_login: 1789990000, home_mtime: null, locked: true, expires: '2027-07-31' },
      { username: 'newbie', uid: 1010, last_login: null, home_mtime: 1, locked: false, expires: null }],
    logins: [{ username: 'alice', src: '203.0.113.7', ts: 1789990000 }],
  }
  writeFileSync(path.join(config.collectDir, 'gpu01.json'), JSON.stringify(data))
  writeFileSync(path.join(config.collectDir, 'rogue.json'), JSON.stringify({ ...data, host: 'rogue' }))
  expect(ingest(con)).toEqual(['gpu01'])
  expect(ingest(con)).toEqual(['gpu01']) // idempotent
  expect(val(con, "SELECT exists_on_host FROM accounts WHERE username='gone'")).toBe(0)
  const a = row(con, "SELECT * FROM accounts WHERE username='alice'")!
  expect([a.exists_on_host, a.observed_locked, a.observed_expires]).toEqual([1, 1, '2027-07-31'])
  expect([a.managed, a.desired, a.person_id, a.expected_uid]).toEqual([1, 'present', pid, 1001])
  const nb = row(con, "SELECT * FROM accounts WHERE username='newbie'")!
  expect([nb.managed, nb.person_id, nb.desired, nb.exists_on_host]).toEqual([0, null, null, 1])
  expect(val(con, 'SELECT COUNT(*) FROM logins')).toBe(1)
  expect(JSON.parse(val(con, "SELECT facts_json FROM hosts WHERE name='gpu01'")).os.startsWith('Ubuntu')).toBe(true)
  expect(row(con, "SELECT 1 FROM hosts WHERE name='rogue'")).toBeUndefined()
})

test('ingest keeps accounts when the host could not list them', () => {
  const con = fresh()
  observe(con, 'gpu01', 'alice', 1001)
  const data = { host: 'gpu01', collected_at: 1790000000, facts: { os: 'Ubuntu 22.04.4 LTS' }, accounts: null,
    logins: [{ username: 'alice', src: '203.0.113.7', ts: 1789990000 }] }
  writeFileSync(path.join(config.collectDir, 'gpu01.json'), JSON.stringify(data))
  expect(ingest(con)).toEqual(['gpu01'])
  expect(Object.values(row(con, "SELECT exists_on_host, uid FROM accounts WHERE username='alice'")!)).toEqual([1, 1001])
  expect(JSON.parse(val(con, "SELECT facts_json FROM hosts WHERE name='gpu01'")).os.startsWith('Ubuntu')).toBe(true)
  expect(val(con, 'SELECT COUNT(*) FROM logins')).toBe(1)
  writeFileSync(path.join(config.collectDir, 'gpu01.json'), JSON.stringify({ ...data, accounts: [] })) // a real, empty answer
  expect(ingest(con)).toEqual(['gpu01'])
  expect(val(con, "SELECT exists_on_host FROM accounts WHERE username='alice'")).toBe(0)
})

test('adopt sets people.uid only when consistent', () => {
  const con = fresh()
  observe(con, 'gpu01', 'alice', 1001)
  observe(con, 'gpu02', 'alice', 1001)
  const alice = con.tx(() => adopt(con, 'admin', 'gpu01', 'alice'))
  expect(val(con, 'SELECT uid FROM people WHERE id=?', alice)).toBe(1001)
  con.tx(() => adopt(con, 'admin', 'gpu02', 'alice', alice))
  // uid 1003 is also used by another username → people.uid stays NULL
  observe(con, 'gpu01', 'bob', 1003)
  observe(con, 'gpu02', 'carol', 1003)
  observe(con, 'gpu03', 'bob', 1006)
  const bob = con.tx(() => adopt(con, 'admin', 'gpu01', 'bob'))
  expect(val(con, 'SELECT uid FROM people WHERE id=?', bob)).toBeNull()
  con.tx(() => adopt(con, 'admin', 'gpu03', 'bob', bob)) // now inconsistent (1003 vs 1006) → still NULL
  expect(val(con, 'SELECT uid FROM people WHERE id=?', bob)).toBeNull()
  const a = row(con, "SELECT * FROM accounts WHERE host='gpu03' AND username='bob'")!
  expect([a.managed, a.expected_uid, a.desired]).toEqual([1, 1006, 'present'])
  observe(con, 'gpu03', 'locky', 1007, 1)
  con.tx(() => adopt(con, 'admin', 'gpu03', 'locky'))
  expect(val(con, "SELECT desired FROM accounts WHERE username='locky'")).toBe('locked')
  observe(con, 'gpu03', 'alice', 1001)
  raises(() => adopt(con, 'admin', 'gpu03', 'alice'), '同名') // never auto-link by name
  observe(con, 'gpu01', 'ops', 1000) // RESERVED_USERS
  raises(() => adopt(con, 'admin', 'gpu01', 'ops'))
  observe(con, 'gpu01', 'labbot', 999) // BOT_USER
  raises(() => adopt(con, 'admin', 'gpu01', 'labbot'))
  raises(() => adopt(con, 'admin', 'gpu01', 'alice'), '已受管理')
})

test('alloc_uid', () => {
  const con = fresh()
  person(con, 'p1', { uid: 20000 })
  observe(con, 'gpu01', 'x', 20001)
  con.tx(() => con.run("INSERT INTO accounts(host, username, expected_uid, managed) VALUES ('gpu02', 'y', 20003, 1)"))
  expect(allocUid(con)).toBe(20002)
})

test('grants', () => {
  const con = fresh()
  const alice = person(con, 'alice')
  observe(con, 'gpu01', 'alice', 1001)
  raises(() => grant(con, 'admin', alice, 'gpu01', true), '請先認領')
  raises(() => grant(con, 'admin', alice, 'gpu02', true), 'UID 衝突') // has an unadopted account elsewhere
  const bob = person(con, 'bob')
  con.tx(() => grant(con, 'admin', bob, 'gpu02', true))
  const a = row(con, "SELECT * FROM accounts WHERE host='gpu02' AND username='bob'")!
  expect([a.managed, a.desired, a.expected_uid, a.person_id]).toEqual([1, 'present', 20000, bob])
  expect(val(con, 'SELECT uid FROM people WHERE id=?', bob)).toBe(20000)
  con.tx(() => grant(con, 'admin', bob, 'gpu02', false))
  expect(val(con, "SELECT desired FROM accounts WHERE host='gpu02' AND username='bob'")).toBe('locked')
  observe(con, 'gpu03', 'squatter', 20000)
  raises(() => grant(con, 'admin', bob, 'gpu03', true), 'UID 衝突')
  const locked = person(con, 'dave', { status: 'locked' })
  raises(() => grant(con, 'admin', locked, 'gpu01', true), '鎖定')
})

// --- hosts ------------------------------------------------------------------------------

test('host validators', () => {
  const ok = { name: 'gpu04', address: '192.0.2.14', group_name: 'gpu' }
  expect(validateHost(ok)).toEqual(ok)
  expect(validateHost({ ...ok, bmc_address: '198.51.100.1,x' })).toEqual(ok) // removed with remote power control: ignored
  for (const good of ['192.0.2.11', '2001:db8::1', 'gpu01', 'gpu01.example.org', 'GPU-01']) expect(validAddress(good), good).toBe(true)
  for (const bad of ['', '192.0.2.1 ', ' 192.0.2.1', '192.0.2.1,192.0.2.2', 'a b', 'gpu01\n', 'gpu\n01', '-oProxyCommand=x',
    'a..b', 'a_b', '999.1.1.1', '12345', 'fe80::1%eth0', 'x'.repeat(254), 'a;b', null, 5]) {
    expect(validAddress(bad), String(bad)).toBe(false)
  }
  for (const bad of ['', '-gpu', '.x', 'a b', 'a,b', 'gpu\n01', 'all', 'ungrouped', 'no_shutdown', 'a'.repeat(64), 'a/b', 'a:b',
    'a*', '!a']) {
    raises(() => validateHost({ ...ok, name: bad }), '主機名稱')
  }
  for (const bad of ['192.0.2.1 192.0.2.2', '192.0.2.1,192.0.2.2', 'gpu\n01', '']) raises(() => validateHost({ ...ok, address: bad }), '位址')
  for (const bad of ['all', 'ungrouped', 'no_shutdown', '1gpu', 'gpu-a', 'gpu a', 'g'.repeat(33), '']) {
    raises(() => validateHost({ ...ok, group_name: bad }), '群組')
  }
  const con = fresh() // a host named like a group would widen target_hosts to the whole group
  for (const clash of [{ ...ok, name: 'gpu' }, { ...ok, group_name: 'gpu01' }]) {
    raises(() => con.tx(() => addHosts(con, 't', [validateHost(clash)])), '群組名稱相同')
  }
  expect(val(con, 'SELECT COUNT(*) FROM hosts')).toBe(3)
})

test('SESSION_SECRET is required in production', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, SESSION_SECRET: process.env.SESSION_SECRET, NEXT_PHASE: process.env.NEXT_PHASE }
  const set = (vars: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
  try {
    const long = 'x'.repeat(32)
    for (const secret of [undefined, '', 'x'.repeat(31)]) {
      set({ NODE_ENV: 'production', SESSION_SECRET: secret, NEXT_PHASE: undefined })
      raises(() => loadConfig(), 'SESSION_SECRET 未設定或少於 32 字元')
      set({ NEXT_PHASE: 'phase-production-build' }) // next build imports the server code without the runtime .env
      expect(() => loadConfig()).not.toThrow()
    }
    set({ NODE_ENV: 'development', SESSION_SECRET: undefined, NEXT_PHASE: undefined }) // dev/test: a random one per start
    expect(loadConfig().sessionSecret).toHaveLength(43)
    expect(loadConfig().sessionSecret).not.toBe(loadConfig().sessionSecret)
    set({ NODE_ENV: 'production', SESSION_SECRET: long, NEXT_PHASE: 'phase-production-server' })
    expect(loadConfig().sessionSecret).toBe(long)
  } finally {
    set(saved)
  }
})

test('MONITORING_SOURCE normalization (ip_network strict=False)', () => {
  expect(normalizeNetwork('172.31.250.5/24')).toBe('172.31.250.0/24')
  expect(normalizeNetwork('192.0.2.7')).toBe('192.0.2.7/32')
  expect(normalizeNetwork('2001:db8::1/64')).toBe('2001:db8::/64')
  raises(() => normalizeNetwork('300.1.1.1/8'))
  raises(() => normalizeNetwork('10.0.0.0/33'))
})

test('migrate an old schema', () => {
  // A DB made by the previous schema.sql (pilot deployment) gets the IPMI columns and job kind; rows survive.
  const schema = schemaSql()
  let old = schema.replace(
    /\n {2}-- (IPMI|cancel-shutdown).*|\n {2}(bmc_status|bmc_power|bmc_checked_at|bmc_note|console|boot_risk|ssh_no_retry|shutdown_cancelled_at|shutdown_cancel_job_id) .*/g,
    '',
  )
  old = old.replace(", 'bmc_check'", '')
  for (const s of ['bmc_status', 'bmc_check', 'boot_risk', 'ssh_no_retry', 'shutdown_cancel']) expect(old).not.toContain(s)
  config.dbPath = path.join(TMP, 'pilot', 'portal.db')
  mkdirSync(path.dirname(config.dbPath))
  const raw = new DatabaseSync(config.dbPath)
  raw.exec(old)
  raw.exec("INSERT INTO hosts(name, address, group_name, bmc_address, no_shutdown) VALUES ('gpu01', '192.0.2.11', 'gpu', '198.51.100.11', 1)")
  const jid = Number(raw.prepare("INSERT INTO jobs(kind, args_json, actor, run_at, created_at) VALUES ('shutdown', '{}', 'a', 't', 't')").run().lastInsertRowid)
  raw.prepare("INSERT INTO announcements(title, body, shutdown_job_id, created_by, created_at) VALUES ('t', 'b', ?, 'a', 't')").run(jid)
  raw.exec("INSERT INTO audit(ts, actor, action) VALUES ('t', 'a', 'x')")
  raises(() => raw.exec("INSERT INTO jobs(kind, args_json, actor, run_at, created_at) VALUES ('bmc_check', '{}', 'a', 't', 't')"), 'CHECK')
  raw.close()
  const pre = new DB(config.dbPath) // the inventory of a DB not migrated yet
  expect(inventoryHostvars(pre)).toEqual({ gpu01: { ansible_host: '192.0.2.11' } })
  pre.close()

  initDb()
  const con = db()
  const pages = con.all('SELECT name, rootpage FROM sqlite_master ORDER BY name')
  initDb() // idempotent: nothing is rebuilt the second time
  expect(con.all('SELECT name, rootpage FROM sqlite_master ORDER BY name')).toEqual(pages)
  const backups = readdirSync(path.join(TMP, 'pilot', 'backup')) // one copy taken before the rebuild, none the second time
  expect(backups).toHaveLength(1)
  expect(backups[0]).toMatch(/^pre-migrate-\d{8}T\d{6}-\d{3}Z\.db$/)
  const copy = path.join(TMP, 'pilot', 'backup', backups[0])
  expect(statSync(copy).mode & 0o777).toBe(0o600)
  const saved = new DatabaseSync(copy)
  expect(saved.prepare('SELECT name, no_shutdown FROM hosts').all()).toEqual([{ name: 'gpu01', no_shutdown: 1 }])
  expect(saved.prepare("SELECT 1 FROM pragma_table_info('hosts') WHERE name='bmc_status'").get()).toBeUndefined() // the old schema
  saved.close()
  const h = row(con, 'SELECT * FROM hosts')!
  expect([h.name, h.bmc_address, h.no_shutdown, h.bmc_status, h.console, h.boot_risk, h.ssh_no_retry])
    .toEqual(['gpu01', '198.51.100.11', 1, null, null, 0, 0])
  expect(inventory(con).get('gpu01')).toEqual({ ip: '192.0.2.11', groups: ['gpu'], monitored: false })
  // the removed kinds stay allowed by the schema (old jobs keep their history) but can't be queued any more
  con.exec("INSERT INTO jobs(kind, args_json, actor, run_at, created_at) VALUES ('bmc_check', '{}', 'a', 't', 't')")
  raises(() => con.tx(() => enqueue(con, 't', 'bmc_check', { target_hosts: 'gpu01' })), 'unknown job kind')
  expect(val(con, 'SELECT shutdown_job_id FROM announcements')).toBe(jid)
  expect(con.all('PRAGMA foreign_key_check')).toEqual([])
  expect(Object.values(row(con, 'SELECT shutdown_cancelled_at, shutdown_cancel_job_id FROM announcements')!)).toEqual([null, null])
  raises(() => con.exec("UPDATE hosts SET bmc_status='broken'"), 'CHECK')
  raises(() => con.exec('DELETE FROM audit'), 'append-only') // triggers are back
  expect(val(con, 'PRAGMA foreign_keys')).toBe(1)
})

test('migrate a DB with old account and host requests', () => {
  // Before registrations: requests without needs columns, accounts without deletion, no assignments table.
  const OLD_ACCOUNTS = `CREATE TABLE IF NOT EXISTS accounts (
  host TEXT NOT NULL, username TEXT NOT NULL, uid INTEGER, last_login INTEGER, home_mtime INTEGER, observed_locked INTEGER,
  observed_expires TEXT, exists_on_host INTEGER NOT NULL DEFAULT 0, seen_at INTEGER, person_id INTEGER REFERENCES people(id),
  managed INTEGER NOT NULL DEFAULT 0, desired TEXT CHECK (desired IN ('present', 'locked')), expected_uid INTEGER,
  primary_user INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (host, username)
);`
  const OLD_REQUESTS = `CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'account' CHECK (kind IN ('account', 'hosts')),
  person_id INTEGER REFERENCES people(id), sso_id TEXT NOT NULL, email TEXT, username TEXT NOT NULL, hosts_json TEXT NOT NULL,
  reason TEXT NOT NULL, expected_end TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by TEXT, decided_at TEXT, job_id INTEGER REFERENCES jobs(id), created_at TEXT NOT NULL
);`
  const table = (name: string) => new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`)
  const old = schemaSql().replace(table('accounts'), OLD_ACCOUNTS).replace(table('requests'), OLD_REQUESTS).replace(table('assignments'), '')
  expect(old).not.toContain('EXISTS assignments')
  expect(old).not.toMatch(/min_vram_gb +INTEGER/)
  config.dbPath = path.join(TMP, 'old-requests', 'portal.db')
  mkdirSync(path.dirname(config.dbPath))
  const raw = new DatabaseSync(config.dbPath)
  raw.exec(old)
  raw.exec(`INSERT INTO people(id, username, uid, sso_id, created_at) VALUES (1, 'alice', 20000, 'S001', 't');
    INSERT INTO accounts(host, username, uid, exists_on_host, person_id, managed, desired, expected_uid)
      VALUES ('gpu01', 'alice', 20000, 1, 1, 1, 'present', 20000), ('gpu02', 'alice', 20000, 1, 1, 1, 'locked', 20000);
    INSERT INTO jobs(id, kind, args_json, actor, run_at, created_at) VALUES (5, 'users', '{}', 'a', 't', 't');
    INSERT INTO requests(kind, sso_id, email, username, hosts_json, reason, expected_end, status, job_id, created_at)
      VALUES ('account', 'S001', 'a@example.edu', 'alice', '["gpu01"]', 'thesis', '2099-01-01', 'approved', 5, 't'),
             ('account', 'N009', 'n@example.edu', 'newbie', '["gpu01","gpu02"]', 'course', '2099-06-30', 'pending', NULL, 't');
    INSERT INTO requests(kind, person_id, sso_id, username, hosts_json, reason, status, created_at)
      VALUES ('hosts', 1, 'S001', 'alice', '["gpu02"]', 'more', 'pending', 't');`)
  raises(() => raw.exec("UPDATE accounts SET desired='absent'"), 'CHECK')
  raw.close()

  initDb()
  const con = db()
  expect(readdirSync(path.join(TMP, 'old-requests', 'backup'))).toHaveLength(1)
  const rs = con.all('SELECT * FROM requests ORDER BY id')
  expect(rs.map((r) => [r.kind, r.username, r.hosts_json, r.reason, r.expected_end, r.status, r.job_id])).toEqual([
    ['account', 'alice', '["gpu01"]', 'thesis', '2099-01-01', 'approved', 5],
    ['account', 'newbie', '["gpu01","gpu02"]', 'course', '2099-06-30', 'pending', null],
    ['hosts', 'alice', '["gpu02"]', 'more', null, 'pending', null]])
  expect(rs.map((r) => [r.name, r.gpus, r.min_vram_gb, r.updated_at])).toEqual(Array(3).fill([null, null, null, null]))
  expect(con.all('SELECT host, desired, remove_home FROM accounts ORDER BY host'))
    .toEqual([{ host: 'gpu01', desired: 'present', remove_home: 0 }, { host: 'gpu02', desired: 'locked', remove_home: 0 }])
  con.exec("UPDATE accounts SET desired='absent' WHERE host='gpu02'") // widened CHECK
  expect(val(con, 'SELECT COUNT(*) FROM assignments')).toBe(0)
  expect(con.all('PRAGMA foreign_key_check')).toEqual([])
})

test('a transaction takes the write lock up front (two processes read-then-write)', () => {
  const web = fresh()
  const runner = openDb() // the other process
  runner.exec('PRAGMA busy_timeout=0')
  try {
    web.tx(() => {
      const n = Number(web.value('SELECT count(*) FROM hosts'))
      // DEFERRED would let this commit, and the write below would then fail with SQLITE_BUSY_SNAPSHOT
      raises(() => runner.run("INSERT INTO audit(ts, actor, action) VALUES ('t', 'runner', 'x')"), 'locked')
      web.run("INSERT INTO hosts(name, address, group_name) VALUES (?, '192.0.2.99', 'gpu')", `gpu${n + 1}`)
    })
    expect(runner.value('SELECT count(*) FROM hosts')).toBe(HOSTS.length + 1)
    runner.run("INSERT INTO audit(ts, actor, action) VALUES ('t', 'runner', 'x')") // free again after COMMIT
  } finally {
    runner.close()
  }
})

/** A DB in its own data dir made from `schema`; returns the DB path. */
function oldDb(dir: string, schema: string, ...sql: string[]): string {
  config.dbPath = path.join(TMP, dir, 'portal.db')
  mkdirSync(path.dirname(config.dbPath))
  const raw = new DatabaseSync(config.dbPath)
  raw.exec(schema)
  for (const q of sql) raw.exec(q)
  raw.close()
  return config.dbPath
}

const tableSql = (con: DB) => con.all("SELECT name, rootpage, sql FROM sqlite_master WHERE type='table' ORDER BY name")

test('migrate: whitespace and comments alone never rebuild a table', () => {
  const schema = schemaSql()
  const reformatted = schema
    .replace(/ *--.*$/gm, '') // no comments
    .replace(/\(\n\s*/g, '(\n    ').replace(/ {2,}/g, ' ') // other indentation, single spaces
    .replace(/,\n/g, ' ,\n/* moved */')
  expect(reformatted).not.toBe(schema)
  oldDb('reformatted', reformatted, "INSERT INTO hosts(name, address, group_name) VALUES ('gpu01', '192.0.2.11', 'gpu')")
  const before = new DB(config.dbPath)
  const tables = tableSql(before)
  before.close()
  initDb()
  expect(tableSql(db())).toEqual(tables) // same SQL text and pages: nothing rebuilt
  expect(readdirSync(path.join(TMP, 'reformatted'))).not.toContain('backup') // and no backup taken
})

test('migrate refuses to drop a column that schema.sql no longer has', () => {
  const schema = schemaSql().replace('  notes       TEXT,\n', '  notes       TEXT,\n  legacy_rack TEXT,\n')
    .replace('  name          TEXT,\n', '  name          TEXT,\n  phone         TEXT,\n  office        TEXT,\n')
  const file = oldDb('dropcol', schema, "INSERT INTO hosts(name, address, group_name, legacy_rack) VALUES ('gpu01', '192.0.2.11', 'gpu', 'R1')")
  raises(() => initDb(), 'people(phone, office); hosts(legacy_rack)')
  const con = new DB(file) // untouched
  expect(con.value("SELECT legacy_rack FROM hosts WHERE name='gpu01'")).toBe('R1')
  expect(con.value("SELECT count(*) FROM pragma_table_info('people') WHERE name='phone'")).toBe(1)
  con.close()
  expect(readdirSync(path.join(TMP, 'dropcol'))).not.toContain('backup')
})

test('migrate rolls back when foreign keys are violated', () => {
  const schema = schemaSql().replace(", 'bmc_check'", '') // forces a rebuild of jobs
  expect(schema).not.toBe(schemaSql())
  const file = oldDb('fk', schema, 'PRAGMA foreign_keys=OFF',
    "INSERT INTO announcements(title, body, shutdown_job_id, created_by, created_at) VALUES ('t', 'b', 42, 'a', 't')")
  raises(() => initDb(), 'foreign key violations (announcements → jobs)')
  const con = new DB(file)
  expect(con.value("SELECT sql FROM sqlite_master WHERE name='jobs'")).not.toContain('bmc_check') // rolled back
  expect(con.value('SELECT count(*) FROM announcements')).toBe(1)
  con.close()
})

test('labdeck demote-admin: the only way to take admin rights away', () => {
  const dir = path.join(TMP, 'cli')
  mkdirSync(dir)
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '../src/cli.ts'), ...args], {
      env: { ...process.env, DATA_DIR: dir, DISCORD_WEBHOOK_URL: '' }, encoding: 'utf8',
    })
    return [r.status, `${r.stdout}${r.stderr}`] as const
  }
  expect(cli('add-admin', 'S1', 'boss')[0]).toBe(0)
  expect(cli('add-admin', 'S2', 'amy')[0]).toBe(0)
  let [code, out] = cli('demote-admin', 'amy')
  expect([code, out]).toEqual([0, 'amy is no longer an admin\n'])
  const con = new DB(path.join(dir, 'portal.db'))
  expect(con.all('SELECT username, role, status FROM people ORDER BY username').map(Object.values))
    .toEqual([['amy', 'member', 'active'], ['boss', 'admin', 'active']])
  expect(con.value("SELECT actor || ' ' || target FROM audit WHERE action='admin_demote'")).toBe('cli amy')
  ;[code, out] = cli('demote-admin', 'amy') // not an admin (any more)
  expect([code, out]).toEqual([1, 'amy is not an admin\n'])
  ;[code, out] = cli('demote-admin', 'boss') // never leaves the site without an active admin
  expect(code).toBe(1)
  expect(out).toContain('only active admin')
  expect(cli('demote-admin', 'nobody')[0]).toBe(1)
  expect(cli('demote-admin')[0]).toBe(1) // usage
  expect(con.value("SELECT role FROM people WHERE username='boss'")).toBe('admin')
  expect(con.value("SELECT COUNT(*) FROM audit WHERE action='admin_demote'")).toBe(1)
  con.close()
})

test('the removed unassigned_logins table is dropped by init_db', () => {
  const con = fresh()
  con.exec('CREATE TABLE unassigned_logins (sso_id TEXT PRIMARY KEY)')
  initDb()
  expect(row(con, "SELECT 1 FROM sqlite_master WHERE name='unassigned_logins'")).toBeUndefined()
})

// --- Prometheus templates -----------------------------------------------------------------

test('promql templates', () => {
  for (const key of Object.keys(PROMQL)) {
    const q = promql(key, 'gpu01', { r: '60s' }) // every template fills completely
    expect(q, key).not.toContain('$')
    expect(q, key).toContain('job="node",instance="gpu01"')
  }
  expect(promql('host.cpu_pct', 'gpu"01\\x\n')).toContain('instance="gpu\\"01\\\\x\\n"') // escaped anyway
  expect(promql('status.cpu_pct')).not.toContain('instance=')
  const fs = 'fstype!~"tmpfs|devtmpfs|ramfs|overlay|squashfs|nsfs|autofs|nfs.*|cifs|smb3|fuse.*"'
  expect(promql('host.disk_pct', 'gpu01')).toContain(fs)
  expect(promql('host.net_rx_bps', 'gpu01')).toContain('device!~"lo|docker.*|veth.*|br-.*"')
})

test('disk check thresholds', () => {
  expect(diskCheck('/', 50, 1e12, 1.0)[0]).toBe('ok') // filling fast, but plenty left: no forecast below 80 %
  expect(diskCheck('/', 82, 1e11, 5.0)[0]).toBe('warn')
  expect(diskCheck('/', 82, 1e11, 2.0)[0]).toBe('bad')
  expect(diskCheck('/', 86, 1e11, null)[0]).toBe('warn')
  expect(diskCheck('/', 95, 1e9, null)[0]).toBe('bad')
  expect(diskCheck('/', null, null, null)[0]).toBe('unknown')
})

test('notification rate limit', () => {
  const con = fresh()
  const alice = person(con, 'alice')
  con.tx(() => {
    for (let i = 0; i < 12; i++) notifications.queue(con, 'email', 'maintenance', `k${i}`, 's', 'b', alice)
  })
  expect(con.all('SELECT status FROM outbox ORDER BY id').map((r) => r.status)).toEqual([...Array(10).fill('queued'), 'skipped', 'skipped'])
})

describe('python compatibility helpers', () => {
  test('round half to even like Python', () => {
    expect(pyFixed(0.25, 1)).toBe('0.2')
    expect(pyFixed(0.15, 1)).toBe('0.1') // 0.15 is 0.1499… in binary
    expect(pyFixed(2.5, 0)).toBe('2')
    expect(pyFixed(3.5, 0)).toBe('4')
    expect(pyFixed(12.345, 1)).toBe('12.3')
    expect(pyFixed(97.04, 1)).toBe('97.0')
    expect(pyFixed(-0.04, 1)).toBe('0.0')
  })
  test('playbooks and hosts fixture', () => {
    expect(Object.keys(PLAYBOOKS).sort()).toEqual(['agents', 'collect', 'users'])
    expect(HOSTS.length).toBe(3)
  })
})

test('ingest skips files older than `since`', () => {
  const con = fresh()
  const file = path.join(config.collectDir, 'gpu01.json')
  writeFileSync(file, JSON.stringify({ host: 'gpu01', collected_at: 1, facts: {}, accounts: [] }))
  const old = Date.now() / 1000 - 3600
  utimesSync(file, old, old)
  expect(ingest(con, Date.now() / 1000 - 60)).toEqual([])
  expect(ingest(con, 0)).toEqual(['gpu01'])
  expect(addHosts).toBeTypeOf('function')
})

test('jobs in human terms: descriptions and failure summaries', () => {
  const entry = (username: string, state = 'present', extra = {}) => ({ username, uid: 20000, state, expires: null, keys_add: [], keys_remove: [], ...extra })
  expect(describeJob('users', { target_hosts: 'gpu01', accounts: { gpu01: [entry('xiaoming')] }, only_user: 'xiaoming' }, true))
    .toBe('指派 xiaoming @gpu01')
  expect(describeJob('users', { target_hosts: 'gpu01', accounts: { gpu01: [entry('oldgrad', 'absent', { remove_home: true })] } }))
    .toBe('刪除 oldgrad（含家目錄） @gpu01')
  expect(describeJob('users', { target_hosts: 'gpu01,gpu02', accounts: { gpu01: [entry('alice')], gpu02: [entry('alice')] } }, true))
    .toBe('金鑰部署 alice @gpu01、gpu02')
  expect(describeJob('users', { target_hosts: 'gpu01', accounts: { gpu01: ['a', 'b', 'c', 'd'].map((u) => entry(u)) } }))
    .toBe('帳號同步 a、b、c 等 4 人 @gpu01')
  expect(describeJob('collect', { target_hosts: 'all', collect_dir: '/data/collect' })).toBe('收集資料（全部主機）')
  expect(describeJob('agents', { target_hosts: 'a,b,c,d' })).toBe('安裝監控 @a、b、c 等 4 台')
  expect(describeJob('power', { target_hosts: 'gpu01' })).toBe('電源控制（已停用）')

  const unreachable = 'fatal: [gpu02]: UNREACHABLE! => {"msg": "Failed to connect to the host via ssh: ssh: connect to host 192.0.2.12 port 22: Connection timed out", "unreachable": true}'
  expect(failureHint(`ok: [gpu01]\n${unreachable}\n`)).toEqual({ kind: 'unreachable', hosts: ['gpu02'], text: '主機尚未 bootstrap 或無法連線' })
  expect(failureHint('fatal: [gpu01]: UNREACHABLE! => {"msg": "labbot@192.0.2.11: Permission denied (publickey).", "unreachable": true}')!.kind).toBe('publickey')
  expect(failureHint('fatal: [gpu01]: FAILED! => {"msg": "Missing sudo password"}')).toMatchObject({ kind: 'sudo', hosts: ['gpu01'] })
  expect(failureHint('fatal: [gpu01]: FAILED! => {"msg": "Incorrect sudo password"}')!.kind).toBe('sudo')
  expect(failureHint('[runner] 所有主機的監控都無回應（VPN／網路可能中斷）')!.kind).toBe('network')
  expect(failureHint('TASK [x]\nchanged: [gpu01]')).toBeNull()
  expect(failureSummary(unreachable)).toBe('gpu02：主機尚未 bootstrap 或無法連線')
  expect(failureSummary(unreachable, true)).toBe('預檢無法連線到 gpu02，未產生預覽，請修正後重新排程（主機尚未 bootstrap 或無法連線）')
  expect(failureSummary('boom', true)).toBe('預檢失敗，未產生預覽，請修正後重新排程')
  expect(failureSummary(null)).toBe('工作失敗，請看下方輸出')
})
