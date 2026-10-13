import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { type DB, allocUid, config, grant, io, localIso, notifications as nt } from '@labdeck/core'
import { outboxIo, sendDue } from '../src/outbox.ts'
import { scheduled } from '../src/runner.ts'
import { NOTIFIED, addDaysIso, fresh, localIsoOf, offline, person, row, val } from '../../../packages/core/test/helpers.ts'
import { err, get, login, ok, post, put } from '../../web/test/client.ts'

// Personal notifications: queueing in web requests and the schedule, delivery by the runner (Discord, SMTP).

const DISCORD_CONF = {
  discordClientId: 'dc-client', discordClientSecret: 'dc-secret-xyz', discordAuthorizeUrl: 'https://discord.example/oauth2/authorize',
  discordTokenUrl: 'https://discord.example/api/oauth2/token', discordProfileUrl: 'https://discord.example/api/users/@me',
  discordWebhookUrl: 'https://discord.example/api/webhooks/1/secret-token',
}
const SMTP_CONF = {
  smtpHost: 'smtp.example.org', smtpPort: 587, smtpSecurity: 'starttls' as const, smtpUser: 'lab@example.org',
  smtpPassword: 'smtp-pass-9f3k', smtpFrom: 'lab@example.org',
}

type Sent = { http: { url: string; json: any }[]; mail: Record<string, any>[]; smtp: Record<string, any>[]; fail: boolean; smtpError: unknown }
let saved: typeof config
let sent: Sent

/** Configure the channels (as from .env) and fake every way out: Discord HTTP and the SMTP transport. */
function notifyConfig({ discord = true, email = true } = {}): Sent {
  Object.assign(config, discord ? DISCORD_CONF : {}, email ? SMTP_CONF : {})
  sent = { http: [], mail: [], smtp: [], fail: false, smtpError: null }
  io.fetch = async (url: string, init?: RequestInit) => {
    sent.http.push({ url, json: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(null, { status: sent.fail ? 500 : 204 })
  }
  outboxIo.createTransport = (opts) => {
    sent.smtp.push(opts)
    return {
      sendMail: async (msg: Record<string, unknown>) => {
        if (sent.smtpError) throw sent.smtpError
        sent.mail.push(msg)
      },
      close: () => {},
    }
  }
  return sent
}

beforeEach(() => {
  saved = { ...config }
})
afterEach(() => {
  Object.assign(config, saved)
  offline()
})

test('notification prefs and email verification', async () => {
  const con = fresh()
  const alice = person(con, 'alice')
  con.tx(() => con.run("UPDATE people SET email='alice@example.edu' WHERE id=?", alice))
  login(alice)
  let n = ok(await get('/api/me/notifications'))
  expect(n.prefs).toEqual({ discord: [], email: [] }) // opt-in: everything off by default
  expect(n.events.map((e: any) => e.key)).toEqual(['expiry', 'maintenance'])
  expect(n.email.available).toBe(false)
  err(await put('/api/me/notifications', { discord: ['nope'], email: [] }), 400, '未知')
  n = ok(await put('/api/me/notifications', { discord: ['maintenance'], email: ['maintenance', 'expiry'] }))
  expect(n.prefs).toEqual({ discord: ['maintenance'], email: ['expiry', 'maintenance'] })
  expect(val(con, 'SELECT action FROM audit ORDER BY id DESC')).toBe('notify_prefs')
  err(await post('/api/me/email', { email: 'a@b.example' }), 404, '未設定')
  const s = notifyConfig()
  let e = ok(await get('/api/me/notifications')).email
  expect(e).toEqual({ available: true, address: 'alice@example.edu', sso_address: 'alice@example.edu', pending: null })
  for (const bad of ['nope', 'a@b', 'a b@example.org', 'x@example.org\nBcc: evil@example.org', `a@${'b'.repeat(250)}.org`]) {
    err(await post('/api/me/email', { email: bad }), 400, '格式')
  }
  e = ok(await post('/api/me/email', { email: 'alice@lab.example.org' })).email
  expect([e.address, e.pending]).toEqual(['alice@example.edu', 'alice@lab.example.org']) // unverified: not used yet
  const v = row(con, "SELECT * FROM outbox WHERE event='verify'")!
  expect([v.channel, v.to_addr, v.person_id, v.status]).toEqual(['email', 'alice@lab.example.org', alice, 'queued'])
  const code = v.body.split('：')[1].slice(0, 6)
  expect(code).toMatch(/^\d{6}$/)
  expect(v.subject).not.toContain(code)
  expect(val(con, 'SELECT code_hash FROM email_verifications')).not.toContain(code)
  err(await post('/api/me/email', { email: 'alice@lab.example.org' }), 429, '1 分鐘')
  err(await post('/api/me/email/verify', { code: code !== '000000' ? '000000' : '111111' }), 400, '不正確')
  expect(val(con, 'SELECT attempts FROM email_verifications')).toBe(1)
  e = ok(await post('/api/me/email/verify', { code })).email
  expect([e.address, e.pending]).toEqual(['alice@lab.example.org', null])
  err(await post('/api/me/email/verify', { code }), 400, '過期或不存在') // single use
  // the code mail itself: sent by the runner, and its body (the code) is not kept afterwards
  await sendDue(con)
  expect(s.mail.map((m) => m.to)).toEqual(['alice@lab.example.org'])
  expect(s.mail[0].text).toContain(code)
  expect(Object.values(row(con, "SELECT status, body FROM outbox WHERE event='verify'")!)).toEqual(['sent', ''])
  // brute force: 5 wrong codes lock the pending code
  con.tx(() => con.run("UPDATE email_verifications SET created_at='2000-01-01T00:00:00'"))
  ok(await post('/api/me/email', { email: 'other@lab.example.org' }))
  for (let i = 0; i < 5; i++) err(await post('/api/me/email/verify', { code: 'abcdef' }), 400, '不正確')
  err(await post('/api/me/email/verify', { code: 'abcdef' }), 400, '次數過多')
  // over the hourly mail limit: 429, nothing pending (the code mail would only be stored as skipped)
  con.tx(() => {
    con.run('DELETE FROM email_verifications')
    for (let i = 0; i < nt.RATE_PER_HOUR; i++) {
      nt.queue(con, 'email', 'expiry', `flood:${i}`, 's', 'b', alice)
    }
  })
  const outbox = val(con, 'SELECT count(*) FROM outbox')
  err(await post('/api/me/email', { email: 'third@lab.example.org' }), 429, '已達上限')
  expect(row(con, 'SELECT 1 FROM email_verifications')).toBeUndefined()
  expect(val(con, 'SELECT count(*) FROM outbox')).toBe(outbox)
  expect(ok(await get('/api/me/notifications')).email.pending).toBeNull()
  con.tx(() => con.run("UPDATE outbox SET created_at='2000-01-01T00:00:00'")) // an hour later
  expect(ok(await post('/api/me/email', { email: 'third@lab.example.org' })).email.pending).toBe('third@lab.example.org')
  // back to the SSO address: no code needed
  e = ok(await post('/api/me/email', { email: 'Alice@example.edu' })).email
  expect([e.address, e.pending]).toEqual(['alice@example.edu', null])
  expect(val(con, 'SELECT notify_email FROM people WHERE id=?', alice)).toBeNull()
})

function memberOn(con: DB, name: string, host: string, prefs: object | null, discordId: string | null, email: string | null): number {
  const pid = person(con, name, { uid: allocUid(con) })
  con.tx(() => {
    con.run('UPDATE people SET notify_prefs=?, discord_id=?, email=? WHERE id=?', prefs ? JSON.stringify(prefs) : null, discordId, email, pid)
    grant(con, 'admin', pid, host, true)
  })
  return pid
}

test('announcement fan-out: payloads, dedupe, retries, secrets never logged', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const both = { discord: ['maintenance'], email: ['maintenance'] }
  const alice = memberOn(con, 'alice', 'gpu02', both, '123456789012345678', 'alice@example.edu')
  memberOn(con, 'quiet', 'gpu02', null, '223456789012345678', 'quiet@example.edu') // never opted in
  memberOn(con, 'elsewhere', 'gpu01', both, '323456789012345678', 'e@example.edu') // not on the affected host
  memberOn(con, 'nolink', 'gpu02', both, null, null) // opted in but nothing linked: nothing to queue
  const at = localIsoOf(new Date(Date.now() + 3 * 86_400_000)).slice(0, 16)
  const s = notifyConfig()
  login(boss)
  const a = ok(await post('/api/admin/announcements', { title: '@everyone 停機', body: '換 UPS', hosts: ['gpu02'], starts_at: at }))
  const rows = con.all('SELECT * FROM outbox ORDER BY channel')
  expect(rows.map((r) => [r.person_id, r.channel, r.event])).toEqual([[alice, 'discord', 'maintenance'], [alice, 'email', 'maintenance']])
  expect(s.mail).toEqual([]) // the web request only queued them
  expect(s.http.filter((h) => h.url.includes('webhooks'))).toEqual([])
  con.tx(() => nt.announcement(con, a.id, 'created')) // dedupe: same key, no second row
  expect(val(con, 'SELECT COUNT(*) FROM outbox')).toBe(2)

  const logged: string[] = []
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
  })
  try {
    await sendDue(con)
    const hooks = s.http.filter((h) => h.url.includes('webhooks'))
    expect(hooks.length).toBe(1)
    expect(hooks[0].json.allowed_mentions).toEqual({ parse: [], users: ['123456789012345678'] }) // never @everyone
    expect(hooks[0].json.content.startsWith('<@123456789012345678> ')).toBe(true)
    expect(hooks[0].json.content).toContain('gpu02')
    expect(s.mail.length).toBe(1)
    const mail = s.mail[0]
    expect([mail.to, mail.from]).toEqual(['alice@example.edu', 'lab@example.org'])
    expect(mail.subject).toContain('停機')
    expect(mail.text).toContain('換 UPS')
    expect(mail.text).toContain('你有帳號的受影響主機：gpu02')
    expect(s.smtp[0]).toMatchObject({ host: 'smtp.example.org', port: 587, secure: false, requireTLS: true, ignoreTLS: false,
      auth: { user: 'lab@example.org', pass: 'smtp-pass-9f3k' }, tls: { rejectUnauthorized: true }, connectionTimeout: 20_000 })
    expect(con.all('SELECT status FROM outbox').map((r) => r.status)).toEqual(['sent', 'sent'])

    // delivery failures: retried later, marked failed after 3 attempts; secrets never logged
    con.tx(() => nt.announcement(con, a.id, 'reminder'))
    expect(val(con, 'SELECT COUNT(*) FROM outbox')).toBe(4)
    s.fail = true
    s.smtpError = Object.assign(new Error('Invalid login: 535 5.7.8 smtp-pass-9f3k rejected'), { code: 'EAUTH', responseCode: 535 })
    for (let i = 0; i < 3; i++) {
      await sendDue(con)
      con.tx(() => con.run("UPDATE outbox SET next_at='2000-01-01T00:00:00' WHERE status='queued'"))
    }
  } finally {
    warn.mockRestore()
  }
  expect(con.all('SELECT status, attempts, error FROM outbox WHERE id > 2 ORDER BY channel').map(Object.values))
    .toEqual([['failed', 3, 'HTTPStatusError 500'], ['failed', 3, 'SMTPAuthenticationError 535']])
  const text = logged.join(' ')
  expect(logged.length).toBeGreaterThan(0)
  expect(text).not.toContain('smtp-pass-9f3k')
  expect(text).not.toContain('secret-token')

  // a person who opts out (or unlinks) before delivery gets nothing
  s.fail = false
  con.tx(() => {
    nt.queue(con, 'discord', 'maintenance', 'manual:1', 's', 'b', alice)
    con.run('UPDATE people SET notify_prefs=? WHERE id=?', JSON.stringify({ discord: [], email: [] }), alice)
  })
  await sendDue(con)
  expect(val(con, "SELECT status FROM outbox WHERE dedupe_key='manual:1'")).toBe('skipped')
})

test('request results and expiry reminders', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const end = addDaysIso(200)
  con.tx(() => {
    for (const [sso, name] of [['s1', 'newbie'], ['s2', 'denied']]) {
      con.run(`INSERT INTO requests(sso_id, email, username, hosts_json, reason, expected_end, created_at)
               VALUES (?,?,?,'["gpu01"]','x',?,?)`, sso, `${name}@example.edu`, name, end, localIso(new Date()))
    }
  })
  login(boss)
  ok(await post('/api/admin/requests/1/assign', { username: 'newbie', hosts: ['gpu01'] }))
  ok(await post('/api/admin/requests/2/reject'))
  expect(val(con, 'SELECT COUNT(*) FROM outbox')).toBe(0) // email not configured: nothing queued
  notifyConfig({ discord: false })
  con.tx(() => con.run("UPDATE requests SET status='pending' WHERE id=2"))
  const back = ok(await post('/api/admin/requests/2/reject', { reason: '  請先找指導教授確認用途  ' }))
  expect([back.status, back.reject_reason]).toEqual(['rejected', '請先找指導教授確認用途']) // stored, shown to the requester
  const r = con.all('SELECT * FROM outbox')
  expect(r.length).toBe(1)
  expect([r[0].to_addr, r[0].event, r[0].person_id]).toEqual(['denied@example.edu', 'request', null])
  expect(r[0].subject).toContain('帳號登記已退回')
  expect(r[0].body).toContain('原因：請先找指導教授確認用途') // the reason is in the email
  expect(r[0].body).not.toContain('臨時密碼')

  const soon = memberOn(con, 'soon', 'gpu01', { discord: ['expiry'], email: ['expiry'] }, '423456789012345678', 'soon@example.edu')
  con.tx(() => con.run('UPDATE people SET expires_at=? WHERE id=?', addDaysIso(7), soon))
  const t = new Date()
  t.setHours(10, 0, 0, 0)
  await scheduled(con, t)
  await scheduled(con, t)
  const e = con.all("SELECT * FROM outbox WHERE event='expiry'") // Discord not configured: email only
  expect(e.length).toBe(1)
  expect([e[0].person_id, e[0].channel]).toEqual([soon, 'email'])
  expect(e[0].subject).toContain('剩 7 天')
  expect(NOTIFIED.filter((m) => m.includes('到期')).length).toBe(1) // the admin channel still gets its list
})

test('maintenance reminder 24 h before', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const alice = memberOn(con, 'alice', 'gpu01', { discord: [], email: ['maintenance'] }, null, 'alice@example.edu')
  const start = new Date(Date.now() + 30 * 3600_000)
  start.setMilliseconds(0)
  notifyConfig({ discord: false })
  login(boss)
  const a = ok(await post('/api/admin/announcements', { title: '換硬碟', body: 'x', hosts: ['gpu01'], starts_at: localIsoOf(start),
    ends_at: localIsoOf(new Date(start.getTime() + 2 * 3600_000)) }))
  expect(con.all('SELECT dedupe_key FROM outbox').map((r) => r.dedupe_key)).toEqual([`announcement:${a.id}:created:${alice}`])
  await scheduled(con, new Date()) // 30 h ahead: not yet
  expect(val(con, 'SELECT COUNT(*) FROM outbox')).toBe(1)
  const later = new Date(Date.now() + 7 * 3600_000)
  await scheduled(con, later)
  await scheduled(con, later)
  const r = row(con, "SELECT * FROM outbox WHERE dedupe_key LIKE '%reminder%'")!
  expect(r.person_id).toBe(alice)
  expect(r.body).toContain('維護時間')
  expect(r.subject).toContain('換硬碟')
  expect(r.body).not.toContain('換硬碟') // the title is the subject (Discord: the bold first line), not repeated
  // the lab channel post says when and where
  expect(NOTIFIED.find((m) => m.startsWith('[公告] 換硬碟'))).toMatch(/^\[公告\] 換硬碟\n時間：\d\d\/\d\d \d\d:\d\d – \d\d\/\d\d \d\d:\d\d\n影響主機：gpu01\nx$/)
  expect(val(con, 'SELECT COUNT(*) FROM outbox')).toBe(2)
})
