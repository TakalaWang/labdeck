import { afterEach, expect, test } from 'vitest'
import { config, io } from '@labdeck/core'
import { DEFAULT_GUIDE, GUIDE_MAX, fillPlaceholders, icsFold, icsText } from '../src/server/routes-content.ts'
import { addDaysIso, fresh, localIsoOf, offline, person, row, val } from '../../../packages/core/test/helpers.ts'
import { ORIGIN, SESSION, call, err, get, login, ok, post, put, setSession } from './client.ts'

afterEach(() => offline())

// --- new-member guide -------------------------------------------------------------------

test('guide: default, update and placeholders', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const mem = person(con, 'mem')
  setSession({ sso_id: 'N001', csrf: 'tok' }) // logged in with SSO, not a member yet: may read the guide
  const g = ok(await get('/api/guide'))
  expect([g.is_default, g.updated_at, g.updated_by]).toEqual([true, null, null])
  expect(g.markdown).toContain('Test Lab')
  expect(g.markdown).toContain('ExampleID')
  expect(g.markdown).not.toContain('{{')
  expect(fillPlaceholders('{{site_name}}/{{ oauth_name }}/{{public_url}}/{{nope}}/{{site_name'))
    .toBe('Test Lab/ExampleID/https://portal.test/{{nope}}/{{site_name')
  expect(fillPlaceholders('{{site_name}}')).toBe(config.siteName) // plain text, no regex escapes applied
  err(await put('/api/admin/guide', { source: 'x' }), 403)

  login(mem)
  err(await put('/api/admin/guide', { source: 'x' }), 403, '管理員')
  err(await get('/api/admin/guide'), 403)
  login(boss)
  let a = ok(await get('/api/admin/guide'))
  expect(a.source).toBe(DEFAULT_GUIDE())
  expect(a.default).toBe(DEFAULT_GUIDE())
  expect(a.source).toContain('{{site_name}}')
  expect(a.placeholders).toEqual({ site_name: 'Test Lab', oauth_name: 'ExampleID', public_url: 'https://portal.test' })
  for (const headers of [{ Origin: ORIGIN }, { Origin: 'https://evil.example', 'X-CSRF-Token': 'tok' }]) {
    err(await call('PUT', '/api/admin/guide', { source: 'hacked' }, headers), 403, 'CSRF')
  }
  err(await put('/api/admin/guide', { source: '  \n ' }), 400, '請填寫')
  err(await put('/api/admin/guide', { source: 'x'.repeat(GUIDE_MAX + 1) }), 400, '過長')
  expect([val(con, 'SELECT COUNT(*) FROM pages'), val(con, 'SELECT COUNT(*) FROM audit')]).toEqual([0, 0])

  const src = '# 歡迎來到 {{site_name}}\r\n\r\n<script>alert(1)</script> [x](javascript:alert(1))\n'
  a = ok(await put('/api/admin/guide', { source: src }))
  expect(a.source).toBe('# 歡迎來到 {{site_name}}\n\n<script>alert(1)</script> [x](javascript:alert(1))')
  expect([a.is_default, a.updated_by]).toEqual([false, 'boss'])
  expect(a.updated_at).toBeTruthy()
  const audit = row(con, 'SELECT actor, action, target, detail_json FROM audit')!
  expect([audit.actor, audit.action, audit.target]).toEqual(['boss', 'guide_update', 'page/guide'])
  expect({ ...JSON.parse(audit.detail_json), sha256: '-' }).toEqual({ chars: Array.from(a.source as string).length, default: false, sha256: '-' })
  login(mem) // the member sees it with placeholders filled; the Markdown is passed through (the SPA renders it safely)
  const g2 = ok(await get('/api/guide'))
  expect(g2.markdown.startsWith('# 歡迎來到 Test Lab\n')).toBe(true)
  expect([g2.is_default, g2.updated_by]).toEqual([false, 'boss'])

  login(boss) // saving the built-in text verbatim goes back to the default
  expect(ok(await put('/api/admin/guide', { source: DEFAULT_GUIDE() })).is_default).toBe(true)
  expect([val(con, 'SELECT COUNT(*) FROM pages'), val(con, 'SELECT COUNT(*) FROM audit')]).toEqual([0, 2])
})

test('guide: the members section only for members', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const mem = person(con, 'mem')
  const old = person(con, 'old', { expires_at: addDaysIso(-1) })
  login(boss)
  err(await put('/api/admin/guide/members', { source: 'x'.repeat(GUIDE_MAX + 1) }), 400, '過長')
  const a = ok(await put('/api/admin/guide/members', { source: 'WiFi：Secret-WiFi-42 @ {{site_name}}\r\n' }))
  expect(a.members_source).toBe('WiFi：Secret-WiFi-42 @ {{site_name}}')
  expect(a.is_default).toBe(true) // public guide untouched
  expect(val(con, 'SELECT detail_json FROM audit')).not.toContain('Secret-WiFi-42')
  login(mem)
  err(await put('/api/admin/guide/members', { source: 'x' }), 403, '管理員')
  expect(ok(await get('/api/guide')).members_markdown).toBe('WiFi：Secret-WiFi-42 @ Test Lab')
  for (const who of [old, null]) { // expired member; SSO applicant without an account
    if (who) login(who)
    else setSession({ sso_id: 'N009', csrf: 'tok' })
    const g = ok(await get('/api/guide'))
    expect(g.members_markdown).toBeNull()
    expect(JSON.stringify(g)).not.toContain('Secret-WiFi-42')
  }
  login(boss)
  expect(ok(await put('/api/admin/guide/members', { source: ' ' })).members_source).toBe('')
  expect(val(con, 'SELECT COUNT(*) FROM pages')).toBe(0)
})

// --- maintenance calendar --------------------------------------------------------------

function unfold(ics: string): string[] {
  expect(ics.endsWith('\r\n')).toBe(true)
  expect(ics.replaceAll('\r\n', '')).not.toContain('\n') // CRLF only
  const lines = ics.split('\r\n').slice(0, -1)
  for (const line of lines) expect(Buffer.byteLength(line), line).toBeLessThanOrEqual(75)
  return lines.join('\r\n').replaceAll('\r\n ', '').split('\r\n')
}

const utc = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

test('calendar and iCal feed', async () => {
  const con = fresh()
  const boss = person(con, 'boss', { role: 'admin' })
  const mem = person(con, 'mem')
  login(boss)
  const nowD = new Date()
  nowD.setMilliseconds(0)
  const tomorrow = new Date(nowD.getTime() + 86_400_000)
  tomorrow.setHours(9, 0, 0, 0)
  const title = `維護; A,B \\ C${'長'.repeat(40)}`
  const maint = ok(await post('/api/admin/announcements', {
    title, body: '第一行\n第二行', starts_at: localIsoOf(tomorrow), ends_at: localIsoOf(new Date(tomorrow.getTime() + 9 * 3600_000)),
    hosts: ['gpu02', 'gpu01'],
  }))
  expect(maint.hosts).toEqual(['gpu01', 'gpu02']) // inventory order
  expect(JSON.parse(val(con, "SELECT detail_json FROM audit WHERE action='announce'")).hosts).toEqual(['gpu01', 'gpu02'])
  err(await post('/api/admin/announcements', { title: 'x', body: 'y', hosts: ['nope'] }), 400)
  const at = new Date(nowD.getTime() + 2 * 86_400_000)
  at.setHours(22, 0, 0, 0)
  // scheduled shutdowns were removed: refused, never silently dropped; the old endpoint is gone
  err(await post('/api/admin/announcements', { title: '停機', body: 'x', shutdown: { hosts: ['gpu01'], at: localIsoOf(at) } }), 400, '排程關機')
  expect(val(con, 'SELECT COUNT(*) FROM announcements')).toBe(1)
  err(await post(`/api/admin/announcements/${maint.id}/cancel-shutdown`), 404)
  // an announcement made while they existed reads as a plain one (its shutdown job only stays in the job history)
  const sd = con.tx(() => {
    const jid = con.run("INSERT INTO jobs(kind, args_json, actor, run_at, created_at) VALUES ('shutdown', ?, 'boss', ?, ?)",
      JSON.stringify({ target_hosts: 'gpu01', action: 'poweroff', delay_min: 10 }), localIsoOf(at), localIsoOf(nowD)).lastInsertRowid
    return { id: con.run("INSERT INTO announcements(title, body, starts_at, shutdown_job_id, created_by, created_at) VALUES ('停機', 'x', ?, ?, 'boss', ?)",
      localIsoOf(at), jid, localIsoOf(nowD)).lastInsertRowid }
  })
  const old = ok(await post('/api/admin/announcements', { title: '舊', body: 'x', starts_at: '2020-01-01T00:00', ends_at: '2020-01-02T00:00' }))

  login(mem)
  const first = addDaysIso(-1)
  const last = addDaysIso(40)
  const cal = ok(await get(`/api/calendar?start=${first}&end=${last}`))
  const ids = cal.events.map((e: any) => e.id)
  expect(ids).toContain(maint.id)
  expect(ids).toContain(sd.id)
  expect(ids).not.toContain(old.id)
  expect([cal.start, cal.end]).toEqual([first, last])
  expect(Object.keys(cal.events.find((e: any) => e.id === sd.id)).sort()).toEqual(['body', 'created_by', 'ends_at', 'hosts', 'id', 'starts_at', 'title'])
  expect(cal.subscribe_url.startsWith(`https://portal.test/api/calendar.ics?token=${mem}.`)).toBe(true)
  const jan = ok(await get('/api/calendar?start=2020-01-01&end=2020-01-31'))
  expect(jan.events.map((e: any) => e.id)).toEqual([old.id])
  expect(ok(await get('/api/calendar')).start).toBe(`${localIsoOf(new Date()).slice(0, 8)}01`) // default: this month
  err(await get('/api/calendar?start=2026-01-01&end=2026-12-31'), 400, '範圍')
  err(await get('/api/calendar?start=2026-02-01&end=2026-01-01'), 400)
  err(await get('/api/calendar?start=bad'), 400)

  const r = await get('/api/calendar.ics')
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
  const lines = unfold(r.text)
  expect(lines.slice(0, 3)).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//labdeck//maintenance calendar//ZH-TW'])
  expect(lines[lines.length - 1]).toBe('END:VCALENDAR')
  expect(lines).toContain('X-WR-CALNAME:Test Lab 維護日曆')
  expect(lines.filter((l) => l === 'BEGIN:VEVENT').length).toBe(2) // maintenance, the old shutdown's announcement
  expect(lines.filter((l) => l === 'END:VEVENT').length).toBe(2)
  expect(lines).toContain(`UID:announcement-${maint.id}@portal.test`)
  expect(lines).toContain(`UID:announcement-${sd.id}@portal.test`)
  expect(lines.some((l) => l.startsWith('UID:shutdown-'))).toBe(false)
  expect(lines).not.toContain(`UID:announcement-${old.id}@portal.test`) // older than 180 days
  let i = lines.indexOf(`UID:announcement-${maint.id}@portal.test`)
  expect(lines.slice(i + 2, i + 7)).toEqual([`DTSTART:${utc(tomorrow)}`, `DTEND:${utc(new Date(tomorrow.getTime() + 9 * 3600_000))}`,
    `SUMMARY:[維護] 維護\\; A\\,B \\\\ C${'長'.repeat(40)}`, 'DESCRIPTION:第一行\\n第二行\\n\\n影響主機：gpu01、gpu02', 'URL:https://portal.test/announcements?tab=calendar'])
  i = lines.indexOf(`UID:announcement-${sd.id}@portal.test`)
  expect(lines.slice(i + 2, i + 5)).toEqual([`DTSTART:${utc(at)}`, 'SUMMARY:停機', 'DESCRIPTION:x'])
  expect(icsText('a\r\nb\x00c\td')).toBe('a\\nbc\td') // control characters dropped, HTAB allowed
  expect(icsFold('X'.repeat(75))).toBe('X'.repeat(75))
  expect(icsFold('X'.repeat(76))).toBe(`${'X'.repeat(75)}\r\n X`)
  expect(icsFold('字'.repeat(30))).toBe(`${'字'.repeat(25)}\r\n ${'字'.repeat(5)}`) // 3-byte chars never split

  // the subscription token works without a session; a wrong, foreign or locked person's token does not
  const token = cal.subscribe_url.split('token=')[1]
  setSession({})
  err(await get('/api/calendar.ics'), 401)
  expect((await get(`/api/calendar.ics?token=${token}`)).status).toBe(200)
  for (const bad of [token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'), `${boss}.${token.split('.')[1]}`, 'x', '99999999999999999999.a', 'ü']) {
    err(await get(`/api/calendar.ics?token=${encodeURIComponent(bad)}`), 403, '訂閱連結無效')
  }
  con.tx(() => con.run("UPDATE people SET status='locked' WHERE id=?", mem))
  err(await get(`/api/calendar.ics?token=${token}`), 403)
})

// --- Discord linking ---------------------------------------------------------------------

export const DISCORD_CONF = {
  discordClientId: 'dc-client', discordClientSecret: 'dc-secret-xyz', discordAuthorizeUrl: 'https://discord.example/oauth2/authorize',
  discordTokenUrl: 'https://discord.example/api/oauth2/token', discordProfileUrl: 'https://discord.example/api/users/@me',
}

test('Discord link flow', async () => {
  const con = fresh()
  const alice = person(con, 'alice')
  const bob = person(con, 'bob')
  login(alice)
  err(await get('/auth/discord/start'), 404, '未設定')
  expect(ok(await get('/api/me/notifications')).discord).toEqual({ available: false, linked: false, name: null })
  const saved = { ...config }
  Object.assign(config, DISCORD_CONF, { discordWebhookUrl: 'https://discord.example/api/webhooks/1/secret-token' })
  const http: { url: string; body?: string; headers?: Record<string, string> }[] = []
  const profile: Record<string, string> = { id: '123456789012345678', username: 'alice_dc', global_name: 'Alice DC' }
  io.fetch = async (url: string, init?: RequestInit) => {
    http.push({ url, body: init?.body ? String(init.body) : undefined, headers: init?.headers as Record<string, string> })
    if (url === DISCORD_CONF.discordTokenUrl) return Response.json({ access_token: 'dtok', token_type: 'Bearer' })
    return Response.json({ ...profile })
  }
  const linkDiscord = async (pid: number) => {
    login(pid)
    const r = await get('/auth/discord/start')
    const state = new URL(r.headers.get('location')!).searchParams.get('state')
    return get(`/auth/discord/callback?code=c0de&state=${state}`)
  }
  try {
    const r = await get('/auth/discord/start')
    const loc = new URL(r.headers.get('location')!)
    const q = Object.fromEntries(loc.searchParams)
    expect(r.status).toBe(302)
    expect(`${loc.origin}${loc.pathname}`).toBe(DISCORD_CONF.discordAuthorizeUrl)
    expect([q.client_id, q.scope, q.response_type, q.redirect_uri]).toEqual(['dc-client', 'identify', 'code', 'https://portal.test/auth/discord/callback'])
    expect(SESSION.discord_state).toBe(`${alice}:${q.state}`)
    // forged / replayed state: refused, nothing fetched, the pending state is used up
    expect((await get('/auth/discord/callback?code=x&state=forged')).headers.get('location')).toBe('/me?discord=error')
    expect(SESSION).not.toHaveProperty('discord_state')
    expect(http).toEqual([])
    expect((await get(`/auth/discord/callback?code=x&state=${q.state}`)).headers.get('location')).toBe('/me?discord=error')
    await get('/auth/discord/start') // denied at Discord: no code
    expect((await get('/auth/discord/callback?error=access_denied&state=x')).headers.get('location')).toBe('/me?discord=error')

    expect((await linkDiscord(alice)).headers.get('location')).toBe('/me?discord=linked')
    const [tok, me] = http
    expect(tok.url).toBe(DISCORD_CONF.discordTokenUrl)
    expect(Object.fromEntries(new URLSearchParams(tok.body))).toEqual({ client_id: 'dc-client', client_secret: 'dc-secret-xyz',
      grant_type: 'authorization_code', code: 'c0de', redirect_uri: 'https://portal.test/auth/discord/callback' })
    expect(me.url).toBe(DISCORD_CONF.discordProfileUrl)
    expect(me.headers!.Authorization).toBe('Bearer dtok')
    expect(Object.values(row(con, 'SELECT discord_id, discord_name FROM people WHERE id=?', alice)!)).toEqual(['123456789012345678', 'Alice DC'])
    expect(ok(await get('/api/me/notifications')).discord).toEqual({ available: true, linked: true, name: 'Alice DC' })
    expect(JSON.parse(val(con, "SELECT detail_json FROM audit WHERE action='discord_link'"))).toEqual({ discord_id: '123456789012345678' })
    // the same Discord user can't be linked to a second person; a malformed ID is refused
    expect((await linkDiscord(bob)).headers.get('location')).toBe('/me?discord=taken')
    profile.id = 'not-a-snowflake'
    expect((await linkDiscord(bob)).headers.get('location')).toBe('/me?discord=error')
    expect(val(con, 'SELECT discord_id FROM people WHERE id=?', bob)).toBeNull()
    // unlink needs CSRF like every POST
    login(alice)
    err(await call('POST', '/api/me/discord/unlink', undefined, { Origin: ORIGIN }), 403, 'CSRF')
    expect(ok(await post('/api/me/discord/unlink')).discord.linked).toBe(false)
    setSession({})
    err(await get('/auth/discord/callback?code=c&state=s'), 401)
    login(person(con, 'locked', { status: 'locked' }))
    err(await get('/auth/discord/start'), 403)
  } finally {
    Object.assign(config, saved)
  }
})
