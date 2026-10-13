import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  type DB, type Row, ValueErr, addDays, audit, config, coreDir, cut, daysBetween, isoOf, localDate, notify,
  notifications as nt, now, parseDate, parseDatetime, parseIso,
} from '@labdeck/core'
import { type Ctx, admin, identity, isMember, member, memberOf, route } from './app.ts'
import { HttpError, model, opt, optNotNull } from './http.ts'
import { ANN_SQL, annJson, knownHosts } from './views.ts'

// Announcements (maintenance windows), the new-member guide, the maintenance calendar and its iCal feed.

route('GET', '/api/admin/announcements', (ctx) => {
  admin(ctx)
  return ctx.con.all(`${ANN_SQL} ORDER BY a.id DESC`).map(annJson)
})

route('POST', '/api/admin/announcements', async (ctx) => {
  const me = admin(ctx)
  const { con } = ctx
  const body0 = ctx.body()
  // Scheduled shutdowns are gone (remote power control removed): never silently drop one an old client asked for.
  if (body0 && typeof body0 === 'object' && (body0 as Record<string, unknown>).shutdown != null) {
    throw new ValueErr('已不支援排程關機；公告只做通知與標示維護主機')
  }
  const { data: b } = model<Record<string, any>>(body0, {
    title: 'str', body: 'str', starts_at: opt('str'), ends_at: opt('str'),
    hosts: optNotNull('str[]', []), // maintenance window: affected hosts (optional)
  })
  const title = cut(b.title.trim(), 200)
  const body = cut(b.body.trim(), 5000)
  if (!title || !body) throw new ValueErr('請填寫標題與內容')
  const starts = b.starts_at ? parseDatetime(b.starts_at) : now()
  const ends = b.ends_at ? parseDatetime(b.ends_at) : null
  if (ends && ends < starts) throw new ValueErr('結束時間不可早於開始時間')
  const affected = b.hosts.length ? knownHosts(con, b.hosts) : []
  const aid = con.tx(() => {
    const id = con.run(
      `INSERT INTO announcements(title, body, starts_at, ends_at, hosts, created_by, created_at) VALUES (?,?,?,?,?,?,?)`,
      title, body, starts, ends, affected.join(',') || null, me.username, now(),
    ).lastInsertRowid
    audit(con, me.username, 'announce', `announcement/${id}`, { title, ...(affected.length ? { hosts: affected } : {}) })
    nt.announcement(con, id, 'created')
    return id
  })
  // the lab channel: when and where, then the text (the same window as the personal maintenance notifications)
  const when = `時間：${nt.fmtShort(starts)}${ends ? ` – ${nt.fmtShort(ends)}` : ' 起'}`
  const where = affected.length ? `\n影響主機：${affected.join('、')}` : ''
  await notify(`[公告] ${title}\n${when}${where}\n${cut(body, 1500)}`)
  return annJson(con.get(`${ANN_SQL} WHERE a.id=?`, aid)!)
})

// --- new-member guide ------------------------------------------------------------------

let defaultGuide: string | null = null
export function DEFAULT_GUIDE(): string {
  defaultGuide ??= readFileSync(path.join(coreDir(), 'guide.md'), 'utf8')
  return defaultGuide
}
export const GUIDE_MAX = 50_000
const PLACEHOLDER_RE = /\{\{\s*(site_name|oauth_name|public_url)\s*\}\}/g

const placeholders = () => ({ site_name: config.siteName, oauth_name: config.oauthName, public_url: config.publicUrl })

/** {{site_name}} etc. → the configured value: plain substitution of a fixed set, never a template engine. */
export function fillPlaceholders(text: string): string {
  const values = placeholders()
  return text.replace(PLACEHOLDER_RE, (_, k: keyof ReturnType<typeof placeholders>) => values[k])
}

function guideRow(con: DB): [string, Record<string, unknown>] {
  const r = con.get("SELECT * FROM pages WHERE key='guide'")
  return [r ? r.body : DEFAULT_GUIDE(), { updated_at: isoMaybe(r?.updated_at), updated_by: r ? r.updated_by : null, is_default: !r }]
}

const isoMaybe = (v: string | undefined) => (v ? isoOf(parseIso(v)) : null)

/** The members-only part (Wi-Fi, door codes…): its own row, so it can never leak through the public text. */
const membersGuide = (con: DB): string => con.get("SELECT body FROM pages WHERE key='guide_members'")?.body ?? ''

route('GET', '/api/guide', (ctx) => {
  const me = identity(ctx)
  const [body, meta] = guideRow(ctx.con)
  const members = isMember(me) ? membersGuide(ctx.con) : ''
  return { markdown: fillPlaceholders(body), members_markdown: fillPlaceholders(members) || null, ...meta }
})

function adminGuideJson(con: DB) {
  const [body, meta] = guideRow(con)
  return { source: body, default: DEFAULT_GUIDE(), placeholders: placeholders(), members_source: membersGuide(con), ...meta }
}

route('GET', '/api/admin/guide', (ctx) => {
  admin(ctx)
  return adminGuideJson(ctx.con)
})

const sha12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)
const tooLong = () => new ValueErr(`內容過長（最多 ${GUIDE_MAX.toLocaleString('en-US')} 字）`)

function savePage(con: DB, key: string, source: string, by: string) {
  con.run(`INSERT INTO pages(key, body, updated_by, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET body=excluded.body, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    key, source, by, now())
}

/** Saving the built-in text verbatim drops the stored copy, so later default updates reach the site. */
route('PUT', '/api/admin/guide', (ctx) => {
  const me = admin(ctx)
  const { data } = model<{ source: string }>(ctx.body(), { source: 'str' })
  const source = data.source.replaceAll('\r\n', '\n').trim()
  if (!source) throw new ValueErr('請填寫指南內容')
  if (Array.from(source).length > GUIDE_MAX) throw tooLong()
  const isDefault = source === DEFAULT_GUIDE().trim()
  ctx.con.tx(() => {
    if (isDefault) ctx.con.run("DELETE FROM pages WHERE key='guide'")
    else savePage(ctx.con, 'guide', source, me.username)
    audit(ctx.con, me.username, 'guide_update', 'page/guide', { chars: Array.from(source).length, sha256: sha12(source), default: isDefault })
  })
  return adminGuideJson(ctx.con)
})

/** Empty clears it. The audit records only size and hash: the text is meant to stay inside the lab. */
route('PUT', '/api/admin/guide/members', (ctx) => {
  const me = admin(ctx)
  const { data } = model<{ source: string }>(ctx.body(), { source: 'str' })
  const source = data.source.replaceAll('\r\n', '\n').trim()
  if (Array.from(source).length > GUIDE_MAX) throw tooLong()
  ctx.con.tx(() => {
    if (!source) ctx.con.run("DELETE FROM pages WHERE key='guide_members'")
    else savePage(ctx.con, 'guide_members', source, me.username)
    audit(ctx.con, me.username, 'guide_update', 'page/guide_members', { chars: Array.from(source).length, sha256: sha12(source) })
  })
  return adminGuideJson(ctx.con)
})

// --- maintenance calendar --------------------------------------------------------------

/** Per-person subscription token (calendar apps fetch without our cookie); changes with SESSION_SECRET. */
export function calendarToken(pid: number): string {
  return `${pid}.${createHmac('sha256', config.sessionSecret).update(`calendar:${pid}`).digest('hex').slice(0, 32)}`
}

/** The session's member, or the member a subscription token names (same active/expiry rule). */
function calendarMember(ctx: Ctx): Row {
  const token = ctx.url.searchParams.get('token') ?? ''
  if (!token) return memberOf(identity(ctx))
  const pid = token.split('.')[0]
  const p = /^\d+$/.test(pid) && pid.length < 10 ? ctx.con.get('SELECT * FROM people WHERE id=?', Number(pid)) : undefined
  const want = p ? Buffer.from(calendarToken(p.id)) : Buffer.alloc(0)
  const got = Buffer.from(token)
  if (!p || want.length !== got.length || !timingSafeEqual(want, got)) throw new HttpError(403, '訂閱連結無效')
  return memberOf(p)
}

/** [start, end] as Dates; without an end the announcement is the start moment only. */
function announcementSpan(a: Row): [Date, Date] {
  const start = parseIso(a.starts_at || a.created_at)
  return [start, a.ends_at ? parseIso(a.ends_at) : start]
}

route('GET', '/api/calendar', (ctx) => {
  const me = member(ctx)
  const start = ctx.url.searchParams.get('start') ?? ''
  const end = ctx.url.searchParams.get('end') ?? ''
  const first = start ? parseDate(start) : `${localDate().slice(0, 8)}01`
  const last = end ? parseDate(end) : addDays(`${addDays(first, 31).slice(0, 8)}01`, -1)
  const span = daysBetween(first, last)
  if (!(span >= 0 && span <= 92)) throw new ValueErr('日期範圍需在 0–92 天之間')
  const lo = parseIso(`${first}T00:00:00`).getTime()
  const hi = parseIso(`${last}T23:59:59`).getTime() + 999
  const events: [number, ReturnType<typeof annJson>][] = []
  for (const a of ctx.con.all(ANN_SQL)) {
    const [s0, e0] = announcementSpan(a)
    if (s0.getTime() <= hi && e0.getTime() >= lo) events.push([s0.getTime(), annJson(a)])
  }
  events.sort((x, y) => x[0] - y[0] || x[1].id - y[1].id)
  return {
    start: first, end: last, events: events.map(([, e]) => e),
    subscribe_url: `${config.publicUrl}/api/calendar.ics?token=${calendarToken(me.id)}`,
  }
})

/** RFC 5545 §3.3.11 TEXT: escape backslash, semicolon and comma, newlines as \n; drop other control characters. */
export function icsText(text: string): string {
  const t = text.replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  // eslint-disable-next-line no-control-regex -- control characters are exactly what RFC 5545 TEXT must not carry
  return t.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, (c) => (c === '\n' ? '\\n' : ''))
}

/** RFC 5545 §3.1: at most 75 octets per line, continued after CRLF + one space; never splits a UTF-8 character. */
export function icsFold(line: string): string {
  const parts: string[] = []
  let cur = ''
  let len = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch)
    if (len + n > (parts.length ? 74 : 75)) {
      parts.push(cur)
      cur = ''
      len = 0
    }
    cur += ch
    len += n
  }
  return [...parts, cur].join('\r\n ')
}

const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

/** Announcements (maintenance windows) from the last 180 days on. */
route('GET', '/api/calendar.ics', (ctx) => {
  calendarMember(ctx)
  const domain = new URL(config.publicUrl).hostname || 'portal'
  const stamp = icsTime(new Date())
  const since = Date.now() - 180 * 86_400_000
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//labdeck//maintenance calendar//ZH-TW', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(`${config.siteName} 維護日曆`)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H']
  for (const a of ctx.con.all(`${ANN_SQL} ORDER BY a.id`)) {
    const j = annJson(a)
    const [start, end] = announcementSpan(a)
    if (end.getTime() >= since) {
      const desc = a.body + (j.hosts.length ? `\n\n影響主機：${j.hosts.join('、')}` : '')
      lines.push('BEGIN:VEVENT', `UID:announcement-${a.id}@${domain}`, `DTSTAMP:${stamp}`, `DTSTART:${icsTime(start)}`,
        ...(end > start ? [`DTEND:${icsTime(end)}`] : []), `SUMMARY:${icsText((j.hosts.length ? '[維護] ' : '') + a.title)}`,
        `DESCRIPTION:${icsText(desc)}`, `URL:${config.publicUrl}/announcements?tab=calendar`, 'END:VEVENT')
    }
  }
  lines.push('END:VCALENDAR')
  return new Response(lines.map((l) => `${icsFold(l)}\r\n`).join(''), {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="calendar.ics"' },
  })
})

