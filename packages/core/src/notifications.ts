import { createHash, randomInt } from 'node:crypto'
import { config } from './config.ts'
import type { DB, Row } from './db.ts'
import { addMinutes, localIso, now, parseIso } from './time.ts'
import { cut } from './util.ts'

// Personal notifications (opt-in): a Discord mention in the lab channel, or email over SMTP.
// Web requests and the runner's schedule only queue rows in `outbox` (a DB insert, never network I/O);
// the runner's sender delivers them. Dedupe: UNIQUE (channel, dedupe_key).

export const EVENTS: Record<string, string> = {
  expiry: '帳號即將到期（30／7／0 天前）',
  maintenance: '我有帳號的主機排定維護',
}
export const CHANNELS = ['discord', 'email'] as const
export type Channel = (typeof CHANNELS)[number]
export const RATE_PER_HOUR = 10 // per person (or address) and channel; more are stored as skipped
export const MAX_ATTEMPTS = 3
export const DISCORD_ID_RE = /^\d{15,21}$/
const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
export const CODE_TTL_MIN = 15
export const CODE_TRIES = 5
export const CODE_RESEND_SEC = 60

export const discordEnabled = () => Boolean(config.discordClientId && config.discordClientSecret && config.discordWebhookUrl)
export const emailEnabled = () => Boolean(config.smtpHost && config.smtpFrom)
export const enabled = (channel: string) => (channel === 'discord' ? discordEnabled() : emailEnabled())

export function prefs(p: Row): Record<Channel, string[]> {
  const raw = JSON.parse(p.notify_prefs || '{}') as Record<string, string[]>
  return Object.fromEntries(CHANNELS.map((ch) => [ch, Object.keys(EVENTS).filter((e) => (raw[ch] ?? []).includes(e))])) as Record<Channel, string[]>
}

export const emailOf = (p: Row): string | null => p.notify_email || p.email || null

/** Where this person receives `channel` right now (null = not linked / no address). */
export const target = (p: Row, channel: string): string | null => (channel === 'discord' ? p.discord_id : emailOf(p))

export function codeHash(pid: number, email: string, code: string): string {
  return createHash('sha256').update(`${pid}:${email.toLowerCase()}:${code}`).digest('hex')
}

export function validEmail(s: unknown): s is string {
  return typeof s === 'string' && Array.from(s).length <= 254 && EMAIL_RE.test(s)
}

export function newCode(): string {
  return String(randomInt(1_000_000)).padStart(6, '0')
}

// --- queueing (web + runner; inside the caller's transaction) -------------------------------

/** One outbox row; a dedupe_key already queued is ignored. Over the hourly limit → stored as skipped and false returned. */
export function queue(
  con: DB, channel: Channel, event: string, key: string, subject: string, body: string,
  personId: number | null = null, toAddr: string | null = null,
): boolean {
  const since = localIso(addMinutes(new Date(), -60))
  const recent = con.value<number>(
    `SELECT COUNT(*) FROM outbox WHERE channel=? AND status != 'skipped' AND created_at >= ?
     AND (person_id = ? OR (person_id IS NULL AND to_addr = ?))`,
    channel, since, personId, toAddr,
  )!
  const over = recent >= RATE_PER_HOUR
  con.run(
    `INSERT OR IGNORE INTO outbox(person_id, channel, event, dedupe_key, to_addr, subject, body, status,
                                  next_at, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    personId, channel, event, key, toAddr, cut(subject.replaceAll('\r', ' ').replaceAll('\n', ' '), 200), cut(body, 4000),
    over ? 'skipped' : 'queued', now(), over ? 'rate limited' : null, now(),
  )
  return !over
}

/** Queue `event` for each person who opted in on a channel that is configured and linked. */
function fanOut(con: DB, people: Row[], event: string, key: string, subject: string, bodyOf: (p: Row) => string): void {
  for (const p of people) {
    const pr = prefs(p)
    for (const ch of CHANNELS) {
      if (pr[ch].includes(event) && enabled(ch) && target(p, ch)) queue(con, ch, event, `${key}:${p.id}`, subject, bodyOf(p), p.id)
    }
  }
}

/** A registration or host request turned down (退回) → the requester's SSO email, with the admin's reason if any. */
export function requestRejected(con: DB, r: Row, reason: string | null = null): void {
  if (!emailEnabled() || !validEmail(r.email || '')) return
  const site = config.siteName
  const why = reason ? `\n原因：${reason}` : ''
  const [subject, body] = r.kind === 'hosts'
    ? [`[${site}] 主機使用申請已退回`, `你申請使用其他主機的申請已被退回。${why}\n可以修改需求後重新申請，如有疑問請聯絡助教。\n${config.publicUrl}/me`]
    : [`[${site}] 帳號登記已退回`, `你的實驗室帳號登記已被退回。${why}\n可以修改後重新送出，如有疑問請聯絡助教。\n${config.publicUrl}/request`]
  queue(con, 'email', 'request', `request:${r.id}:rejected`, subject, body, r.person_id, r.email)
}

export function expiry(con: DB, p: Row, days: number, threshold: number): void {
  const left = days > 0 ? `剩 ${days} 天` : '已到期'
  fanOut(con, [p], 'expiry', `expiry:${p.expires_at}:${threshold}`, `[${config.siteName}] 帳號到期提醒：${p.expires_at}（${left}）`, () =>
    `你的實驗室帳號 ${p.username} 可使用到 ${p.expires_at}（${left}）。需要延長請聯絡管理員。\n${config.publicUrl}/me`,
  )
}

const p2 = (n: number) => String(n).padStart(2, '0')
/** mm/dd HH:MM of a stored local time. */
export function fmtShort(t: string | null | undefined): string {
  if (!t) return ''
  const d = parseIso(t)
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** stage: created | reminder (24 h before) — to people with managed accounts on the maintenance hosts. */
export function announcement(con: DB, aid: number, stage: 'created' | 'reminder'): void {
  const a = con.get('SELECT * FROM announcements WHERE id=?', aid)!
  const affected: string[] = a.hosts ? String(a.hosts).split(',').sort() : []
  if (!affected.length) return
  const marks = affected.map(() => '?').join(',')
  const people = con.all(
    `SELECT DISTINCT p.* FROM people p JOIN accounts a ON a.person_id = p.id
     WHERE a.managed = 1 AND a.desired = 'present' AND p.status = 'active' AND a.host IN (${marks})`,
    ...affected,
  )
  const mine = new Map<number, string[]>()
  for (const r of con.all(
    `SELECT person_id, host FROM accounts WHERE managed = 1 AND desired = 'present' AND host IN (${marks}) ORDER BY host`,
    ...affected,
  )) {
    if (!mine.has(r.person_id)) mine.set(r.person_id, [])
    mine.get(r.person_id)!.push(r.host)
  }
  const label = { created: '維護公告', reminder: '明日提醒' }[stage]
  // the title is in the subject already (the Discord mention shows it in bold, the email as its subject)
  const body = (p: Row) =>
    [
      `你有帳號的受影響主機：${(mine.get(p.id) ?? []).join(', ')}`,
      `維護時間：${fmtShort(a.starts_at)}${a.ends_at ? ` – ${fmtShort(a.ends_at)}` : ''}`,
      cut(a.body, 800),
      `${config.publicUrl}/announcements`,
    ].join('\n')
  fanOut(con, people, 'maintenance', `announcement:${aid}:${stage}`, `[${config.siteName}] ${label}：${a.title}`, body)
}

/** Current address for an outbox row; null = no longer linked/verified, opted out, or the person is gone. */
export function recipient(con: DB, r: Row): string | null {
  if (r.to_addr) return r.to_addr
  const p = con.get('SELECT * FROM people WHERE id=?', r.person_id)
  if (!p || p.status !== 'active' || !prefs(p)[r.channel as Channel].includes(r.event)) return null
  return target(p, r.channel)
}
