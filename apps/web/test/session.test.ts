import { afterEach, beforeEach, expect, test } from 'vitest'
import { config } from '@labdeck/core'
import { fresh, person } from '../../../packages/core/test/helpers.ts'
import { handle, testHooks } from '../src/server/index.ts'
import { COOKIE, MAX_AGE, encodeSession } from '../src/server/session.ts'

// The cookie layer itself: real requests with a Cookie header through handle() (the other suites inject the session).

const ORIGIN = 'https://portal.test'
const FLAGS = 'Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax'
let secret = ''

beforeEach(() => {
  testHooks.session = null
  secret = config.sessionSecret
})
afterEach(() => {
  config.sessionSecret = secret
})

function req(method: string, url: string, cookie?: string, headers: Record<string, string> = {}): Promise<Response> {
  return handle(new Request(new URL(url, ORIGIN), { method, headers: { ...headers, ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}) } }))
}

const setCookie = (r: Response) => r.headers.get('set-cookie')
const cleared = (r: Response) =>
  expect(setCookie(r)).toBe(`${COOKIE}=null; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`)

/** The session a Set-Cookie carries (its signature is checked by the next request). */
const payload = (r: Response) => JSON.parse(Buffer.from(setCookie(r)!.split('=')[1].split('.')[0], 'base64url').toString())

test('a valid cookie logs in and is refreshed with the right flags', async () => {
  const con = fresh()
  const mem = person(con, 'mem')
  const r = await req('GET', '/api/hosts', encodeSession({ person_id: mem, csrf: 'tok' }))
  expect(r.status).toBe(200)
  expect(MAX_AGE).toBe(604800)
  expect(setCookie(r)).toMatch(new RegExp(`^${COOKIE}=[\\w-]+\\.\\d+\\.[\\w-]+; ${FLAGS}$`))
  expect(payload(r)).toEqual({ person_id: mem, csrf: 'tok' })
  expect(await req('GET', '/api/hosts')).toHaveProperty('status', 401) // and without it: anonymous
})

test('forged, expired and foreign-secret cookies are ignored and cleared', async () => {
  const con = fresh()
  const mem = person(con, 'mem')
  const admin = person(con, 'boss', { role: 'admin' })
  const good = encodeSession({ person_id: mem, csrf: 'tok' })
  const [data, ts, sig] = good.split('.')
  const flip = (s: string) => s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A')
  const now = Math.floor(Date.now() / 1000)
  const expired = encodeSession({ person_id: mem, csrf: 'tok' }, Date.now() - (MAX_AGE + 60) * 1000)
  const bad: Record<string, string> = {
    'tampered signature': `${data}.${ts}.${flip(sig)}`,
    'no signature': `${data}.${ts}`,
    'tampered payload': `${Buffer.from(JSON.stringify({ person_id: admin, csrf: 'tok' })).toString('base64url')}.${ts}.${sig}`,
    expired,
    'expired, timestamp moved forward': `${expired.split('.')[0]}.${now}.${expired.split('.')[2]}`,
    'tampered timestamp': `${data}.${Number(ts) + 3600}.${sig}`,
    'non-numeric timestamp': `${data}.x${ts}.${sig}`,
    garbage: 'not-a-session',
  }
  for (const [what, cookie] of Object.entries(bad)) {
    const r = await req('GET', '/api/hosts', cookie)
    expect([what, r.status]).toEqual([what, 401])
    cleared(r) // the bad cookie is deleted
    cleared(await req('GET', '/api/announcements', cookie)) // on a public endpoint too
  }
  config.sessionSecret = 'a-rotated-secret-of-at-least-32-characters'
  const r = await req('GET', '/api/hosts', good) // signed with the old secret
  expect(r.status).toBe(401)
  cleared(r)
  expect((await req('GET', '/api/hosts', encodeSession({ person_id: mem }))).status).toBe(200) // the new secret works
})

test('a forged cookie gets a fresh session, not the forged one', async () => {
  const con = fresh()
  const admin = person(con, 'boss', { role: 'admin' })
  const forged = `${Buffer.from(JSON.stringify({ person_id: admin, csrf: 'tok' })).toString('base64url')}.${Math.floor(Date.now() / 1000)}.x`
  const r = await req('GET', '/api/session', forged)
  const d = (await r.json()) as { user: unknown; csrf: string }
  expect(d.user).toBeNull()
  expect(d.csrf).not.toBe('tok')
  expect(payload(r)).toEqual({ csrf: d.csrf })
})

test('logout deletes the cookie', async () => {
  const con = fresh()
  const mem = person(con, 'mem')
  const cookie = encodeSession({ person_id: mem, csrf: 'tok' })
  const r = await req('POST', '/api/logout', cookie, { origin: ORIGIN, 'x-csrf-token': 'tok' })
  expect(r.status).toBe(200)
  cleared(r)
  expect((await req('POST', '/api/logout', cookie, { origin: ORIGIN, 'x-csrf-token': 'wrong' })).status).toBe(403) // CSRF from the cookie
})
