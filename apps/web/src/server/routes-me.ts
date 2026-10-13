import { timingSafeEqual } from 'node:crypto'
import {
  Conflict, type DB, type Row, ValueErr, addMinutes, audit, checkNewUsername, config, enqueueUsers, localDate, localIso, notify, now,
  notifications as nt, parseDate, parseIso, parsePubkey, pyJson, usage,
} from '@labdeck/core'
import { type Ctx, identity, member, newToken, route } from './app.ts'
import { HttpError, model, opt, pathInt } from './http.ts'
import { JOB_LIVE, accountsAndKeys, keyJson, requestJson, userJson } from './views.ts'

/**
 * Never changes anything (a reload shows the same page). The temp password is shown once a job creating one of the
 * person's accounts succeeded, until its owner acknowledges it (POST /api/me/temp-password/ack).
 */
route('GET', '/api/me', (ctx) => {
  const me = member(ctx)
  const { accounts, keys } = accountsAndKeys(ctx.con, me.id)
  const ready = Boolean(me.temp_password) && !me.temp_password_pending
  // the account-creation state of hosts that are to be opened but not there yet, from their assignment jobs
  const opening = accounts.filter((a) => a.desired === 'present' && !a.exists)
  const live = opening.some((a) => a.job_status !== null && JOB_LIVE.has(a.job_status))
  const failed = opening.some((a) => a.job_status === 'failed' || a.job_status === 'check_failed')
  const setup = ready ? null : live ? 'pending' : failed ? 'failed' : me.temp_password_pending ? 'pending' : null
  return { person: userJson(me), accounts, keys, temp_password: ready ? me.temp_password : null, account_setup: setup }
})

/** 「我已記下」: the temp password is gone for good (backups never keep it either). */
route('POST', '/api/me/temp-password/ack', (ctx) => {
  const me = member(ctx)
  ctx.con.tx(() => {
    if (ctx.con.run('UPDATE people SET temp_password=NULL, temp_password_pending=0 WHERE id=? AND temp_password IS NOT NULL', me.id).changes) {
      audit(ctx.con, me.username, 'temp_password_ack', `people/${me.id}`)
    }
  })
  return {}
})

route('GET', '/api/me/usage', (ctx) => {
  const me = member(ctx)
  const mine = new Set(
    ctx.con.all('SELECT host, username FROM accounts WHERE person_id=? AND managed=1', me.id).map((r) => `${r.host}\u0000${r.username}`),
  )
  return usage(mine)
})

route('POST', '/api/me/keys', (ctx) => {
  const me = member(ctx)
  const { con } = ctx
  const { data } = model<{ pubkey: string }>(ctx.body(), { pubkey: 'str' })
  const [line, fp] = parsePubkey(data.pubkey)
  return con.tx(() => {
    const old = con.get('SELECT * FROM ssh_keys WHERE fingerprint=?', fp)
    if (old && !(old.person_id === me.id && old.state === 'revoked')) throw new Conflict('此 SSH 金鑰已登錄過')
    if (con.value<number>("SELECT COUNT(*) FROM ssh_keys WHERE person_id=? AND state='active'", me.id)! >= 10) {
      throw new ValueErr('最多 10 把有效的 SSH 金鑰')
    }
    if (old) con.run("UPDATE ssh_keys SET state='active', pubkey=?, added_at=? WHERE id=?", line, now(), old.id)
    const kid = old
      ? old.id
      : con.run('INSERT INTO ssh_keys(person_id, pubkey, fingerprint, added_at) VALUES (?,?,?,?)', me.id, line, fp, now()).lastInsertRowid
    audit(con, me.username, 'key_add', fp)
    const job = enqueueUsers(con, me.username, me.id, true)
    return { key: keyJson(con.get('SELECT * FROM ssh_keys WHERE id=?', kid)!), job_id: job }
  })
})

route('POST', '/api/me/keys/{key_id}/revoke', (ctx) => {
  const me = member(ctx)
  const { con } = ctx
  const keyId = pathInt(ctx.params.key_id)
  return con.tx(() => {
    const k = con.get("SELECT * FROM ssh_keys WHERE id=? AND person_id=? AND state='active'", keyId, me.id)
    if (!k) throw new HttpError(404, '找不到該 SSH 金鑰')
    con.run("UPDATE ssh_keys SET state='revoked' WHERE id=?", keyId)
    audit(con, me.username, 'key_revoke', k.fingerprint)
    return { job_id: enqueueUsers(con, me.username, me.id, true) }
  })
})

// --- personal notifications (opt-in) ---------------------------------------------------------

function notifyJson(con: DB, p: Row) {
  const v = con.get('SELECT email, expires_at FROM email_verifications WHERE person_id=?', p.id)
  return {
    events: Object.entries(nt.EVENTS).map(([key, label]) => ({ key, label })),
    discord: { available: nt.discordEnabled(), linked: Boolean(p.discord_id), name: p.discord_name ?? null },
    email: {
      available: nt.emailEnabled(), address: nt.emailOf(p), sso_address: p.email ?? null,
      pending: v && v.expires_at >= now() ? v.email : null,
    },
    prefs: nt.prefs(p),
  }
}

const freshPerson = (con: DB, pid: number) => con.get('SELECT * FROM people WHERE id=?', pid)!

route('GET', '/api/me/notifications', (ctx) => notifyJson(ctx.con, member(ctx)))

route('PUT', '/api/me/notifications', (ctx) => {
  const me = member(ctx)
  const { data } = model<{ discord: string[]; email: string[] }>(ctx.body(), { discord: 'str[]', email: 'str[]' })
  const chosen: Record<string, string[]> = { discord: data.discord, email: data.email }
  if (Object.values(chosen).some((v) => v.some((e) => !Object.hasOwn(nt.EVENTS, e)))) throw new ValueErr('未知的通知項目')
  const fresh = Object.fromEntries(Object.entries(chosen).map(([ch, v]) => [ch, Object.keys(nt.EVENTS).filter((e) => v.includes(e))]))
  ctx.con.tx(() => {
    ctx.con.run('UPDATE people SET notify_prefs=? WHERE id=?', pyJson(fresh), me.id)
    audit(ctx.con, me.username, 'notify_prefs', `people/${me.id}`, fresh)
  })
  return notifyJson(ctx.con, freshPerson(ctx.con, me.id))
})

route('POST', '/api/me/discord/unlink', (ctx) => {
  const me = member(ctx)
  ctx.con.tx(() => {
    ctx.con.run('UPDATE people SET discord_id=NULL, discord_name=NULL WHERE id=?', me.id)
    audit(ctx.con, me.username, 'discord_unlink', `people/${me.id}`)
  })
  return notifyJson(ctx.con, freshPerson(ctx.con, me.id))
})

/** The SSO address needs no check; another one gets a 6-digit code and only counts once verified. */
route('POST', '/api/me/email', (ctx) => {
  const me = member(ctx)
  const { con } = ctx
  const { data } = model<{ email: string }>(ctx.body(), { email: 'str' })
  if (!nt.emailEnabled()) throw new HttpError(404, '未設定 Email 通知')
  const email = data.email.trim()
  if (!nt.validEmail(email)) throw new ValueErr('Email 格式不正確')
  const lower = email.toLowerCase()
  con.tx(() => {
    if (lower === (me.email ?? '').toLowerCase() || lower === (me.notify_email ?? '').toLowerCase()) {
      con.run('DELETE FROM email_verifications WHERE person_id=?', me.id)
      if (lower === (me.email ?? '').toLowerCase() && me.notify_email) {
        con.run('UPDATE people SET notify_email=NULL WHERE id=?', me.id)
        audit(con, me.username, 'notify_email', `people/${me.id}`, { email, source: 'sso' })
      }
      return
    }
    const last = con.get('SELECT created_at FROM email_verifications WHERE person_id=?', me.id)
    if (last && parseIso(last.created_at).getTime() + nt.CODE_RESEND_SEC * 1000 > Date.now()) {
      throw new HttpError(429, '驗證碼剛寄出，請 1 分鐘後再試')
    }
    const code = nt.newCode()
    con.run(
      `INSERT OR REPLACE INTO email_verifications(person_id, email, code_hash, attempts, expires_at, created_at)
       VALUES (?,?,?,0,?,?)`,
      me.id, email, nt.codeHash(me.id, email, code), localIso(addMinutes(new Date(), nt.CODE_TTL_MIN)), now(),
    )
    const queued = nt.queue(con, 'email', 'verify', `verify:${me.id}:${newToken(8)}`, `[${config.siteName}] Email 驗證碼`,
      `你的驗證碼：${code}\n15 分鐘內有效。在 ${config.publicUrl}/me 輸入後，通知才會寄到這個地址。\n如果不是你本人操作，請忽略這封信。`,
      me.id, email)
    if (!queued) { // over the hourly limit: the mail would never be sent; roll back instead of showing a pending code
      throw new HttpError(429, `這一小時內寄給你的 Email 已達上限（${nt.RATE_PER_HOUR} 封），驗證碼無法寄出，請稍後再試`)
    }
    audit(con, me.username, 'notify_email_code', `people/${me.id}`, { email })
  })
  return notifyJson(con, freshPerson(con, me.id))
})

route('POST', '/api/me/email/verify', (ctx) => {
  const me = member(ctx)
  const { con } = ctx
  const { data } = model<{ code: string }>(ctx.body(), { code: 'str' })
  const v = con.get('SELECT * FROM email_verifications WHERE person_id=?', me.id)
  if (!v || v.expires_at < now()) throw new ValueErr('驗證碼已過期或不存在，請重新寄送')
  if (v.attempts >= nt.CODE_TRIES) throw new ValueErr('錯誤次數過多，請重新寄送驗證碼')
  const want = Buffer.from(v.code_hash)
  const got = Buffer.from(nt.codeHash(me.id, v.email, data.code.trim()))
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    con.run('UPDATE email_verifications SET attempts = attempts + 1 WHERE person_id=?', me.id) // counts even though we answer 400
    throw new ValueErr('驗證碼不正確')
  }
  con.tx(() => {
    con.run('UPDATE people SET notify_email=? WHERE id=?', v.email, me.id)
    con.run('DELETE FROM email_verifications WHERE person_id=?', me.id)
    audit(con, me.username, 'notify_email', `people/${me.id}`, { email: v.email, source: 'verified' })
  })
  return notifyJson(con, freshPerson(con, me.id))
})

// --- registration (登記) and host requests: needs only, an admin assigns the account and hosts (待指派) ---------

type Needs = { purpose: string; gpus: number; min_vram_gb: number | null; until: string }
const NEEDS = { purpose: 'str', gpus: 'int', min_vram_gb: opt('int'), until: 'str' } as const

/** 用途, GPU 張數, 每張最低顯存 GB (optional), 預計使用到 — shared by registrations and host requests. */
function needs(b: Needs): Needs {
  const purpose = b.purpose.trim()
  if (!purpose || Array.from(purpose).length > 2000) throw new ValueErr('請填寫用途（2000 字以內）')
  if (!(b.gpus >= 0 && b.gpus <= 64)) throw new ValueErr('GPU 張數需為 0–64')
  if (b.min_vram_gb !== null && !(b.min_vram_gb >= 1 && b.min_vram_gb <= 1024)) throw new ValueErr('每張最低顯存需為 1–1024 GB')
  const until = parseDate(b.until)
  if (until < localDate()) throw new ValueErr('預計使用期間不可早於今天')
  return { purpose, gpus: b.gpus, min_vram_gb: b.min_vram_gb, until }
}

function registration(ctx: Ctx) {
  const { data: b } = model<Needs & { name: string; username: string }>(ctx.body(), { name: 'str', username: 'str', ...NEEDS })
  const name = b.name.trim()
  const username = b.username.trim()
  if (!name || Array.from(name).length > 100) throw new ValueErr('請填寫姓名（100 字以內）')
  checkNewUsername(username)
  return { name, username, ...needs(b) }
}

const needsText = (r: { gpus: number; min_vram_gb: number | null; until: string; purpose: string }) =>
  `GPU ${r.gpus} 張${r.min_vram_gb ? `（每張 ≥ ${r.min_vram_gb} GB）` : ''}，到 ${r.until}\n用途：${Array.from(r.purpose).slice(0, 500).join('')}`

/** The identity's latest registration; only an SSO identity without a person may register. */
route('GET', '/api/register', (ctx) => {
  const me = identity(ctx)
  const { con, s } = ctx
  const r = con.get("SELECT * FROM requests WHERE sso_id=? AND kind='account' ORDER BY id DESC LIMIT 1", s.sso_id ?? null)
  return {
    registration: r ? requestJson(con, r) : null,
    can_register: Boolean(s.sso_id) && me === null && r?.status !== 'pending',
  }
})

route('POST', '/api/register', async (ctx) => {
  const me = identity(ctx)
  const { con, s } = ctx
  const ssoId = s.sso_id
  if (me || !ssoId) throw new HttpError(403, me ? '你已有實驗室帳號，不需登記' : '無法登記')
  const b = registration(ctx)
  const rid = con.tx(() => {
    if (con.get("SELECT 1 FROM requests WHERE sso_id=? AND kind='account' AND status='pending'", ssoId)) {
      throw new Conflict('你已經登記過，等待指派中；可以修改登記內容')
    }
    const id = con.run(
      `INSERT INTO requests(kind, sso_id, email, name, username, hosts_json, reason, gpus, min_vram_gb, expected_end, created_at, updated_at)
       VALUES ('account',?,?,?,?,'[]',?,?,?,?,?,?)`,
      ssoId, s.email || null, b.name, b.username, b.purpose, b.gpus, b.min_vram_gb, b.until, now(), now(),
    ).lastInsertRowid
    audit(con, `sso:${ssoId}`, 'register', b.username, { name: b.name, gpus: b.gpus, min_vram_gb: b.min_vram_gb, until: b.until })
    return id
  })
  await notify(`[帳號登記] ${b.name}（${ssoId}${s.email ? `，${s.email}` : ''}）希望帳號 ${b.username}，${needsText(b)}\n` +
    `${config.publicUrl}/admin/requests`)
  return requestJson(con, con.get('SELECT * FROM requests WHERE id=?', rid)!)
})

/** Edit the pending registration (not yet assigned). */
route('PUT', '/api/register', (ctx) => {
  const me = identity(ctx)
  const { con, s } = ctx
  const ssoId = s.sso_id
  if (me || !ssoId) throw new HttpError(403, me ? '你已有實驗室帳號，不需登記' : '無法登記')
  const b = registration(ctx)
  const r = con.tx(() => {
    const r = con.get("SELECT * FROM requests WHERE sso_id=? AND kind='account' AND status='pending'", ssoId)
    if (!r) throw new HttpError(404, '沒有等待中的登記（可能已被指派或退回）')
    con.run('UPDATE requests SET name=?, username=?, reason=?, gpus=?, min_vram_gb=?, expected_end=?, updated_at=? WHERE id=?',
      b.name, b.username, b.purpose, b.gpus, b.min_vram_gb, b.until, now(), r.id)
    audit(con, `sso:${ssoId}`, 'register_update', b.username, { request: r.id })
    return r
  })
  return requestJson(con, con.get('SELECT * FROM requests WHERE id=?', r.id)!)
})

route('GET', '/api/me/host-requests', (ctx) => {
  const me = member(ctx)
  const reqs = ctx.con.all("SELECT * FROM requests WHERE person_id=? AND kind='hosts' ORDER BY id DESC", me.id)
  return { requests: reqs.map((r) => requestJson(ctx.con, r)), can_request: reqs.every((r) => r.status !== 'pending') }
})

/** 申請使用其他主機: needs only; an admin picks the hosts on the 待指派 page. */
route('POST', '/api/me/host-requests', async (ctx) => {
  const me = member(ctx)
  const { con } = ctx
  const { data } = model<Needs>(ctx.body(), NEEDS)
  const b = needs(data)
  const rid = con.tx(() => {
    if (con.get("SELECT 1 FROM requests WHERE person_id=? AND kind='hosts' AND status='pending'", me.id)) {
      throw new Conflict('你已有等待指派的主機申請')
    }
    const id = con.run(
      `INSERT INTO requests(kind, person_id, sso_id, email, username, hosts_json, reason, gpus, min_vram_gb, expected_end, created_at, updated_at)
       VALUES ('hosts',?,?,?,?,'[]',?,?,?,?,?,?)`,
      me.id, me.sso_id || '', me.email, me.username, b.purpose, b.gpus, b.min_vram_gb, b.until, now(), now(),
    ).lastInsertRowid
    audit(con, me.username, 'host_request', me.username, { gpus: b.gpus, min_vram_gb: b.min_vram_gb, until: b.until })
    return id
  })
  await notify(`[主機使用申請] ${me.username} ${needsText(b)}\n${config.publicUrl}/admin/requests`)
  return requestJson(con, con.get('SELECT * FROM requests WHERE id=?', rid)!)
})
