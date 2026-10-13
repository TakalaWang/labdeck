import { expect, test } from 'vitest'
import { adopt, allocator, config, enqueue, enqueueUsers, grant, isoOf, now, type DB } from '@labdeck/core'
import { csrfOk } from '../src/server/index.ts'
import { ACCOUNT_TABS } from '../src/server/routes-admin.ts'
import {
  NOTIFIED, addDaysIso, fresh, keygen, localIsoOf, observe, offline, person, prometheus, row, today, val, vec,
} from '../../../packages/core/test/helpers.ts'
import { ORIGIN, SESSION, call, err, get, login, ok, post, put, setSession } from './client.ts'

// --- web: auth, CSRF, permissions -------------------------------------------------------

test('csrf', async () => {
  expect(csrfOk('a', 'a', null, 'https://portal.test/admin', 'https://portal.test')).toBe(true)
  expect(csrfOk('a', 'a', 'https://portal.test.evil.com', null, 'https://portal.test')).toBe(false)
  expect(csrfOk('a', 'a', 'http://portal.test', null, 'https://portal.test')).toBe(false)
  expect(csrfOk('a', 'b', 'https://portal.test', null, 'https://portal.test')).toBe(false)
  expect(csrfOk('', '', 'https://portal.test', null, 'https://portal.test')).toBe(false)
  expect(csrfOk('a', 'ä', 'https://portal.test', null, 'https://portal.test')).toBe(false)
  // PUBLIC_URL is compared as an origin: case and the default port don't matter, any other port or userinfo trick does
  expect(csrfOk('a', 'a', 'https://portal.test', null, 'HTTPS://Portal.TEST:443/')).toBe(true)
  expect(csrfOk('a', 'a', 'https://portal.test:443', null, 'https://portal.test')).toBe(true)
  expect(csrfOk('a', 'a', 'http://localhost:8080', null, 'http://LOCALHOST:8080')).toBe(true)
  expect(csrfOk('a', 'a', null, 'https://PORTAL.test/admin?x=1', 'https://portal.test')).toBe(true)
  expect(csrfOk('a', 'a', 'https://portal.test:8443', null, 'https://portal.test')).toBe(false)
  expect(csrfOk('a', 'a', 'https://portal.test@evil.test', null, 'https://portal.test')).toBe(false)
  expect(csrfOk('a', 'a', 'null', 'https://portal.test/', 'https://portal.test')).toBe(false) // an opaque Origin isn't skipped
  expect(csrfOk('a', 'a', 'https://portal.test', null, 'not a url')).toBe(false)
  const con = fresh()
  login(person(con, 'boss', { role: 'admin' }))
  const collect = '/api/admin/hosts/gpu01/collect'
  for (const headers of [{ Origin: ORIGIN }, { Origin: ORIGIN, 'X-CSRF-Token': 'wrong' }, { 'X-CSRF-Token': 'tok' },
    { 'X-CSRF-Token': 'tok', Origin: 'https://evil.test' }, { 'X-CSRF-Token': 'tok', Origin: 'https://portal.test.evil.com' },
    { 'X-CSRF-Token': 'tok', Referer: 'https://evil.test/https://portal.test/' }]) {
    err(await call('POST', collect, undefined, headers), 403, 'CSRF')
  }
  err(await call('PUT', '/api/admin/hosts/gpu01', { address: '192.0.2.99', group: 'gpu' }, { Origin: ORIGIN }), 403, 'CSRF')
  err(await call('DELETE', '/api/admin/hosts/gpu02', { confirm: 'gpu02' }, { Origin: 'https://evil.test', 'X-CSRF-Token': 'tok' }), 403)
  err(await call('POST', '/api/logout', undefined, { Origin: ORIGIN }), 403, 'CSRF')
  expect(row(con, 'SELECT 1 FROM jobs')).toBeUndefined()
  expect(val(con, "SELECT address FROM hosts WHERE name='gpu01'")).toBe('192.0.2.11')
  expect(row(con, "SELECT 1 FROM hosts WHERE name='gpu02'")).toBeTruthy()
  delete SESSION.csrf // no token in the session: even a matching header fails
  err(await call('POST', collect, undefined, { Origin: ORIGIN, 'X-CSRF-Token': 'None' }), 403)
  SESSION.csrf = 'tok' // Referer is the fallback when Origin is missing
  expect(ok(await call('POST', collect, undefined, { 'X-CSRF-Token': 'tok', Referer: `${ORIGIN}/hosts/gpu01` }))).toHaveProperty('job_id')
  expect(ok(await post('/api/logout'))).toEqual({})
  expect(SESSION).not.toHaveProperty('person_id')
})

test('HEAD is not GET: 405, and no one-time state is consumed', async () => {
  const con = fresh()
  const mem = person(con, 'mem')
  con.run("UPDATE people SET temp_password='TempPw123' WHERE id=?", mem)
  setSession({ person_id: mem, csrf: 'tok', oauth_state: 's', discord_state: `${mem}:d` })
  for (const url of ['/api/me', '/api/session', '/auth/callback?code=c&state=s', '/auth/discord/callback?code=c&state=d', '/login']) {
    const r = await call('HEAD', url, undefined, {})
    expect([url, r.status, r.text]).toEqual([url, 405, ''])
  }
  expect((await call('HEAD', '/api/nope', undefined, {})).status).toBe(404)
  expect(SESSION).toEqual({ person_id: mem, csrf: 'tok', oauth_state: 's', discord_state: `${mem}:d` })
  expect(val(con, 'SELECT temp_password FROM people WHERE id=?', mem)).toBe('TempPw123')
  // GET never consumes it either: shown until its owner acknowledges it
  expect(ok(await get('/api/me')).temp_password).toBe('TempPw123')
  expect(ok(await get('/api/me')).temp_password).toBe('TempPw123')
  expect(val(con, 'SELECT temp_password FROM people WHERE id=?', mem)).toBe('TempPw123')
  expect(ok(await post('/api/me/temp-password/ack'))).toEqual({})
  expect(ok(await get('/api/me')).temp_password).toBeNull()
  expect(val(con, 'SELECT temp_password FROM people WHERE id=?', mem)).toBeNull()
})

test('session endpoint', async () => {
  const con = fresh()
  setSession({})
  const r = await get('/api/session')
  const d = ok(r)
  expect(d).toEqual({ site: { name: 'Test Lab', oauth_name: 'ExampleID' }, csrf: SESSION.csrf, user: null, identity: null })
  expect(ok(await get('/api/session')).csrf).toBe(d.csrf)
  expect(r.headers.get('cache-control')).toBe('no-store')
  Object.assign(SESSION, { sso_id: 'N001', email: 'n@example.org' })
  expect(ok(await get('/api/session')).identity).toEqual({ sso_id: 'N001', email: 'n@example.org' })
  expect(ok(await get('/api/session')).user).toBeNull()
  const alice = person(con, 'alice', { sso_id: 'N001', expires_at: '2027-07-31' }) // approved meanwhile → picked up
  expect(ok(await get('/api/session')).user).toEqual({ id: alice, username: 'alice', name: null, email: null, sso_id: 'N001',
    role: 'member', status: 'active', expires_at: '2027-07-31' })
})

test('permission matrix', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const mem = person(con, 'mem')
  const gone = person(con, 'gone', { status: 'locked' })
  const who: Record<string, Record<string, unknown>> = {
    anonymous: {}, identity: { sso_id: 'N001' }, locked: { person_id: gone }, member: { person_id: mem }, admin: { person_id: boss },
  }
  const cases: [string, string, unknown, number[]][] = [
    ['GET', '/api/announcements', undefined, [200, 200, 200, 200, 200]], // public
    ['GET', '/api/session', undefined, [200, 200, 200, 200, 200]],
    ['GET', '/api/register', undefined, [401, 200, 200, 200, 200]], // identity
    ['POST', '/api/logout', undefined, [401, 200, 200, 200, 200]],
    ['GET', '/api/hosts', undefined, [401, 403, 403, 200, 200]], // member
    ['GET', '/api/hosts/gpu01', undefined, [401, 403, 403, 200, 200]],
    ['GET', '/api/metrics/gpu-monthly?month=bad', undefined, [401, 403, 403, 400, 400]],
    ['GET', '/api/metrics/fleet?range=bad', undefined, [401, 403, 403, 400, 400]],
    ['GET', '/api/metrics/disk/trend?days=1', undefined, [401, 403, 403, 400, 400]],
    ['POST', '/api/me/keys', { pubkey: 'x' }, [401, 403, 403, 400, 400]],
    ['GET', '/api/guide', undefined, [401, 200, 200, 200, 200]],
    ['GET', '/api/calendar', undefined, [401, 403, 403, 200, 200]],
    ['GET', '/api/admin/guide', undefined, [401, 403, 403, 403, 200]],
    ['GET', '/api/admin/jobs', undefined, [401, 403, 403, 403, 200]], // admin
    ['POST', '/api/admin/sync', undefined, [401, 403, 403, 403, 200]],
    ['GET', '/api/admin/assign-hosts', undefined, [401, 403, 403, 403, 200]],
    ['POST', '/api/admin/requests/999/assign', { hosts: [] }, [401, 403, 403, 403, 404]],
    ['POST', '/api/admin/hosts/gpu01/accounts/x/delete', { remove_home: false }, [401, 403, 403, 403, 400]],
    ['PUT', '/api/admin/hosts/gpu01', { address: '192.0.2.11', group: 'gpu' }, [401, 403, 403, 403, 200]],
    ['DELETE', '/api/admin/hosts/gpu01', { confirm: 'nope' }, [401, 403, 403, 403, 400]],
  ]
  for (const [method, url, body, want] of cases) {
    for (const [i, s] of Object.values(who).entries()) {
      setSession({ ...s, csrf: 'tok' })
      const r = await call(method, url, body)
      expect(r.status, `${method} ${url} ${Object.keys(who)[i]} ${r.text}`).toBe(want[i])
      expect(r.headers.get('content-type')).toBe('application/json')
      if (want[i] !== 200) expect(r.json()).toHaveProperty('error')
    }
  }
  setSession({ person_id: boss, sso_id: 'OTHER', csrf: 'tok' }) // admin re-linked this person to another SSO ID
  err(await get('/api/admin/jobs'), 403)
  err(await get('/api/nope'), 404, '找不到')
})

test('an expired person is not a member', async () => {
  const con = fresh()
  const yesterday = addDaysIso(-1)
  const gone = person(con, 'gone', { expires_at: yesterday })
  const boss = person(con, 'boss', { role: 'admin', expires_at: yesterday })
  const last = person(con, 'last', { expires_at: today() })
  for (const pid of [gone, boss]) {
    login(pid)
    err(await get('/api/hosts'), 403, '已到期')
    err(await get('/api/me'), 403)
    err(await post('/api/me/keys', { pubkey: keygen('ed', '-t', 'ed25519') }), 403)
  }
  err(await get('/api/admin/jobs'), 403)
  expect(ok(await get('/api/session')).user.username).toBe('boss') // still knows who they are
  login(last) // usable through its expiry day
  expect(ok(await get('/api/hosts'))).toBeTruthy()
  expect(ok(await get('/api/me')).person.expires_at).toBe(today())
})

test('huge numbers and integrity races are client errors', async () => {
  const con = fresh()
  login(person(con, 'boss', { role: 'admin', uid: 20000 }))
  for (const url of ['/api/admin/audit?page=100000000000000000', '/api/admin/jobs/100000000000000000000',
    '/api/admin/people/100000000000000000000', '/api/admin/jobs?limit=100000000000000000000']) {
    const r = await get(url)
    expect([200, 400], url).toContain(r.status)
    expect(r.headers.get('content-type')).toBe('application/json')
  }
  err(await get('/api/admin/audit?page=100000000000000000'), 400, '數值超出範圍')
  err(await get('/api/admin/jobs/100000000000000000000'), 400, '數值超出範圍')
  const rid = con.tx(() => con.run(`INSERT INTO requests(sso_id, email, username, hosts_json, reason, expected_end, created_at)
                                    VALUES ('N009', 'r@example.org', 'racer', '["gpu01"]', 'r', '2099-01-01', ?)`, now()).lastInsertRowid)
  const real = allocator.allocUid
  allocator.allocUid = () => 20000 // another approval took this uid a moment ago
  try {
    err(await post(`/api/admin/requests/${rid}/assign`, { username: 'racer', hosts: ['gpu01'] }), 409, '重新整理')
  } finally {
    allocator.allocUid = real
  }
  expect(val(con, 'SELECT status FROM requests WHERE id=?', rid)).toBe('pending') // rolled back
  expect(row(con, "SELECT 1 FROM people WHERE username='racer'")).toBeUndefined()
})

test('login redirects to the OAuth provider', async () => {
  setSession({})
  const r = await get('/login')
  const loc = r.headers.get('location')!
  expect(r.status).toBe(302)
  expect(loc.startsWith('https://sso.example.org/authorize?')).toBe(true)
  expect(loc).toContain('redirect_uri=https%3A%2F%2Fportal.test%2Fauth%2Fcallback')
  expect(loc).toContain('client_id=test-client')
  expect(SESSION.next).toBe('/')
  for (const bad of ['//evil.example', 'https://evil.example/x', '/\\evil.example', '\\\\evil.example', '/\t/evil.example', 'evil']) {
    expect((await get(`/login?${new URLSearchParams({ next: bad })}`)).status).toBe(302)
    expect(SESSION.next, bad).toBe('/')
  }
  await get(`/login?${new URLSearchParams({ next: '/hosts/gpu01?tab=gpu' })}`)
  expect(SESSION.next).toBe('/hosts/gpu01?tab=gpu')
  err(await get('/api/hosts'), 401, '登入')
  err(await get('/api/admin/hosts/gpu01/agents'), 405)
})

test('the OAuth callback uses the configured fields', async () => {
  const con = fresh()
  const alice = person(con, 'alice', { sso_id: 'a001' })
  const calls: string[] = []
  let profile: unknown = { sub: 'a001', mail: 'alice@example.org', username: 'not-this-one' }
  const { io } = await import('@labdeck/core')
  io.fetch = async (input: string, init?: RequestInit) => {
    if (input === config.oauthTokenUrl) {
      calls.push('token')
      expect(String(init?.body)).toContain('client_secret=test-client-secret') // client_secret_post
      return Response.json({ access_token: 't', token_type: 'Bearer' })
    }
    calls.push(input)
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer t')
    return Response.json(profile)
  }
  try {
    setSession({ next: '/hosts/gpu01', oauth_state: 's' })
    const r = await get('/auth/callback?code=c&state=s')
    expect([r.status, r.headers.get('location')]).toEqual([302, '/hosts/gpu01'])
    expect(calls).toEqual(['token', 'https://sso.example.org/profile'])
    expect(SESSION).not.toHaveProperty('next')
    expect([SESSION.sso_id, SESSION.email, SESSION.person_id]).toEqual(['a001', 'alice@example.org', alice])
    expect(val(con, 'SELECT email FROM people WHERE id=?', alice)).toBe('alice@example.org')
    // the CSRF token exists from login on, so every /api/session after it returns the same one
    const token = SESSION.csrf
    expect(token).toBeTruthy()
    expect(ok(await get('/api/session')).csrf).toBe(token)
    expect(ok(await get('/api/session')).csrf).toBe(token)
    Object.assign(SESSION, { next: '//evil.example', oauth_state: 's' }) // re-checked at the callback too
    expect((await get('/auth/callback?code=c&state=s')).headers.get('location')).toBe('/')
    setSession({ oauth_state: 's' })
    profile = { username: 'a001' } // ID field missing → refused, back to the SPA with a code (never raw JSON)
    const r2 = await get('/auth/callback?code=c&state=s')
    expect([r2.status, r2.headers.get('location')]).toEqual([302, '/?login_error=identity'])
    expect(SESSION).not.toHaveProperty('sso_id')
    profile = { sub: 'x y', mail: 'm' }
    setSession({ oauth_state: 's' })
    expect((await get('/auth/callback?code=c&state=s')).headers.get('location')).toBe('/?login_error=identity')
    setSession({ oauth_state: 's' })
    const r3 = await get('/auth/callback?error=access_denied&state=s') // denied at the provider
    expect([r3.status, r3.headers.get('location')]).toEqual([302, '/?login_error=oauth'])
    expect(SESSION).not.toHaveProperty('sso_id')
    setSession({ oauth_state: 's' }) // a forged state never reaches the token endpoint
    calls.length = 0
    expect((await get('/auth/callback?code=c&state=forged')).headers.get('location')).toBe('/?login_error=oauth')
    expect(calls).toEqual([])
  } finally {
    offline()
  }
})

// --- web: every endpoint and the main flows ---------------------------------------------

function seed(con: DB): [number, number] {
  const boss = person(con, 'boss', { role: 'admin', sso_id: 'A001' })
  const mem = person(con, 'mem', { sso_id: 'M001', expires_at: '2027-07-31' })
  const facts = {
    os: 'Ubuntu 22.04.4 LTS', kernel: '5.15.0-105-generic', cpu_model: 'AMD EPYC 7302', cpu_count: 64, mem_mb: 257587,
    nvidia_driver: '535.183.01', cuda: '12.2', gpu_pci_count: 8,
    gpus: Array.from({ length: 7 }, (_, i) => ({ index: i, name: 'NVIDIA GeForce RTX 3090', uuid: `GPU-${i}`, memory_mb: 24576 })),
    disks: [{ name: 'sda', size_bytes: 4000787030016, model: 'ST4000', serial: 'Z1', rota: true }],
    mounts: [{ mountpoint: '/data0', size_bytes: 4e12, used_bytes: 1e12 }],
  }
  con.tx(() => con.run("UPDATE hosts SET room='R101', notes='=cmd', monitored=1, facts_json=?, facts_at=1790000000 WHERE name='gpu01'",
    JSON.stringify(facts)))
  observe(con, 'gpu01', 'mem', 1001)
  observe(con, 'gpu02', 'mem', 1002)
  observe(con, 'gpu01', 'stray', 1003)
  observe(con, 'gpu02', 'stray2', 1002)
  con.tx(() => {
    adopt(con, 'boss', 'gpu01', 'mem', mem)
    con.run("UPDATE people SET temp_password='TempPw123' WHERE id=?", mem)
    con.run("INSERT INTO logins VALUES ('gpu01', 'mem', '203.0.113.7', 1790000000)")
    con.run("INSERT INTO ssh_keys(person_id, pubkey, fingerprint, added_at) VALUES (?, ?, 'SHA256:x', ?)", mem, keygen('ed', '-t', 'ed25519'), now())
    con.run(`INSERT INTO requests(sso_id, email, username, hosts_json, reason, expected_end, created_at)
             VALUES ('N001', 'n@example.org', 'newbie', '["gpu03"]', '<script>alert(1)</script>', '2027-01-31', ?)`, now())
    const j = enqueue(con, 'boss', 'agents', { target_hosts: 'gpu01' })
    con.run("UPDATE jobs SET status='awaiting', check_output='[rc=0]\ndiff' WHERE id=?", j)
  })
  return [boss, mem]
}

const HOST_KEYS = ['name', 'address', 'group', 'monitored', 'room', 'rack', 'psu', 'notes', 'facts_at',
  'os', 'kernel', 'cpu_model', 'cpu_count', 'mem_gb', 'nvidia_driver', 'cuda', 'gpu_summary', 'gpu_count', 'gpu_pci_count', 'disk_count',
  'status', 'ssh_no_retry', 'primary_users']
const USER_KEYS = ['id', 'username', 'name', 'email', 'sso_id', 'role', 'status', 'expires_at']
const MY_ACCOUNT_KEYS = ['host', 'username', 'uid', 'exists', 'locked', 'expires', 'last_active', 'desired', 'primary', 'address',
  'job_status']
const KEY_KEYS = ['id', 'fingerprint', 'type', 'comment', 'state', 'added_at']
const JOB_KEYS = ['id', 'kind', 'target_hosts', 'status', 'actor', 'created_at', 'run_at', 'finished_at', 'auto_confirm', 'summary',
  'scoped']
export const REQUEST_KEYS = ['id', 'kind', 'person_id', 'sso_id', 'email', 'name', 'username', 'purpose', 'gpus', 'min_vram_gb', 'until',
  'hosts', 'status', 'created_at', 'updated_at', 'decided_by', 'decided_at', 'job_id', 'jobs', 'reject_reason']
const ANN_KEYS = ['id', 'title', 'body', 'starts_at', 'ends_at', 'created_by', 'hosts']
const keys = (o: object) => Object.keys(o).sort()
const sorted = (xs: string[]) => [...xs].sort()

test('every endpoint and the main flows', async () => {
  const con = fresh()
  const [boss, mem] = seed(con)
  login(boss)
  for (const url of ['/api/session', '/api/summary', '/api/announcements', '/api/register', '/api/me', '/api/hosts',
    '/api/hosts/gpu01', '/api/hosts/gpu03', '/api/admin/announcements', '/api/admin/people', `/api/admin/people/${mem}`,
    '/api/admin/requests', '/api/admin/jobs', '/api/admin/jobs/1', '/api/admin/audit', '/api/admin/audit?page=2',
    '/api/admin/accounts?tab=idle&days=30&q=mem', ...Object.keys(ACCOUNT_TABS).map((t) => `/api/admin/accounts?tab=${t}`)]) {
    const r = await get(url)
    expect(r.status, `${url} ${r.text.slice(0, 300)}`).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/json')
  }

  // hosts (Prometheus is offline here → status null, never an error)
  const hosts = ok(await get('/api/hosts'))
  const h = hosts[0]
  expect(hosts.map((x: any) => x.name)).toEqual(['gpu01', 'gpu02', 'gpu03'])
  expect(keys(h)).toEqual(sorted(HOST_KEYS))
  expect([h.gpu_summary, h.gpu_count, h.gpu_pci_count, h.mem_gb, h.disk_count]).toEqual(['7× RTX 3090', 7, 8, 251.5, 1])
  expect([h.facts_at, h.monitored, h.status]).toEqual(['2026-09-21T22:13:20+08:00', true, null])
  expect([hosts[2].os, hosts[2].facts_at]).toEqual([null, null])
  expect([hosts[2].gpu_count, hosts[2].disk_count, hosts[2].gpu_summary]).toEqual([null, null, null]) // never collected
  const csvText = (await get('/api/hosts.csv')).text
  expect(csvText.startsWith('\ufeff主機,群組,位址,監控,機房')).toBe(true)
  expect(csvText).toContain("'=cmd")
  expect(csvText).toContain('gpu01,gpu,192.0.2.11,1,R101')
  expect(csvText).toContain('gpu03,legacy,192.0.2.13,0,')
  expect(csvText).not.toContain('198.51.100') // the BMC addresses still in the DB are never read
  let d = ok(await get('/api/hosts/gpu03'))
  expect(keys(d)).toEqual(sorted([...HOST_KEYS, 'facts', 'accounts', 'bootstrap_command']))
  expect(d.facts).toEqual({})
  expect(d.bootstrap_command).toContain('bootstrap_bot.yaml -l gpu03 -u <既有管理帳號>')
  d = ok(await get('/api/hosts/gpu01'))
  expect(d.facts.cpu_count).toBe(64)
  expect(d.accounts.map((a: any) => a.username)).toEqual(['mem', 'stray'])
  expect(d.accounts[0]).toEqual({ username: 'mem', uid: 1001, exists: true, locked: false, expires: null,
    last_active: '2026-09-21T22:13:20+08:00', managed: true, desired: 'present', primary: false, reserved: false,
    person: { id: mem, username: 'mem', name: null, discord_name: null } })
  expect(d.accounts[1].person).toBeNull()
  expect(d.accounts[1].managed).toBe(false)
  err(await get('/api/admin/accounts?tab=bogus'), 400)
  err(await get('/api/hosts/NOPE'), 404, '找不到主機')

  // accounts
  const uid = ok(await get('/api/admin/accounts?tab=uid'))
  expect(new Set(uid.conflicts.map((c: any) => `${c.kind}:${c.key}`))).toEqual(new Set(['same_name:mem', 'same_uid:1002']))
  const sameUid = uid.conflicts.find((c: any) => c.kind === 'same_uid')
  expect(sameUid.entries.map((e: any) => e.username).sort()).toEqual(['mem', 'stray2'])
  expect(ok(await get('/api/admin/accounts?tab=all')).conflicts).toEqual([])
  con.tx(() => con.run("UPDATE accounts SET uid=1009 WHERE host='gpu01' AND username='mem'"))
  const drift = ok(await get('/api/admin/accounts?tab=drift')).rows
  expect(drift.map((r: any) => [r.host, r.username, r.drift, r.expected_uid])).toEqual([['gpu01', 'mem', ['uid 與認領時不同'], 1001]])
  con.tx(() => con.run("UPDATE accounts SET uid=1001 WHERE host='gpu01' AND username='mem'"))
  expect(ok(await get('/api/admin/accounts?tab=drift')).rows).toEqual([])
  expect(ok(await get('/api/admin/accounts?tab=unmanaged')).rows.map((r: any) => r.username)).toEqual(['mem', 'stray', 'stray2'])
  const stray = ok(await post('/api/admin/accounts/adopt', { host: 'gpu01', username: 'stray' })).person_id
  expect(Object.values(row(con, "SELECT managed, person_id FROM accounts WHERE username='stray'")!)).toEqual([1, stray])
  err(await post('/api/admin/accounts/adopt', { host: 'gpu01', username: 'stray' }), 409, '已受管理')
  observe(con, 'gpu03', 'mem', 1001)
  err(await post('/api/admin/accounts/adopt', { host: 'gpu03', username: 'mem' }), 409, '同名') // never auto-link by name
  expect(ok(await post('/api/admin/accounts/adopt', { host: 'gpu03', username: 'mem', person_id: mem }))).toEqual({ person_id: mem })

  // people: grants never enqueue on their own; sync does
  const jobsBefore = val(con, 'SELECT COUNT(*) FROM jobs')
  const g = ok(await put(`/api/admin/people/${mem}/grants`, { hosts: ['gpu01', 'gpu02', 'gpu03'] }))
  expect(g.errors.map((e: any) => e.host)).toEqual(['gpu02'])
  expect(g.errors[0].error).toBe('尚未開通：新主機請用「指派主機」') // 停用／恢復 only: hosts are added by an assignment
  err(await post(`/api/admin/people/${mem}/assign`, { hosts: ['gpu02'] }), 409, '請先認領')
  expect(val(con, 'SELECT COUNT(*) FROM jobs')).toBe(jobsBefore)
  const detail = ok(await get(`/api/admin/people/${mem}`))
  expect(keys(detail)).toEqual(['accounts', 'hosts', 'keys', 'person'])
  expect(keys(detail.person)).toEqual(sorted([...USER_KEYS, 'uid', 'created_at', 'hosts_count', 'removed_at']))
  expect(detail.person.hosts_count).toBe(2)
  expect(detail.hosts).toEqual([{ name: 'gpu01', group: 'gpu', granted: true, exists: true },
    { name: 'gpu02', group: 'gpu', granted: false, exists: true }, { name: 'gpu03', group: 'legacy', granted: true, exists: true }])
  expect(keys(detail.accounts[0])).toEqual(sorted(MY_ACCOUNT_KEYS))
  expect(keys(detail.keys[0])).toEqual(sorted(KEY_KEYS))
  const sync = ok(await post(`/api/admin/people/${mem}/sync`))
  expect(Number.isInteger(sync.job_id)).toBe(true)
  expect(val(con, 'SELECT kind FROM jobs WHERE id=?', sync.job_id)).toBe('users')
  err(await post('/api/admin/people/999/sync'), 404)
  expect(Number.isInteger(ok(await post('/api/admin/sync')).job_id)).toBe(true)

  // jobs (remote power control is gone: its endpoints are 404 like any unknown path)
  for (const [method, url] of [['GET', '/api/admin/power'], ['POST', '/api/admin/power'], ['POST', '/api/admin/bmc-check'],
    ['POST', '/api/admin/hosts/gpu01/bmc-check'], ['POST', '/api/admin/announcements/1/cancel-shutdown']]) {
    err(await call(method, url, method === 'GET' ? undefined : { hosts: ['gpu01'], power_state: 'off', confirm: 'gpu01' }), 404)
  }
  expect(Number.isInteger(ok(await post('/api/admin/hosts/gpu02/collect')).job_id)).toBe(true)
  const jobs = ok(await get('/api/admin/jobs?limit=2'))
  expect(jobs.length).toBe(2)
  expect(keys(jobs[0])).toEqual(sorted(JOB_KEYS))
  expect(jobs[0].target_hosts).toEqual(['gpu02'])
  expect(jobs[0].created_at.endsWith('+08:00')).toBe(true)
  expect(jobs[0].finished_at).toBeNull()
  const j = ok(await post('/api/admin/jobs/1/confirm'))
  expect(keys(j)).toEqual(sorted([...JOB_KEYS, 'args', 'check_output', 'output', 'failure']))
  expect(j.status).toBe('confirmed')
  expect(j.args).toEqual({ target_hosts: 'gpu01' })
  expect(j.check_output.startsWith('[rc=0]')).toBe(true)
  err(await post('/api/admin/jobs/1/confirm'), 409, '狀態已改變')
  expect(ok(await post('/api/admin/jobs/1/cancel')).status).toBe('cancelled')
  err(await post('/api/admin/jobs/1/cancel'), 409)
  err(await post('/api/admin/jobs/1/explode'), 404)
  err(await get('/api/admin/jobs/999'), 404)

  // announcements (times accepted with or without an offset); scheduled shutdowns are refused
  const plan = { title: '停機', body: '維護', ends_at: '2099-01-01T00:00:00Z', hosts: ['gpu02'] }
  const soon = localIsoOf(new Date(Date.now() + 2 * 86_400_000)).slice(0, 16)
  err(await post('/api/admin/announcements', { ...plan, shutdown: { hosts: ['gpu02'], at: soon } }), 400, '已不支援排程關機')
  const ann = ok(await post('/api/admin/announcements', { ...plan, ack_manual_poweron: true })) // a removed field is ignored
  expect(keys(ann)).toEqual(sorted(ANN_KEYS))
  expect(ann.ends_at).toBe('2099-01-01T08:00:00+08:00')
  expect(val(con, 'SELECT shutdown_job_id FROM announcements WHERE id=?', ann.id)).toBeNull()
  expect(val(con, "SELECT COUNT(*) FROM jobs WHERE kind='shutdown'")).toBe(0)
  expect(NOTIFIED.some((m) => m.includes('停機'))).toBe(true)
  expect(ok(await get('/api/announcements'))[0].title).toBe('停機')
  expect(val(con, "SELECT detail_json FROM audit WHERE action='announce'")).toBe('{"hosts": ["gpu02"], "title": "停機"}')
  err(await post('/api/admin/announcements', { title: 'x', body: 'y', starts_at: '2026-09-27 10:00' }), 400, '時間格式')
  err(await post('/api/admin/announcements', { title: ' ', body: 'y' }), 400)
  const past = ok(await post('/api/admin/announcements', { title: '舊', body: 'x', starts_at: '2020-01-01T00:00', ends_at: '2020-01-02T00:00' }))
  expect(ok(await get('/api/announcements')).map((x: any) => x.id)).not.toContain(past.id)
  expect(ok(await get('/api/admin/announcements')).map((x: any) => x.id)).toContain(past.id)

  // hosts and people edits
  const h2 = ok(await put('/api/admin/hosts/gpu02', { address: '192.0.2.12', group: 'gpu', room: 'R102', rack: 'R1', psu: 'A', notes: 'hi' }))
  expect([h2.rack, h2.monitored]).toEqual(['R1', false])
  const p = ok(await put(`/api/admin/people/${mem}`, { role: 'member', status: 'locked', expires_at: '2027-01-01', sso_id: 'M001' }))
  expect([p.status, p.expires_at, p.hosts_count]).toEqual(['locked', '2027-01-01', 0])
  expect(new Set(con.all('SELECT desired FROM accounts WHERE person_id=?', mem).map((r) => r.desired))).toEqual(new Set(['locked']))
  err(await put(`/api/admin/people/${boss}`, { role: 'member', status: 'active' }), 403, 'labdeck demote-admin')
  err(await put(`/api/admin/people/${boss}`, { role: 'admin', status: 'locked' }), 400, '自己')
  err(await put(`/api/admin/people/${boss}`, { status: 'locked' }), 400, '自己')
  expect(Object.values(row(con, 'SELECT role, status FROM people WHERE id=?', boss)!)).toEqual(['admin', 'active'])
  err(await put(`/api/admin/people/${stray}`, { role: 'member', status: 'active', sso_id: 'M001' }), 409, 'ExampleID ID')
  err(await put(`/api/admin/people/${stray}`, { role: 'root', status: 'active' }), 403)
  err(await put(`/api/admin/people/${stray}`, { status: 'gone' }), 400, '狀態')
  err(await put('/api/admin/people/999', { role: 'member', status: 'active' }), 404)
  const audit = ok(await get('/api/admin/audit'))
  expect([audit.page, audit.has_more]).toEqual([1, false])
  expect(audit.rows[0].ts.endsWith('+08:00')).toBe(true)
  expect(audit.rows[0].action).toBe('person_update')
  expect(typeof audit.rows[0].detail).toBe('object')

  // registration (登記) → the admin creates the account and assigns hosts (待指派)
  setSession({ sso_id: 'N002', email: 'n2@example.org', csrf: 'tok' })
  expect(ok(await get('/api/register'))).toEqual({ registration: null, can_register: true })
  const good = { name: '王小明', username: 'newer', purpose: 'research', gpus: 2, min_vram_gb: 24, until: '2099-01-01' }
  const reg = ok(await post('/api/register', good))
  expect(keys(reg)).toEqual(sorted(REQUEST_KEYS))
  expect([reg.kind, reg.name, reg.username, reg.purpose, reg.gpus, reg.min_vram_gb, reg.until, reg.hosts, reg.status, reg.jobs])
    .toEqual(['account', '王小明', 'newer', 'research', 2, 24, '2099-01-01', [], 'pending', []])
  expect(NOTIFIED[NOTIFIED.length - 1]).toContain('[帳號登記] 王小明（N002，n2@example.org）希望帳號 newer，GPU 2 張（每張 ≥ 24 GB），到 2099-01-01')
  login(boss)
  const reqs = ok(await get('/api/admin/requests'))
  expect(reqs.map((r: any) => [r.status, r.username])).toEqual([['pending', 'newer'], ['pending', 'newbie']])
  expect([reqs[1].purpose, reqs[1].until, reqs[1].hosts, reqs[1].gpus, reqs[1].name]) // a request from before registrations
    .toEqual(['<script>alert(1)</script>', '2027-01-31', ['gpu03'], null, null])
  const assigned = ok(await post(`/api/admin/requests/${reg.id}/assign`, { username: 'newer', hosts: ['gpu03', 'gpu01'] }))
  const np = row(con, "SELECT * FROM people WHERE username='newer'")!
  expect(assigned.person_id).toBe(np.id)
  expect(assigned.jobs.map((j: any) => j.host)).toEqual(['gpu01', 'gpu03'])
  // the registration's 預計使用到 (2099-01-01) is information for the admin only: no expiry is set
  expect([np.sso_id, np.uid, np.expires_at, np.status, np.name, np.email]).toEqual(['N002', 20000, null, 'active', '王小明', 'n2@example.org'])
  expect(val(con, 'SELECT COUNT(*) FROM accounts WHERE person_id=? AND managed=1 AND expected_uid=20000', np.id)).toBe(2)
  err(await post(`/api/admin/requests/${reg.id}/assign`, { username: 'newer', hosts: ['gpu02'] }), 409, '已處理')
  err(await post('/api/admin/requests/999/reject'), 404)
  const rejected = ok(await post(`/api/admin/requests/${reqs[1].id}/reject`))
  expect([rejected.status, rejected.decided_by]).toEqual(['rejected', 'boss'])
  expect(rejected.decided_at.endsWith('+08:00')).toBe(true)
  const done = ok(await get('/api/admin/requests')).find((r: any) => r.id === reg.id)
  expect([done.status, done.person_id, done.hosts, done.jobs.map((j: any) => [j.host, j.status])])
    .toEqual(['approved', np.id, ['gpu01', 'gpu03'], [['gpu01', 'queued'], ['gpu03', 'queued']]])
  setSession({ sso_id: 'N002', email: 'n2@example.org', csrf: 'tok' })
  expect(ok(await get('/api/session')).user.username).toBe('newer') // the registrant is a member now

  // member self-service: temp password exactly once, keys
  con.tx(() => {
    con.run("UPDATE people SET status='active' WHERE id=?", mem)
    con.run("UPDATE accounts SET desired='present' WHERE person_id=?", mem)
  })
  login(mem)
  const me = ok(await get('/api/me'))
  expect(me.temp_password).toBe('TempPw123')
  expect(me.account_setup).toBeNull()
  ok(await post('/api/me/temp-password/ack'))
  expect(ok(await get('/api/me')).temp_password).toBeNull()
  expect(con.all("SELECT target FROM audit WHERE action='temp_password_ack'").map((r) => r.target)).toEqual([`people/${mem}`])
  expect(keys(me.person)).toEqual(sorted(USER_KEYS))
  expect(keys(me.accounts[0])).toEqual(sorted(MY_ACCOUNT_KEYS))
  expect([me.keys[0].type, me.keys[0].comment]).toEqual(['ED25519', 'ed@test'])
  const added = ok(await post('/api/me/keys', { pubkey: keygen('ed2', '-t', 'ed25519') }))
  expect(keys(added.key)).toEqual(sorted(KEY_KEYS))
  expect(added.key.state).toBe('active')
  expect(Number.isInteger(added.job_id)).toBe(true)
  const job = row(con, 'SELECT * FROM jobs WHERE id=?', added.job_id)!
  expect([job.kind, job.auto_confirm, JSON.parse(job.args_json).target_hosts]).toEqual(['users', 1, 'gpu01,gpu03'])
  err(await post('/api/me/keys', { pubkey: keygen('ed2', '-t', 'ed25519') }), 409, '已登錄')
  err(await post('/api/me/keys', { pubkey: `command="id" ${keygen('ed2', '-t', 'ed25519')}` }), 400, '格式不符')
  err(await post('/api/me/keys', {}), 400)
  expect(Number.isInteger(ok(await post(`/api/me/keys/${added.key.id}/revoke`)).job_id)).toBe(true)
  expect(val(con, 'SELECT state FROM ssh_keys WHERE id=?', added.key.id)).toBe('revoked')
  err(await post(`/api/me/keys/${added.key.id}/revoke`), 404)
  err(await get('/api/admin/people'), 403, '管理員')
  err(await post('/api/register', good), 403) // already a member
})

// --- hosts ------------------------------------------------------------------------------

test('host CSV import is all or nothing', async () => {
  const con = fresh()
  login(person(con, 'boss', { role: 'admin' }))
  const text = 'name,address,group\ngpu04,192.0.2.14,gpu\ngpu05,192.0.2.15 x,gpu\n\ngpu06,192.0.2.16,all\ngpu04,192.0.2.24,gpu\ngpu07\n'
  let r = ok(await post('/api/admin/hosts/import', { csv: text }))
  expect([r.added, r.skipped]).toEqual([[], []])
  expect(r.errors.map((e: any) => e.line)).toEqual([3, 5, 6, 7])
  expect(r.errors[2].error).toContain('重複')
  expect(r.errors[3].error).toContain('需要 3 欄')
  // the old BMC / console columns are gone: refused rather than half-imported
  expect(ok(await post('/api/admin/hosts/import', { csv: 'gpu04,192.0.2.14,gpu,198.51.100.14\n' })).errors[0].error).toContain('需要 3 欄')
  err(await post('/api/admin/hosts/import', { csv: 'gpu08,192.0.2.18,gpu\ngpu,192.0.2.30,gpu\n' }), 400, '群組名稱相同') // rollback
  expect(val(con, 'SELECT COUNT(*) FROM hosts')).toBe(3)
  expect(row(con, "SELECT 1 FROM audit WHERE action='host_add'")).toBeUndefined()
  r = ok(await post('/api/admin/hosts/import', { csv: 'gpu04,192.0.2.14,gpu\r\ngpu01,192.0.2.99,gpu\nnode7,node7.example.org,cpu\npc01,192.0.2.21,desk\n' }))
  expect(r).toEqual({ added: ['gpu04', 'node7', 'pc01'], skipped: [{ name: 'gpu01', reason: '已存在' }], errors: [] })
  expect(val(con, "SELECT address FROM hosts WHERE name='gpu01'")).toBe('192.0.2.11')
  const h = row(con, "SELECT * FROM hosts WHERE name='gpu04'")!
  expect([h.bmc_address, h.console, h.monitored, h.no_shutdown]).toEqual([null, null, 0, 0])
  expect(h.created_at).toBeTruthy()
  expect(val(con, "SELECT COUNT(*) FROM audit WHERE action='host_add'")).toBe(3)
})

test('host add, edit and jobs', async () => {
  const con = fresh()
  login(person(con, 'boss', { role: 'admin' }))
  const form = { name: 'gpu09', address: 'gpu09.example.org', group: 'gpu', room: 'R1' }
  let h = ok(await post('/api/admin/hosts', form))
  expect([h.name, h.room, h.monitored, h.status]).toEqual(['gpu09', 'R1', false, null])
  const r = row(con, "SELECT * FROM hosts WHERE name='gpu09'")!
  expect([r.address, r.room, r.monitored]).toEqual(['gpu09.example.org', 'R1', 0])
  err(await post('/api/admin/hosts', form), 409, '已存在')
  err(await post('/api/admin/hosts', { ...form, name: 'gpu 10' }), 400, '主機名稱')
  err(await post('/api/admin/hosts', { ...form, address: '-oProxyCommand=x' }), 400, '位址')
  err(await post('/api/admin/hosts', { name: 'gpu10' }), 400)
  expect(row(con, "SELECT 1 FROM hosts WHERE name LIKE 'gpu 10' OR name='gpu10'")).toBeUndefined()
  h = ok(await put('/api/admin/hosts/gpu09', { address: '2001:db8::9', group: 'gpu', monitored: true, rack: 'R2' }))
  expect([h.address, h.monitored, h.room, h.rack]).toEqual(['2001:db8::9', true, null, 'R2'])
  expect(h.status).toBeNull() // monitored, but Prometheus is unreachable
  err(await put('/api/admin/hosts/gpu09', { address: '2001:db8::9', group: 'all' }), 400, '群組')
  err(await put('/api/admin/hosts/gpu09', { address: '2001:db8::9', group: 'gpu01' }), 400, '群組名稱相同')
  expect(val(con, "SELECT group_name FROM hosts WHERE name='gpu09'")).toBe('gpu')
  expect(val(con, "SELECT COUNT(*) FROM audit WHERE action='host_edit'")).toBe(1)
  err(await put('/api/admin/hosts/nope', { address: '192.0.2.1', group: 'gpu' }), 404)
  const agents = ok(await post('/api/admin/hosts/gpu09/agents'))
  const collect = ok(await post('/api/admin/hosts/gpu09/collect'))
  expect(con.all('SELECT id, kind, args_json FROM jobs ORDER BY id').map((j) => [j.id, j.kind, JSON.parse(j.args_json)])).toEqual([
    [agents.job_id, 'agents', { target_hosts: 'gpu09' }],
    [collect.job_id, 'collect', { target_hosts: 'gpu09', collect_dir: config.collectDir }]])
  err(await post('/api/admin/hosts/gpu09/bogus'), 404)
  err(await post('/api/admin/hosts/nope/agents'), 404)
  login(person(con, 'mem')) // members see the host, not the admin tools
  const d = ok(await get('/api/hosts/gpu09'))
  expect(d.address).toBe('2001:db8::9')
  expect(d).not.toHaveProperty('bootstrap_command')
  expect([d.accounts, d.facts]).toEqual([[], {}])
  err(await post('/api/admin/hosts/gpu09/agents'), 403)
  err(await post('/api/admin/hosts', { ...form, name: 'x1' }), 403)
})

test('host delete', async () => {
  const con = fresh()
  login(person(con, 'boss', { role: 'admin' }))
  const bob = person(con, 'bob')
  const carol = person(con, 'carol')
  observe(con, 'gpu01', 'carol', 1005)
  const { grant } = await import('@labdeck/core')
  con.tx(() => {
    grant(con, 'boss', bob, 'gpu01', true) // never created
    adopt(con, 'boss', 'gpu01', 'carol', carol)
    con.run("INSERT INTO logins VALUES ('gpu02', 'stray', '203.0.113.7', 1)")
  })
  observe(con, 'gpu02', 'stray', 1003)
  err(await call('DELETE', '/api/admin/hosts/gpu01', { confirm: 'gpu01' }), 409, '未停用的受管帳號：bob、carol')
  con.tx(() => {
    // grants revoked: bob never existed, carol still exists unlocked
    grant(con, 'boss', bob, 'gpu01', false)
    grant(con, 'boss', carol, 'gpu01', false)
  })
  err(await call('DELETE', '/api/admin/hosts/gpu01', { confirm: 'gpu01' }), 409, '未停用的受管帳號：carol；')
  con.tx(() => con.run("UPDATE accounts SET observed_locked=1 WHERE username='carol'")) // the sync locked her there
  expect(ok(await call('DELETE', '/api/admin/hosts/gpu01', { confirm: 'gpu01' }))).toEqual({})
  expect(row(con, "SELECT 1 FROM accounts WHERE host='gpu01'")).toBeUndefined()
  expect(JSON.parse(val(con, "SELECT detail_json FROM audit WHERE action='host_delete'"))).toEqual({ locked_accounts: ['bob', 'carol'] })
  err(await call('DELETE', '/api/admin/hosts/gpu02', { confirm: 'gpu01' }), 400, '確認文字不符')
  err(await call('DELETE', '/api/admin/hosts/gpu02'), 400)
  expect(row(con, "SELECT 1 FROM hosts WHERE name='gpu02'")).toBeTruthy()
  expect(ok(await call('DELETE', '/api/admin/hosts/gpu02', { confirm: 'gpu02' }))).toEqual({})
  expect(row(con, "SELECT 1 FROM hosts WHERE name='gpu02'")).toBeUndefined()
  expect(row(con, "SELECT 1 FROM accounts WHERE host='gpu02'")).toBeUndefined()
  expect(row(con, "SELECT 1 FROM logins WHERE host='gpu02'")).toBeTruthy()
  expect(row(con, "SELECT 1 FROM audit WHERE target='gpu02'")).toBeTruthy()
  const { inventory } = await import('@labdeck/core')
  expect(inventory(con).has('gpu02')).toBe(false)
  err(await call('DELETE', '/api/admin/hosts/gpu02', { confirm: 'gpu02' }), 404)
})

test('ssh_no_retry reaches the inventory', async () => {
  const con = fresh()
  login(person(con, 'boss', { role: 'admin' }))
  const { inventoryHostvars } = await import('@labdeck/core')
  const gpu01 = { address: '192.0.2.11', group: 'gpu' }
  expect(ok(await put('/api/admin/hosts/gpu01', { ...gpu01, ssh_no_retry: true })).ssh_no_retry).toBe(true)
  expect(ok(await post('/api/admin/hosts', { name: 'gpu05', address: '192.0.2.15', group: 'gpu' })).ssh_no_retry).toBe(false)
  const hv = inventoryHostvars(con)
  expect(hv.gpu01).toEqual({ ansible_host: '192.0.2.11', ansible_ssh_retries: 0 })
  expect(hv.gpu02).not.toHaveProperty('ansible_ssh_retries')
  expect(hv.gpu05).not.toHaveProperty('ansible_ssh_retries')
  expect(ok(await put('/api/admin/hosts/gpu01', gpu01)).ssh_no_retry).toBe(false) // the form always sends it
  expect(inventoryHostvars(con).gpu01).not.toHaveProperty('ansible_ssh_retries')
})

test('removed IPMI / shutdown host fields are ignored and never exposed', async () => {
  const con = fresh() // the fixture still has BMC addresses and no_shutdown in the DB (columns kept, no longer read)
  con.tx(() => con.run("UPDATE hosts SET bmc_status='fault', bmc_note='x', console='KVM 10', boot_risk=1 WHERE name='gpu01'"))
  login(person(con, 'boss', { role: 'admin' }))
  const removed = { bmc_address: '198.51.100.99', bmc_status: 'fault', bmc_note: 'n', console: 'KVM 1', boot_risk: true, no_shutdown: true }
  const h = ok(await put('/api/admin/hosts/gpu01', { address: '192.0.2.11', group: 'gpu', ...removed }))
  for (const k of [...Object.keys(removed), 'ipmi']) expect(h).not.toHaveProperty(k)
  expect(Object.values(row(con, "SELECT bmc_address, bmc_status, console, boot_risk FROM hosts WHERE name='gpu01'")!))
    .toEqual(['198.51.100.11', 'fault', 'KVM 10', 1]) // untouched
  const n = ok(await post('/api/admin/hosts', { name: 'gpu05', address: '192.0.2.15', group: 'gpu', ...removed }))
  for (const k of [...Object.keys(removed), 'ipmi']) expect(n).not.toHaveProperty(k)
  expect(Object.values(row(con, "SELECT bmc_address, bmc_status, console, boot_risk, no_shutdown FROM hosts WHERE name='gpu05'")!))
    .toEqual([null, null, null, 0, 0])
  for (const u of ['/api/hosts', '/api/hosts/gpu01', '/api/hosts.csv', '/api/admin/assign-hosts']) {
    const text = (await get(u)).text
    for (const leak of ['198.51.100', 'bmc', 'ipmi', 'KVM 10', 'no_shutdown', 'boot_risk']) expect(text, `${u} ${leak}`).not.toContain(leak)
  }
})

// --- admin promotion: the web can promote, never demote ---------------------------------------

test('promote a member to admin; no demotion on the web', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const alice = person(con, 'alice', { sso_id: 'A002' })
  const locked = person(con, 'locked', { status: 'locked' })
  const expired = person(con, 'gone', { expires_at: '2020-01-01' })
  login(alice) // a member can't promote anyone, herself included
  err(await post(`/api/admin/people/${alice}/promote`), 403, '管理員')
  login(boss)
  NOTIFIED.length = 0
  const p = ok(await post(`/api/admin/people/${alice}/promote`))
  expect([p.id, p.username, p.role]).toEqual([alice, 'alice', 'admin'])
  expect(Object.values(row(con, "SELECT actor, target, detail_json FROM audit WHERE action='person_promote'")!))
    .toEqual(['boss', 'alice', '{"role": "admin"}'])
  expect(NOTIFIED).toEqual(['[管理員] boss 將 alice 設為管理員'])
  expect(ok(await post(`/api/admin/people/${alice}/promote`)).role).toBe('admin') // idempotent: no second audit or post
  expect(val(con, "SELECT COUNT(*) FROM audit WHERE action='person_promote'")).toBe(1)
  expect(NOTIFIED.length).toBe(1)
  for (const pid of [locked, expired]) err(await post(`/api/admin/people/${pid}/promote`), 400, '不能設為管理員')
  err(await post('/api/admin/people/999/promote'), 404)
  expect(con.all("SELECT username FROM people WHERE role='admin' ORDER BY id").map((r) => r.username)).toEqual(['boss', 'alice'])

  // the person update never changes a role: an admin can't be demoted, a member not promoted, through PUT
  err(await put(`/api/admin/people/${alice}`, { role: 'member', status: 'active' }), 403, 'labdeck demote-admin')
  err(await put(`/api/admin/people/${locked}`, { role: 'admin', status: 'active' }), 403, '設為管理員')
  expect(ok(await put(`/api/admin/people/${alice}`, { role: 'admin', status: 'active', name: 'Alice' })).role).toBe('admin') // echoed
  expect(ok(await put(`/api/admin/people/${alice}`, { status: 'active', name: 'Alice' })).role).toBe('admin') // omitted
  login(alice) // the new admin can't demote the one who promoted her either
  err(await put(`/api/admin/people/${boss}`, { role: 'member', status: 'active' }), 403)
  expect(con.all("SELECT username FROM people WHERE role='admin' ORDER BY id").map((r) => r.username)).toEqual(['boss', 'alice'])
  expect(val(con, "SELECT COUNT(*) FROM audit WHERE action='person_update' AND detail_json LIKE '%role%'")).toBe(0)
})

// --- bulk adoption ------------------------------------------------------------------------

function suggestionData(con: DB): number {
  // alice, frank: adoptable; bob, carol/dave, gina, hank: uid conflicts; ops reserved; erin managed; ghost gone.
  for (const [host, name, uid] of [['gpu01', 'alice', 1001], ['gpu02', 'alice', 1001], ['gpu01', 'bob', 1003], ['gpu02', 'bob', 1004],
    ['gpu01', 'carol', 1005], ['gpu02', 'dave', 1005], ['gpu01', 'ops', 1010], ['gpu03', 'erin', 1011], ['gpu01', 'frank', 1012],
    ['gpu01', 'gina', 1013], ['gpu02', 'hank', 1014], ['gpu03', 'ghost', 1015]] as [string, string, number][]) {
    observe(con, host, name, uid)
  }
  const frank = person(con, 'frank', { uid: 1012 })
  person(con, 'gina', { uid: 20005 }) // same name, another uid: not the same person
  person(con, 'hx', { uid: 1014 }) // hank's uid belongs to someone else
  con.tx(() => {
    adopt(con, 'boss', 'gpu03', 'erin')
    con.run("UPDATE accounts SET exists_on_host=0 WHERE username='ghost'")
    con.run("INSERT INTO logins VALUES ('gpu02', 'alice', '203.0.113.7', 1790000000)")
  })
  return frank
}

test('adopt suggestions', async () => {
  const con = fresh()
  const frank = suggestionData(con)
  login(person(con, 'boss', { role: 'admin' }))
  const d = ok(await get('/api/admin/accounts/suggestions'))
  expect(d.groups).toEqual([
    { username: 'alice', uid: 1001, hosts: ['gpu01', 'gpu02'], last_active: isoOf(new Date(1790000000 * 1000)), existing_person: null },
    { username: 'frank', uid: 1012, hosts: ['gpu01'], last_active: null, existing_person: { id: frank, username: 'frank' } }])
  const reasons = Object.fromEntries(d.conflicts.map((c: any) => [c.username, c.reason]))
  expect(Object.keys(reasons).sort()).toEqual(['bob', 'carol', 'dave', 'gina', 'hank']) // never ops (reserved), erin (managed), ghost (gone)
  expect(reasons.bob).toContain('UID 不同')
  expect(reasons.gina).toContain('UID 不同')
  expect(reasons.carol).toBe('UID 1005 也被 dave 使用')
  expect(reasons.hank).toBe('UID 1014 也被 hx 使用')
  expect(d.conflicts.find((c: any) => c.username === 'bob').entries).toEqual([{ host: 'gpu01', uid: 1003 }, { host: 'gpu02', uid: 1004 }])
  login(person(con, 'mem'))
  err(await get('/api/admin/accounts/suggestions'), 403)
})

test('adopt bulk', async () => {
  const con = fresh()
  const frank = suggestionData(con)
  login(person(con, 'boss', { role: 'admin' }))
  const items = [
    { username: 'alice', hosts: ['gpu01', 'gpu03'] }, // gpu03 isn't one of alice's suggested hosts
    { username: 'frank', hosts: ['gpu01'] }, // the same-name person must be named explicitly
    { username: 'bob', hosts: ['gpu01'] }, // the client's grouping is not trusted: bob's uids differ
    { username: 'ops', hosts: ['gpu01'] },
    { username: 'alice', hosts: ['gpu01', 'gpu02'] },
    { username: 'frank', hosts: ['gpu01'], person_id: frank },
    { username: 'alice', hosts: ['gpu01'] }, // already adopted by the item before
  ]
  const d = ok(await post('/api/admin/accounts/adopt-bulk', { items }))
  const alice = val(con, "SELECT id FROM people WHERE username='alice'")
  expect(d.adopted).toEqual([{ username: 'alice', person_id: alice, hosts: ['gpu01', 'gpu02'] },
    { username: 'frank', person_id: frank, hosts: ['gpu01'] }])
  expect(d.errors.map((e: any) => [e.username, Array.from(e.error as string).slice(0, 8).join('')])).toEqual([
    ['alice', '主機不在建議清單'], ['frank', '已有同名人員，請'], ['bob', '已不符合批次認領'], ['ops', '已不符合批次認領'],
    ['alice', '已不符合批次認領']])
  expect(val(con, "SELECT COUNT(*) FROM people WHERE username='alice'")).toBe(1) // one person per username
  expect(val(con, 'SELECT uid FROM people WHERE id=?', alice)).toBe(1001)
  expect(con.all("SELECT host, managed, person_id, expected_uid, desired FROM accounts WHERE username='alice' ORDER BY host").map(Object.values))
    .toEqual([['gpu01', 1, alice, 1001, 'present'], ['gpu02', 1, alice, 1001, 'present']])
  expect(val(con, "SELECT managed FROM accounts WHERE username='bob' AND host='gpu01'")).toBe(0)
  expect(con.all("SELECT target FROM audit WHERE action='adopt' AND actor='boss' ORDER BY id").map((r) => r.target))
    .toEqual(['gpu03/erin', 'gpu01/alice', 'gpu02/alice', 'gpu01/frank'])
  err(await post('/api/admin/accounts/adopt-bulk', { items: [] }), 400)
  err(await post('/api/admin/accounts/adopt-bulk', { items: [{ username: 'alice' }] }), 400)
  login(person(con, 'mem'))
  err(await post('/api/admin/accounts/adopt-bulk', { items }), 403)
})

// --- onboarding: self-binding, primary users ------------------------------------------------

test('registration: validation, one open registration per identity, edits', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const mem = person(con, 'mem', { sso_id: 'M001' })
  const good = { name: ' Lin ', username: 'mem', purpose: 'thesis', gpus: 1, until: addDaysIso(30) } // names need not be unique
  setSession({ sso_id: 'N100', email: 'n100@example.edu', csrf: 'tok' })
  for (const [patch, msg] of [
    [{ name: ' ' }, '姓名'], [{ username: 'Root' }, '帳號名稱'], [{ username: 'root' }, 'root 是保留名稱，請換一個'], [{ username: 'ops' }, 'ops 是保留名稱'], [{ username: 'a b' }, '帳號名稱'],
    [{ username: 'x'.repeat(33) }, '帳號名稱'], [{ purpose: '' }, '用途'], [{ gpus: -1 }, 'GPU'], [{ gpus: 65 }, 'GPU'],
    [{ min_vram_gb: 0 }, '顯存'], [{ until: addDaysIso(-1) }, '不可早於今天'], [{ until: '2099-13-01' }, ''], [{ gpus: 1.5 }, ''],
  ] as [Record<string, unknown>, string][]) {
    err(await post('/api/register', { ...good, ...patch }), 400, msg)
  }
  err(await post('/api/register', { name: 'x' }), 400)
  err(await put('/api/register', good), 404) // nothing pending to edit
  const r = ok(await post('/api/register', good))
  expect([r.name, r.username, r.min_vram_gb, r.email, r.sso_id]).toEqual(['Lin', 'mem', null, 'n100@example.edu', 'N100'])
  expect(ok(await get('/api/register'))).toMatchObject({ can_register: false, registration: { id: r.id, status: 'pending' } })
  err(await post('/api/register', { ...good, username: 'other' }), 409, '已經登記過') // one open registration per identity
  const edited = ok(await put('/api/register', { ...good, username: 'lin', gpus: 4, min_vram_gb: 48 }))
  expect([edited.id, edited.username, edited.gpus, edited.min_vram_gb]).toEqual([r.id, 'lin', 4, 48])
  err(await put('/api/register', { ...good, gpus: 99 }), 400)
  expect(val(con, "SELECT COUNT(*) FROM requests WHERE sso_id='N100'")).toBe(1)
  expect(val(con, "SELECT COUNT(*) FROM audit WHERE action='register_update'")).toBe(1)
  setSession({ sso_id: 'N101', csrf: 'tok' }) // another identity is independent
  ok(await post('/api/register', { ...good, username: 'lin' }))
  login(mem)
  err(await post('/api/register', good), 403, '已有實驗室帳號')
  expect(ok(await get('/api/register')).can_register).toBe(false)
  setSession({ csrf: 'tok' })
  err(await post('/api/register', good), 401)
  login(boss) // rejected → the identity may register again
  ok(await post(`/api/admin/requests/${r.id}/reject`))
  setSession({ sso_id: 'N100', csrf: 'tok' })
  expect(ok(await get('/api/register'))).toMatchObject({ can_register: true, registration: { status: 'rejected' } })
  ok(await post('/api/register', good))
  // bind is gone: identities never claim accounts themselves
  err(await post('/api/me/bind', { username: 'mem' }), 404)
  err(await get('/api/request'), 404)
})

test('assignment: create or link, uniqueness, one scoped job per host', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const alice = person(con, 'alice') // adopted from host accounts: no SSO ID
  const taken = person(con, 'taken', { sso_id: 'T001' })
  const gone = person(con, 'gone', { status: 'locked' })
  observe(con, 'gpu01', 'alice', 1001)
  observe(con, 'gpu02', 'olduser', 1005)
  con.tx(() => adopt(con, 'boss', 'gpu01', 'alice', alice))
  const register = async (sso: string, username: string, until = '2099-01-01') => {
    setSession({ sso_id: sso, email: `${sso.toLowerCase()}@example.edu`, csrf: 'tok' })
    return ok(await post('/api/register', { name: `Name ${sso}`, username, purpose: 'p', gpus: 1, until })).id as number
  }
  const r1 = await register('N001', 'newbie')
  const r2 = await register('N002', 'alice')
  login(boss)
  const assign = (rid: number, body: Record<string, unknown>) => post(`/api/admin/requests/${rid}/assign`, body)
  // create: a valid, unused username and at least one host
  err(await assign(r1, { hosts: ['gpu01'] }), 400, '連結既有帳號')
  err(await assign(r1, { username: 'newbie', person_id: alice, hosts: ['gpu01'] }), 400, '連結既有帳號')
  err(await assign(r1, { username: 'Bad!', hosts: ['gpu01'] }), 400, '帳號名稱')
  err(await assign(r1, { username: 'alice', hosts: ['gpu01'] }), 409, '已被使用') // a person
  err(await assign(r1, { username: 'olduser', hosts: ['gpu01'] }), 409, '已被使用') // an account on a host
  err(await assign(r1, { username: 'newbie', hosts: [] }), 400, '主機')
  err(await assign(r1, { username: 'newbie', hosts: ['gpu99'] }), 400, '主機')
  expect(val(con, "SELECT COUNT(*) FROM people WHERE username='newbie'")).toBe(0) // all or nothing
  const saved = { ...config }
  Object.assign(config, { smtpHost: 'smtp.example.org', smtpFrom: 'lab@example.org' })
  try {
    // an expires_at from an older client is ignored: assignments never set or change the expiry
    const a1 = ok(await assign(r1, { username: 'nb', hosts: ['gpu02', 'gpu01'], expires_at: '2098-12-31' }))
    const p = row(con, 'SELECT * FROM people WHERE id=?', a1.person_id)!
    expect([p.username, p.sso_id, p.email, p.name, p.uid, p.expires_at]).toEqual(['nb', 'N001', 'n001@example.edu', 'Name N001', 20000, null])
    expect(a1.jobs.map((j: any) => j.host)).toEqual(['gpu01', 'gpu02'])
    for (const j of a1.jobs) {
      const job = row(con, 'SELECT * FROM jobs WHERE id=?', j.job_id)!
      expect([job.kind, job.auto_confirm]).toEqual(['users', 1])
      expect(JSON.parse(job.args_json)).toEqual({ target_hosts: j.host, only_user: 'nb', accounts: { [j.host]: [
        { username: 'nb', uid: 20000, state: 'present', expires: null, keys_add: [], keys_remove: [] }] } })
      expect(row(con, 'SELECT person_id, host, request_id, actor FROM assignments WHERE job_id=?', j.job_id))
        .toEqual({ person_id: p.id, host: j.host, request_id: r1, actor: 'boss' })
    }
    expect(val(con, 'SELECT COUNT(*) FROM outbox')).toBe(0) // no email on assignment (SMTP is configured here)

    // link: an existing person without an SSO ID; hosts are optional; the person's expiry stays as it was
    err(await assign(r2, { person_id: taken, hosts: [] }), 409, '已連結')
    err(await assign(r2, { person_id: gone, hosts: [] }), 400, '鎖定')
    err(await assign(r2, { person_id: 999, hosts: [] }), 404)
    err(await assign(r2, { person_id: alice, hosts: ['gpu01'] }), 400, 'gpu01：已經開通')
    con.tx(() => con.run("UPDATE people SET expires_at='2030-06-30' WHERE id=?", alice))
    const a2 = ok(await assign(r2, { person_id: alice, hosts: [], expires_at: null }))
    expect(a2).toEqual({ person_id: alice, jobs: [] })
    expect(Object.values(row(con, 'SELECT sso_id, email, name, expires_at FROM people WHERE id=?', alice)!))
      .toEqual(['N002', 'n002@example.edu', 'Name N002', '2030-06-30'])
    setSession({ sso_id: 'N002', csrf: 'tok' })
    expect(ok(await get('/api/session')).user).toMatchObject({ id: alice, username: 'alice', name: 'Name N002' })
    const r3 = await register('N002X', 'x') // an SSO ID already linked to someone cannot be linked again
    con.tx(() => con.run("UPDATE requests SET sso_id='N002' WHERE id=?", r3))
    login(boss)
    err(await assign(r3, { username: 'xx', hosts: ['gpu01'] }), 409, '已連結到其他人員')

    // a member's host request: needs only, the admin picks the hosts
    login(alice)
    const hr = ok(await post('/api/me/host-requests', { purpose: 'more GPUs', gpus: 4, min_vram_gb: 40, until: '2099-01-01' }))
    expect([hr.kind, hr.person_id, hr.username, hr.hosts, hr.gpus]).toEqual(['hosts', alice, 'alice', [], 4])
    err(await post('/api/me/host-requests', { purpose: 'again', gpus: 1, until: '2099-01-01' }), 409, '等待指派')
    expect(ok(await get('/api/me/host-requests'))).toMatchObject({ can_request: false, requests: [{ id: hr.id }] })
    err(await post('/api/me/host-requests', { purpose: 'x', gpus: 1, until: '2000-01-01' }), 400, '不可早於今天')
    err(await post(`/api/admin/requests/${hr.id}/assign`, { hosts: ['gpu02'] }), 403)
    login(boss)
    err(await assign(hr.id, { hosts: [] }), 400, '主機')
    const a3 = ok(await assign(hr.id, { hosts: ['gpu02'] }))
    expect(a3.jobs.map((j: any) => j.host)).toEqual(['gpu02'])
    expect(val(con, 'SELECT expires_at FROM people WHERE id=?', alice)).toBe('2030-06-30')

    // quick assign (person page / host page); a person who is not a member, or a host already assigned, fails
    const q = ok(await post(`/api/admin/people/${a1.person_id}/assign`, { hosts: ['gpu03'] }))
    expect(q.jobs.map((j: any) => j.host)).toEqual(['gpu03'])
    expect(row(con, 'SELECT request_id, host FROM assignments WHERE job_id=?', q.jobs[0].job_id)).toEqual({ request_id: null, host: 'gpu03' })
    err(await post(`/api/admin/people/${a1.person_id}/assign`, { hosts: ['gpu03'] }), 400, '已經開通')
    err(await post(`/api/admin/people/${gone}/assign`, { hosts: ['gpu03'] }), 400, '停用')
    err(await post(`/api/admin/people/${a1.person_id}/assign`, { hosts: [] }), 400, '主機')
    expect(val(con, 'SELECT COUNT(*) FROM outbox')).toBe(0)
  } finally {
    Object.assign(config, saved)
  }
})

test('assign-hosts: hardware, free cards, users and disks per host', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const alice = person(con, 'alice', { uid: 20000 })
  con.tx(() => {
    con.run('UPDATE hosts SET monitored=1, facts_json=?, facts_at=1 WHERE name=\'gpu01\'', JSON.stringify({
      gpus: [0, 1].map((i) => ({ index: i, name: 'NVIDIA A100-SXM4-80GB', uuid: `GPU-${i}`, memory_mb: 81920 })) }))
    grant(con, 'boss', alice, 'gpu01', true)
    con.run("UPDATE accounts SET primary_user=1 WHERE host='gpu01' AND username='alice'")
  })
  // users = claimed accounts (managed, with a person, open): alice, granted, counts before it even exists there;
  // unassigned leftovers (bob, carl), a locked one (old) and a revoked person's account (dora) don't
  observe(con, 'gpu01', 'bob', 1002)
  observe(con, 'gpu01', 'carl', 1004)
  observe(con, 'gpu01', 'old', 1003, 1)
  const dora = person(con, 'dora')
  observe(con, 'gpu01', 'dora', 1006)
  con.tx(() => {
    adopt(con, 'boss', 'gpu01', 'dora', dora)
    grant(con, 'boss', dora, 'gpu01', false)
  })
  login(boss)
  const g = (i: number) => ({ instance: 'gpu01', gpu: String(i), uuid: `GPU-${i}` })
  const fs = (v: number, mountpoint: string) => vec(v, { instance: 'gpu01', device: `/dev/${mountpoint.length}`, mountpoint })
  prometheus([
    ['lab_nvidia_smi_ok', [vec(1, { __name__: 'up', instance: 'gpu01' }),
      ...[0, 1].flatMap((i) => [vec(1, { __name__: 'lab_gpu_info', name: 'NVIDIA A100-SXM4-80GB', ...g(i) }),
        vec(i ? 90 : 0, { __name__: 'lab_gpu_utilization_percent', ...g(i) }), vec(i ? 4e10 : 1e8, { __name__: 'lab_gpu_memory_used_bytes', ...g(i) })])]],
    ['node_filesystem_size_bytes', [fs(100e9, '/'), fs(4e12, '/srv/data1'), fs(1e12, '/boot2')]],
    ['node_filesystem_free_bytes', [fs(50e9, '/'), fs(2e12, '/srv/data1'), fs(1e12, '/boot2')]],
    ['node_filesystem_avail_bytes', [fs(40e9, '/'), fs(1.9e12, '/srv/data1'), fs(1e12, '/boot2')]],
  ])
  const d = ok(await get(`/api/admin/assign-hosts?person_id=${alice}`))
  expect(d.metrics_ok).toBe(true)
  expect(d.hosts.map((h: any) => h.name)).toEqual(['gpu01', 'gpu02', 'gpu03'])
  expect(d.hosts[0]).toEqual({
    name: 'gpu01', group: 'gpu', monitored: true, up: true, gpu_summary: '2× A100-SXM4-80GB', gpu_count: 2, gpu_vram_gb: 80,
    gpus_free: 1, gpu_util_avg: 45, users: 1, primary_users: [{ username: 'alice', name: null }],
    root_free_bytes: 40e9, data_free_bytes: 1.9e12, granted: true, blocked: null, // DATA_MOUNT_GLOB=/srv/data*
  })
  expect(d.hosts[1]).toMatchObject({ name: 'gpu02', monitored: false, up: null, gpu_count: null, gpus_free: null, root_free_bytes: null, granted: false })
  // an assignment would only fail on a host never collected (not bootstrapped?) or reported down
  expect(d.hosts.map((h: any) => h.blocked)).toEqual([null, '尚未收集到資料（可能還沒 bootstrap）', '尚未收集到資料（可能還沒 bootstrap）'])
  prometheus([['lab_nvidia_smi_ok', [vec(0, { __name__: 'up', instance: 'gpu01' })]]])
  expect(ok(await get('/api/admin/assign-hosts')).hosts[0]).toMatchObject({ up: false, blocked: '監控顯示離線' })
  prometheus([], { down: true })
  const down = ok(await get('/api/admin/assign-hosts'))
  expect(down.metrics_ok).toBe(false)
  expect(down.hosts[0]).toMatchObject({ gpu_count: 2, gpu_vram_gb: 80, gpus_free: null, up: null, granted: false, users: 1 })
  offline()
})

test('delete an account on a host: previewed, with or without its home', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const alice = person(con, 'alice', { uid: 20000 })
  observe(con, 'gpu01', 'old', 1005)
  observe(con, 'gpu01', 'alice', 20000)
  observe(con, 'gpu01', 'ops', 1009) // RESERVED_USERS
  con.tx(() => adopt(con, 'boss', 'gpu01', 'alice', alice))
  login(boss)
  const del = (u: string, body: Record<string, unknown>) => post(`/api/admin/hosts/gpu01/accounts/${u}/delete`, body)
  err(await del('old', { remove_home: true }), 400, '請輸入 old')
  err(await del('old', { remove_home: true, confirm: 'gpu01' }), 400, '請輸入 old')
  err(await del('ops', { remove_home: false }), 400, '保留')
  // the UI shows 保留帳號 instead of 認領 / 刪除 buttons for these
  expect(ok(await get('/api/admin/accounts?tab=unmanaged')).rows.map((r: any) => [r.username, r.reserved]))
    .toEqual([['old', false], ['ops', true]])
  expect(ok(await get('/api/hosts/gpu01')).accounts.find((a: any) => a.username === 'ops').reserved).toBe(true)
  err(await del('nobody', { remove_home: false }), 400, '沒有這個帳號')
  err(await post('/api/admin/hosts/gpu09/accounts/old/delete', { remove_home: false }), 404)
  // an old account nobody was assigned: managed from now on, without a person
  const j1 = ok(await del('old', { remove_home: false })).job_id
  const job1 = row(con, 'SELECT * FROM jobs WHERE id=?', j1)!
  expect([job1.kind, job1.auto_confirm, job1.status]).toEqual(['users', 0, 'queued']) // previewed like any sync
  expect(JSON.parse(job1.args_json)).toEqual({ target_hosts: 'gpu01', accounts: { gpu01: [
    { username: 'old', uid: 1005, state: 'absent', expires: null, keys_add: [], keys_remove: [], remove_home: false }] } })
  expect(row(con, "SELECT managed, person_id, desired FROM accounts WHERE username='old'")).toEqual({ managed: 1, person_id: null, desired: 'absent' })
  // changed one's mind (preview cancelled): such an account can still be adopted
  ok(await post(`/api/admin/jobs/${j1}/cancel`))
  const keeper = ok(await post('/api/admin/accounts/adopt', { host: 'gpu01', username: 'old' })).person_id
  expect(row(con, "SELECT person_id, desired, remove_home FROM accounts WHERE username='old'")).toEqual({ person_id: keeper, desired: 'present', remove_home: 0 })
  ok(await del('old', { remove_home: false }))
  // a member's account, home too (the username typed as confirmation)
  const j2 = ok(await del('alice', { remove_home: true, confirm: ' alice ' })).job_id
  expect(JSON.parse(val(con, 'SELECT args_json FROM jobs WHERE id=?', j2)).accounts.gpu01[0]).toMatchObject({ state: 'absent', remove_home: true })
  expect(JSON.parse(val(con, "SELECT detail_json FROM audit WHERE action='account_delete' ORDER BY id DESC"))).toEqual({ person_id: alice, remove_home: true })
  expect(ok(await get(`/api/admin/people/${alice}`)).hosts.find((h: any) => h.name === 'gpu01').granted).toBe(false)
  expect(ok(await get('/api/admin/accounts?tab=drift')).rows.map((r: any) => [r.username, r.drift])).toEqual([['alice', ['待刪除']], ['old', ['待刪除']]])
  // the accounts are gone (collect): nothing more to sync, the name can be granted again
  observe(con, 'gpu01', 'olda', 1006)
  ok(await del('olda', { remove_home: false }))
  con.tx(() => con.run("UPDATE accounts SET exists_on_host=0 WHERE host='gpu01' AND username IN ('old', 'alice', 'olda')"))
  con.tx(() => expect(enqueueUsers(con, 'boss')).toBeNull())
  const reuse = person(con, 'olda') // a new person with the name of a deleted, unassigned account
  expect(ok(await put(`/api/admin/people/${reuse}/grants`, { hosts: ['gpu01'] })).errors) // new hosts: only by an assignment
    .toEqual([{ host: 'gpu01', error: '尚未開通：新主機請用「指派主機」' }])
  expect(ok(await post(`/api/admin/people/${reuse}/assign`, { hosts: ['gpu01'] })).jobs.length).toBe(1)
  expect(row(con, "SELECT person_id, desired, remove_home, expected_uid FROM accounts WHERE username='olda'"))
    .toEqual({ person_id: reuse, desired: 'present', remove_home: 0, expected_uid: 20001 })
  expect(ok(await post(`/api/admin/people/${alice}/assign`, { hosts: ['gpu01'] })).jobs.length).toBe(1) // re-creating her own
  expect(row(con, "SELECT desired, remove_home, expected_uid FROM accounts WHERE username='alice'"))
    .toEqual({ desired: 'present', remove_home: 0, expected_uid: 20000 })
})

test('primary users', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const alice = person(con, 'alice')
  const bob = person(con, 'bob')
  con.tx(() => {
    con.run("UPDATE people SET name='Alice Wang', discord_name='alice_dc' WHERE id=?", alice)
    con.run("UPDATE people SET name='Bob Lin', discord_name='bob_dc' WHERE id=?", bob)
  })
  for (const [name, uid] of [['alice', 1001], ['bob', 1002], ['stray', 1003]] as [string, number][]) observe(con, 'gpu01', name, uid)
  con.tx(() => {
    adopt(con, 'boss', 'gpu01', 'alice', alice)
    adopt(con, 'boss', 'gpu01', 'bob', bob)
  })
  login(alice)
  err(await put('/api/admin/hosts/gpu01/accounts/alice/primary', { primary: true }), 403)
  login(boss)
  expect(ok(await put('/api/admin/hosts/gpu01/accounts/alice/primary', { primary: true }))).toEqual({ primary: true })
  err(await put('/api/admin/hosts/gpu01/accounts/stray/primary', { primary: true }), 404) // not managed
  err(await put('/api/admin/hosts/gpu02/accounts/alice/primary', { primary: true }), 404)
  expect(JSON.parse(val(con, "SELECT detail_json FROM audit WHERE action='primary_set'"))).toEqual({ primary: true })

  // members: the primary user's name and Discord name; other people only as before (id, username)
  login(bob)
  let accts = Object.fromEntries(ok(await get('/api/hosts/gpu01')).accounts.map((a: any) => [a.username, a]))
  expect(accts.alice.primary).toBe(true)
  expect(accts.alice.person).toEqual({ id: alice, username: 'alice', name: 'Alice Wang', discord_name: 'alice_dc' })
  expect([accts.bob.primary, accts.bob.person]).toEqual([false, { id: bob, username: 'bob' }])
  expect([accts.stray.primary, accts.stray.person]).toEqual([false, null])
  const hosts = Object.fromEntries(ok(await get('/api/hosts')).map((h: any) => [h.name, h]))
  expect(hosts.gpu01.primary_users).toEqual([{ username: 'alice', name: 'Alice Wang' }])
  expect(hosts.gpu02.primary_users).toEqual([])
  login(boss)
  accts = Object.fromEntries(ok(await get('/api/hosts/gpu01')).accounts.map((a: any) => [a.username, a]))
  expect(accts.bob.person).toEqual({ id: bob, username: 'bob', name: 'Bob Lin', discord_name: 'bob_dc' })
  expect(ok(await get(`/api/admin/people/${alice}`)).accounts.map((a: any) => a.primary)).toEqual([true])

  // bulk: the complete set; all or nothing
  err(await put('/api/admin/primary-users', { items: [{ host: 'gpu01', username: 'bob' }, { host: 'gpu01', username: 'stray' }] }), 400, 'gpu01/stray')
  expect(val(con, 'SELECT username FROM accounts WHERE primary_user=1')).toBe('alice')
  const r = ok(await put('/api/admin/primary-users', { items: [{ host: 'gpu01', username: 'bob' }, { host: 'gpu01', username: 'bob' }] }))
  expect(r).toEqual({ items: [{ host: 'gpu01', username: 'bob' }] })
  expect(con.all('SELECT username FROM accounts WHERE primary_user=1').map((x) => x.username)).toEqual(['bob'])
  expect(JSON.parse(val(con, "SELECT detail_json FROM audit WHERE action='primary_import'"))).toEqual({ count: 1 })
  login(alice)
  err(await put('/api/admin/primary-users', { items: [] }), 403)
})
