import { expect, test } from 'vitest'
import { adopt, config, describeJob, grant } from '@labdeck/core'
import { NOTIFIED, addDaysIso, fresh, observe, person, row, val } from '../../../packages/core/test/helpers.ts'
import { call, err, get, login, ok, post, put, setSession } from './client.ts'

// The three removal flows (api.md 移除): 移除登記, 移除成員 (offboarding), 移除某台主機的帳號 (鎖定／刪除).

const del = (url: string) => call('DELETE', url)

async function withSmtp(fn: () => Promise<void>) {
  const saved = { ...config }
  Object.assign(config, { smtpHost: 'smtp.example.org', smtpFrom: 'lab@example.org' })
  try {
    await fn()
  } finally {
    Object.assign(config, saved)
  }
}

test('移除登記: deleted silently (no email, no Discord), unlike 退回; the identity may register again', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const mem = person(con, 'mem', { sso_id: 'M001' })
  const good = { name: 'Dup', username: 'dup', purpose: 'p', gpus: 1, until: addDaysIso(30) }
  await withSmtp(async () => {
    setSession({ sso_id: 'N200', email: 'n200@example.edu', csrf: 'tok' })
    const r1 = ok(await post('/api/register', good)).id
    setSession({ sso_id: 'N201', email: 'n201@example.edu', csrf: 'tok' })
    const r2 = ok(await post('/api/register', good)).id
    login(mem)
    const hr = ok(await post('/api/me/host-requests', { purpose: 'more', gpus: 1, until: addDaysIso(30) })).id
    err(await del(`/api/admin/requests/${r1}`), 403)

    login(boss)
    NOTIFIED.length = 0
    expect(ok(await del(`/api/admin/requests/${r1}`))).toEqual({})
    expect(row(con, 'SELECT 1 FROM requests WHERE id=?', r1)).toBeUndefined()
    expect(val(con, 'SELECT COUNT(*) FROM outbox')).toBe(0) // nothing to the person, though SMTP is configured
    expect(NOTIFIED).toEqual([]) // nor to Discord
    expect(JSON.parse(val(con, "SELECT detail_json FROM audit WHERE action='request_delete'")))
      .toEqual({ request: r1, kind: 'account', sso_id: 'N200', name: 'Dup' })
    // a member's host request too
    ok(await del(`/api/admin/requests/${hr}`))
    expect(ok(await get('/api/admin/requests')).map((r: any) => r.id)).toEqual([r2])
    err(await del(`/api/admin/requests/${r1}`), 404)
    // 退回, by contrast, tells the person (the email with its reason) and keeps the row
    ok(await post(`/api/admin/requests/${r2}/reject`, { reason: '重複' }))
    expect(val(con, "SELECT COUNT(*) FROM outbox WHERE to_addr='n201@example.edu'")).toBe(1)
    err(await del(`/api/admin/requests/${r2}`), 409, '已處理') // only pending ones

    // the removed identity registers again as if nothing happened
    setSession({ sso_id: 'N200', email: 'n200@example.edu', csrf: 'tok' })
    expect(ok(await get('/api/register'))).toEqual({ registration: null, can_register: true })
    ok(await post('/api/register', good))
    login(mem)
    expect(ok(await get('/api/me/host-requests')).can_request).toBe(true)
  })
})

/** boss (admin); alice: an active member with an SSO ID, Discord, Email prefs, gpu01 (on the host) and gpu02 (not yet). */
function offboardingSeed() {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin', sso_id: 'B001' })
  const alice = person(con, 'alice', { uid: 20000, sso_id: 'A001' })
  observe(con, 'gpu01', 'alice', 20000)
  con.tx(() => {
    adopt(con, 'boss', 'gpu01', 'alice', alice)
    grant(con, 'boss', alice, 'gpu02', true)
    con.run(`UPDATE people SET discord_id='42', discord_name='alice_dc', notify_email='a@example.org',
             notify_prefs='{"discord":["maintenance"],"email":["expiry"]}', temp_password='Tmp12345', temp_password_pending=1 WHERE id=?`, alice)
    con.run("INSERT INTO email_verifications(person_id, email, code_hash, expires_at, created_at) VALUES (?, 'x@example.org', 'h', '2099-01-01', '2026-01-01')", alice)
  })
  return { con, boss, alice }
}

test('移除成員: one previewed job per host account, identity and links cleared, requests closed, history kept', async () => {
  const { con, boss, alice } = offboardingSeed()
  login(alice)
  const hr = ok(await post('/api/me/host-requests', { purpose: 'more', gpus: 1, until: addDaysIso(30) })).id
  login(boss)
  const remove = (hosts: unknown[]) => post(`/api/admin/people/${alice}/remove`, { hosts })
  const lock2 = { host: 'gpu02', action: 'lock' }
  // every host account needs a choice; nothing else is accepted
  err(await remove([lock2]), 400, '請為每台主機選擇鎖定或刪除：gpu01')
  err(await remove([lock2, { host: 'gpu01', action: 'lock' }, { host: 'gpu03', action: 'lock' }]), 400, 'gpu03')
  err(await remove([lock2, { host: 'gpu01', action: 'nuke' }]), 400, '請選擇鎖定或刪除')
  err(await remove([lock2, { host: 'gpu01', action: 'lock' }, { host: 'gpu01', action: 'delete' }]), 400, '只能選一次')
  // the same guards as deleting one account: an account not on the host, the home directory's typed confirmation
  err(await remove([{ host: 'gpu02', action: 'delete' }, { host: 'gpu01', action: 'lock' }]), 400, 'gpu02：主機上沒有這個帳號')
  err(await remove([lock2, { host: 'gpu01', action: 'delete', remove_home: true, confirm: 'gpu01' }]), 400, '請輸入 alice')
  err(await remove([lock2, { host: 'gpu01', action: 'lock', remove_home: true }]), 400, '鎖定不會刪除家目錄')
  // all or nothing
  expect(val(con, 'SELECT COUNT(*) FROM jobs')).toBe(0)
  expect(row(con, 'SELECT status, sso_id, removed_at FROM people WHERE id=?', alice)).toEqual({ status: 'active', sso_id: 'A001', removed_at: null })

  NOTIFIED.length = 0
  const out = ok(await remove([lock2, { host: 'gpu01', action: 'delete', remove_home: true, confirm: ' alice ' }]))
  expect(out.jobs.map((j: any) => [j.host, j.action])).toEqual([['gpu01', 'delete'], ['gpu02', 'lock']])
  const job = (h: string) => row(con, 'SELECT * FROM jobs WHERE id=?', out.jobs.find((j: any) => j.host === h).job_id)!
  for (const h of ['gpu01', 'gpu02']) {
    expect([job(h).kind, job(h).auto_confirm, job(h).status]).toEqual(['users', 0, 'queued']) // previewed, never automatic
  }
  expect(JSON.parse(job('gpu01').args_json)).toEqual({ target_hosts: 'gpu01', accounts: { gpu01: [
    { username: 'alice', uid: 20000, state: 'absent', expires: null, keys_add: [], keys_remove: [], remove_home: true }] } })
  expect(JSON.parse(job('gpu02').args_json)).toEqual({ target_hosts: 'gpu02', accounts: { gpu02: [
    { username: 'alice', uid: 20000, state: 'locked', expires: null, keys_add: [], keys_remove: [] }] } })
  expect(describeJob('users', JSON.parse(job('gpu02').args_json))).toBe('鎖定 alice @gpu02')
  // the person: removed and locked, identity and notification links cleared, the row kept
  expect(row(con, `SELECT status, sso_id, discord_id, discord_name, notify_email, notify_prefs, temp_password, temp_password_pending,
                   email, removed_at IS NOT NULL AS removed FROM people WHERE id=?`, alice)).toEqual({
    status: 'locked', sso_id: null, discord_id: null, discord_name: null, notify_email: null, notify_prefs: null,
    temp_password: null, temp_password_pending: 0, email: null, removed: 1,
  })
  expect(val(con, 'SELECT COUNT(*) FROM email_verifications')).toBe(0)
  expect(out.person).toMatchObject({ id: alice, status: 'locked', sso_id: null })
  expect(out.person.removed_at).toBeTruthy()
  expect(row(con, 'SELECT status, decision_note FROM requests WHERE id=?', hr)).toEqual({ status: 'rejected', decision_note: '人員已移除' })
  expect(JSON.parse(val(con, "SELECT detail_json FROM audit WHERE action='person_remove'"))).toEqual({
    sso_id: 'A001', closed_requests: 1, hosts: { gpu01: 'delete_home', gpu02: 'lock' }, jobs: [job('gpu01').id, job('gpu02').id],
  })
  expect(NOTIFIED).toEqual(['[移除成員] boss 移除了 alice：gpu01 刪除（含家目錄）、gpu02 鎖定；2 個預覽工作待確認'])
  // still listed (history), out of every picker (not active), and can't be removed twice
  expect(ok(await get('/api/admin/people')).find((p: any) => p.id === alice)).toMatchObject({ status: 'locked', removed_at: out.person.removed_at })
  err(await remove([]), 409, '已經移除')
  err(await post(`/api/admin/people/${alice}/assign`, { hosts: ['gpu03'] }), 400, '停用')

  // her old login no longer reaches a member: neither the session she had nor a new one with the same SSO ID
  setSession({ person_id: alice, sso_id: 'A001', csrf: 'tok' })
  expect(ok(await get('/api/session')).user).toBeNull()
  err(await get('/api/me'), 403)
  setSession({ sso_id: 'A001', csrf: 'tok' })
  expect(ok(await get('/api/session')).user).toBeNull()

  // set back to active on the person page: no longer removed
  login(boss)
  ok(await put(`/api/admin/people/${alice}`, { name: null, email: null, sso_id: 'A001', expires_at: null, status: 'active' }))
  expect(val(con, 'SELECT removed_at FROM people WHERE id=?', alice)).toBeNull()
})

test('移除成員: never oneself, never the last active admin; another admin can be removed', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const mem = person(con, 'mem')
  login(boss)
  err(await post(`/api/admin/people/${boss}/remove`, { hosts: [] }), 400, '最後一位啟用中的管理員')
  const second = person(con, 'second', { role: 'admin' })
  err(await post(`/api/admin/people/${boss}/remove`, { hosts: [] }), 400, '不能移除自己')
  err(await post(`/api/admin/people/999/remove`, { hosts: [] }), 404)
  login(mem)
  err(await post(`/api/admin/people/${second}/remove`, { hosts: [] }), 403)
  login(boss)
  expect(ok(await post(`/api/admin/people/${second}/remove`, { hosts: [] }))).toMatchObject({ jobs: [] })
  expect(row(con, 'SELECT role, status FROM people WHERE id=?', second)).toEqual({ role: 'admin', status: 'locked' }) // no demotion on the web
  expect(row(con, 'SELECT role, status FROM people WHERE id=?', boss)).toEqual({ role: 'admin', status: 'active' })
})

test('移除某台主機的帳號: lock or delete, previewed; reserved accounts and the bot are untouchable', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const alice = person(con, 'alice', { uid: 20000 })
  observe(con, 'gpu01', 'alice', 20000)
  observe(con, 'gpu01', 'old', 1005) // nobody claimed it
  observe(con, 'gpu01', 'ops', 1009) // RESERVED_USERS
  observe(con, 'gpu01', 'labbot', 999) // the bot
  con.tx(() => adopt(con, 'boss', 'gpu01', 'alice', alice))
  login(boss)
  const lock = (u: string, h = 'gpu01') => post(`/api/admin/hosts/${h}/accounts/${u}/lock`)
  const remove = (u: string) => post(`/api/admin/hosts/gpu01/accounts/${u}/delete`, { remove_home: false })
  for (const u of ['ops', 'labbot', 'root']) {
    err(await lock(u), 400, '保留')
    err(await remove(u), 400, u === 'root' ? '' : '保留')
  }
  err(await lock('old'), 400, '請先認領')
  err(await lock('nobody'), 400, '沒有這個帳號')
  err(await lock('alice', 'gpu09'), 404)
  const j = ok(await lock('alice')).job_id
  const job = row(con, 'SELECT * FROM jobs WHERE id=?', j)!
  expect([job.kind, job.auto_confirm, job.status]).toEqual(['users', 0, 'queued'])
  expect(JSON.parse(job.args_json)).toEqual({ target_hosts: 'gpu01', accounts: { gpu01: [
    { username: 'alice', uid: 20000, state: 'locked', expires: null, keys_add: [], keys_remove: [] }] } })
  expect(ok(await get(`/api/admin/jobs/${j}`)).summary).toBe('鎖定 alice @gpu01')
  expect(row(con, "SELECT desired FROM accounts WHERE username='alice'")).toEqual({ desired: 'locked' })
  expect(JSON.parse(val(con, "SELECT detail_json FROM audit WHERE action='account_lock'"))).toEqual({ person_id: alice })
  // restored the usual way (停用／恢復主機帳號)
  expect(ok(await put(`/api/admin/people/${alice}/grants`, { hosts: ['gpu01'] })).errors).toEqual([])
  expect(row(con, "SELECT desired FROM accounts WHERE username='alice'")).toEqual({ desired: 'present' })
  expect(ok(await remove('old')).job_id).toBeTruthy() // an unclaimed account can still be deleted
  expect(ok(await get('/api/hosts/gpu01')).accounts.filter((a: any) => a.reserved).map((a: any) => a.username).sort()).toEqual(['labbot', 'ops'])
})
