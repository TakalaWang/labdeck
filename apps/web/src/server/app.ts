import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  Conflict, type DB, OverflowErr, PromError, type Row, ValueErr, config, db, initDb, isConstraintError, localDate,
} from '@labdeck/core'
import { HttpError, InvalidRequest, jsonResponse } from './http.ts'
import { COOKIE, type Session, decodeSession, readCookie, sessionCookie } from './session.ts'

// The JSON API of docs/api.md plus the browser-redirect auth routes, as one framework-free dispatcher over
// web-standard Request/Response. Next.js route handlers call handle(); tests call it directly.

export type Ctx = {
  req: Request
  url: URL
  params: Record<string, string>
  s: Session
  con: DB
  /** The parsed JSON body (undefined when empty); throws InvalidRequest when it isn't JSON. */
  body: () => unknown
}
type Handler = (ctx: Ctx) => unknown
type Route = { method: string; re: RegExp; keys: string[]; handler: Handler }

const routes: Route[] = []

/** Register a route; `{name}` matches one path segment (Starlette's default convertor). */
export function route(method: string, pattern: string, handler: Handler): void {
  const keys: string[] = []
  const re = new RegExp(
    `^${pattern.replace(/[.+*?^$()[\]|\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_, k: string) => {
      keys.push(k)
      return '([^/]+)'
    })}$`,
  )
  routes.push({ method, re, keys, handler })
}

/** Test seams (the former tests overrode FastAPI dependencies the same way). */
export const testHooks: {
  /** A session object used instead of the cookie, mutated in place. */
  session: Session | null
} = { session: null }

// --- identity and permissions (api.md 通則) -------------------------------------------------

/** The one place an external identity maps to a person (a future /login/ldap resolves here too). */
export function lookupIdentity(con: DB, ssoId: string): Row | undefined {
  return con.get('SELECT * FROM people WHERE sso_id=?', ssoId)
}

export function person(ctx: Ctx): Row | null {
  const { s, con } = ctx
  if (!('person_id' in s) && s.sso_id) {
    // approved or linked after this login
    const p = lookupIdentity(con, s.sso_id)
    if (p) s.person_id = p.id
  }
  const p = s.person_id ? con.get('SELECT * FROM people WHERE id=?', s.person_id) : undefined
  if (p && s.sso_id && p.sso_id !== s.sso_id) return null // admin re-linked this person to another SSO ID
  return p ?? null
}

export function identity(ctx: Ctx): Row | null {
  const p = person(ctx)
  if (p === null && !ctx.s.sso_id) throw new HttpError(401, '請先登入')
  return p
}

/** Active and not past expires_at (the account works through that day). */
export function isMember(p: Row | null | undefined): p is Row {
  return !!p && p.status === 'active' && (p.expires_at || '9999') >= localDate()
}

export function memberOf(p: Row | null): Row {
  if (!isMember(p)) throw new HttpError(403, '你的實驗室帳號尚未啟用、已停用或已到期')
  return p
}

export const member = (ctx: Ctx): Row => memberOf(identity(ctx))

export function admin(ctx: Ctx): Row {
  const p = member(ctx)
  if (p.role !== 'admin') throw new HttpError(403, '需要管理員權限')
  return p
}

/** scheme://host[:port] as browsers send it in Origin: lower case, default port dropped; null when not a URL. */
function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin
    return o === 'null' ? null : o
  } catch {
    return null
  }
}

/** Session token must match the header token, and the request must come from our own origin. */
export function csrfOk(expected: unknown, got: string | null, origin: string | null, referer: string | null, publicUrl = config.publicUrl): boolean {
  if (!expected || !got) return false
  const a = Buffer.from(String(expected))
  const b = Buffer.from(got)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false
  const ours = originOf(publicUrl)
  return !!ours && ours === originOf(origin || referer || '')
}

export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

// --- dispatch -------------------------------------------------------------------------------

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'cache-control': 'no-store',
}

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return jsonResponse({ error: e.message }, e.status)
  if (e instanceof InvalidRequest) return jsonResponse({ error: e.message }, 400)
  if (e instanceof ValueErr) return jsonResponse({ error: e.message }, e instanceof Conflict ? 409 : 400)
  if (e instanceof OverflowErr) return jsonResponse({ error: '數值超出範圍' }, 400) // e.g. ?page=10**17
  if (isConstraintError(e)) return jsonResponse({ error: '資料已被其他操作變更，請重新整理後再試' }, 409) // a race lost
  if (e instanceof PromError) return jsonResponse({ error: '監控資料暫時無法取得' }, 502)
  console.error('request failed:', e)
  return jsonResponse({ error: '伺服器發生錯誤，請稍後再試' }, 500)
}

let ready = false

export async function handle(req: Request): Promise<Response> {
  if (!ready) {
    initDb()
    ready = true
  }
  const url = new URL(req.url)
  // HEAD is not GET (FastAPI answered 405 too): a GET may consume one-time state (/api/me's temp_password, OAuth state)
  const method = req.method
  const hadCookie = readCookie(req.headers.get('cookie'), COOKIE) !== undefined
  const s: Session = testHooks.session ?? decodeSession(readCookie(req.headers.get('cookie'), COOKIE))
  let res: Response
  try {
    let match: { r: Route; m: RegExpExecArray } | null = null
    let wrongMethod = false
    for (const r of routes) {
      const m = r.re.exec(url.pathname)
      if (!m) continue
      if (r.method === method) {
        match = { r, m }
        break
      }
      wrongMethod = true
    }
    if (!match) throw new HttpError(wrongMethod ? 405 : 404, wrongMethod ? '不支援的請求方法' : '找不到')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        !csrfOk(s.csrf, req.headers.get('x-csrf-token'), req.headers.get('origin'), req.headers.get('referer'))) {
      throw new HttpError(403, 'CSRF 檢查失敗，請重新整理頁面後再試')
    }
    let params: Record<string, string>
    try {
      params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeURIComponent(match.m[i + 1])]))
    } catch {
      throw new HttpError(404, '找不到')
    }
    const text = method === 'GET' ? '' : await req.text()
    const ctx: Ctx = {
      req, url, params, s, con: db(),
      body: () => {
        if (!text) return undefined
        try {
          return JSON.parse(text)
        } catch {
          throw new InvalidRequest()
        }
      },
    }
    const out = await match.r.handler(ctx)
    res = out instanceof Response ? out : jsonResponse(out)
  } catch (e) {
    res = errorResponse(e)
  }
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v)
  if (!testHooks.session) {
    const cookie = sessionCookie(s, hadCookie)
    if (cookie) headers.append('set-cookie', cookie)
  }
  return new Response(req.method === 'HEAD' ? null : res.body, { status: res.status, headers })
}
