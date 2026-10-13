import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '@labdeck/core'

// The session lives in a signed cookie (as Starlette's SessionMiddleware did): portal_session, 7 days,
// HttpOnly, Secure, SameSite=Lax. The value is base64url(JSON).timestamp.HMAC-SHA256 — readable by the
// browser's owner, never forgeable; nothing secret is stored in it (sso_id, email, person_id, csrf, oauth state).

export type Session = Record<string, any>

export const COOKIE = 'portal_session'
export const MAX_AGE = 7 * 86400

function sign(data: string): string {
  return createHmac('sha256', config.sessionSecret).update(data).digest('base64url')
}

export function encodeSession(s: Session, now = Date.now()): string {
  const payload = `${Buffer.from(JSON.stringify(s)).toString('base64url')}.${Math.floor(now / 1000)}`
  return `${payload}.${sign(payload)}`
}

export function decodeSession(value: string | undefined, now = Date.now()): Session {
  if (!value) return {}
  const parts = value.split('.')
  if (parts.length !== 3) return {}
  const [data, ts, sig] = parts
  const want = Buffer.from(sign(`${data}.${ts}`))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return {}
  if (!/^\d+$/.test(ts) || Number(ts) + MAX_AGE < now / 1000) return {}
  try {
    const s = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {}
  } catch {
    return {}
  }
}

export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

/** Set-Cookie for the session after a request (Starlette: refresh while non-empty, delete once emptied). */
export function sessionCookie(s: Session, hadCookie: boolean): string | null {
  if (Object.keys(s).length) {
    return `${COOKIE}=${encodeSession(s)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
  }
  if (hadCookie) return `${COOKIE}=null; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`
  return null
}
