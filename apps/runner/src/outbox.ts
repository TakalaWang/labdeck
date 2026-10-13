import { randomBytes } from 'node:crypto'
import nodemailer from 'nodemailer'
import { type DB, config, cut, io, now, localIso, addMinutes, notifications as nt } from '@labdeck/core'

// Delivery of personal notifications (outbox rows queued by web and schedule). Runs in the runner on its own
// connection and timer: a 2 h job never delays them, a slow SMTP server never a job.

export class HTTPStatusError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.name = 'HTTPStatusError'
    this.status = status
  }
}

type Transport = { sendMail: (msg: Record<string, unknown>) => Promise<unknown>; close: () => void }

/** SMTP: 587 + STARTTLS (required), 465 implicit TLS, or plain only for a local relay / tests (never with a login). */
function smtpOptions() {
  const sec = config.smtpSecurity
  return {
    host: config.smtpHost,
    port: config.smtpPort,
    secure: sec === 'ssl',
    requireTLS: sec === 'starttls',
    ignoreTLS: sec === 'none',
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
    tls: { rejectUnauthorized: true },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 20_000,
    logger: false,
    debug: false,
  }
}

export const outboxIo = {
  createTransport: (opts: ReturnType<typeof smtpOptions>): Transport => nodemailer.createTransport(opts) as unknown as Transport,
}

/** A mention in the lab channel: only this user may be pinged (never @everyone/@here/roles). */
async function sendDiscord(discordId: string, subject: string, body: string): Promise<void> {
  const r = await io.fetch(config.discordWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'labdeck' },
    body: JSON.stringify({ content: cut(`<@${discordId}> **${subject}**\n${body}`, 1900), allowed_mentions: { parse: [], users: [discordId] } }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!r.ok) throw new HTTPStatusError(r.status)
}

async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  const transport = outboxIo.createTransport(smtpOptions())
  try {
    const domain = config.smtpFrom.split('@').pop() || 'localhost'
    await transport.sendMail({
      from: config.smtpFrom, to, subject, text: body, date: new Date(),
      messageId: `<${Date.now()}.${randomBytes(8).toString('hex')}@${domain}>`,
    })
  } finally {
    transport.close()
  }
}

/** Error type and code only: never credentials or the webhook URL. */
export function errorLabel(e: unknown): string {
  if (e instanceof HTTPStatusError) return `HTTPStatusError ${e.status}`
  const x = e as { code?: string; responseCode?: number; name?: string }
  const name = x?.code === 'EAUTH' ? 'SMTPAuthenticationError' : x?.code ?? x?.name ?? 'Error'
  return `${name} ${x?.responseCode ?? ''}`.trim()
}

/** Deliver queued rows that are due. A failure is retried after 5, 10 min; the third one marks it failed. */
export async function sendDue(con: DB, limit = 20): Promise<void> {
  const rows = con.all("SELECT * FROM outbox WHERE status='queued' AND next_at <= ? ORDER BY id LIMIT ?", now(), limit)
  for (const r of rows) {
    let status = 'sent'
    let error: string | null = null
    const attempts = (r.attempts as number) + 1
    let nextAt = r.next_at as string
    const to = nt.recipient(con, r)
    try {
      if (!to || !nt.enabled(r.channel)) {
        status = 'skipped'
        error = 'not linked, not verified or opted out'
      } else if (r.channel === 'discord') await sendDiscord(to, r.subject, r.body)
      else await sendEmail(to, r.subject, r.body)
    } catch (e) {
      error = errorLabel(e)
      console.warn(`notification #${r.id} (${r.channel}) failed: ${error}`)
      status = attempts >= nt.MAX_ATTEMPTS ? 'failed' : 'queued'
      nextAt = localIso(addMinutes(new Date(), 5 * attempts))
    }
    con.tx(() => con.run(
      `UPDATE outbox SET status=?, error=?, attempts=?, next_at=?, sent_at=?,
         body = CASE WHEN event = 'verify' AND ? != 'queued' THEN '' ELSE body END WHERE id=?`,
      status, error, attempts, nextAt, status === 'sent' ? now() : null, status, r.id,
    ))
  }
}
