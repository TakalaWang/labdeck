import { timingSafeEqual } from 'node:crypto'
import { SSO_ID_RE, audit, config, cut, io, isPrintable, notifications as nt } from '@labdeck/core'
import { type Ctx, identity, lookupIdentity, member, newToken, person, route } from './app.ts'
import { HttpError, redirect } from './http.ts'
import { userJson } from './views.ts'

// Login (OAuth 2.0 authorization code, generic; NYCU by default), session, logout, Discord linking.

/** Only site-relative paths are accepted as `next`. */
function local(url: string, fallback = '/'): string {
  return url.startsWith('/') && !url.startsWith('//') && !url.includes('\\') && isPrintable(url) ? url : fallback
}

function withQuery(base: string, params: Record<string, string>): string {
  return `${base}${base.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`
}

route('GET', '/login', (ctx) => {
  const { s, url } = ctx
  s.next = local(url.searchParams.get('next') ?? '/')
  const state = newToken(24)
  s.oauth_state = state
  return redirect(
    withQuery(config.oauthAuthorizeUrl, {
      response_type: 'code',
      client_id: config.oauthClientId,
      redirect_uri: `${config.publicUrl}/auth/callback`,
      scope: config.oauthScope,
      state,
    }),
  )
})

class OAuthError extends Error {}

/** Token (client_secret_post) and profile (Bearer) requests; any failure is an OAuthError, never logged in detail. */
async function oauthProfile(ctx: Ctx): Promise<Record<string, unknown>> {
  const q = ctx.url.searchParams
  const expected = ctx.s.oauth_state
  delete ctx.s.oauth_state
  if (q.get('error') || !q.get('code') || !expected || q.get('state') !== expected) throw new OAuthError('state or code')
  const tok = await io.fetch(config.oauthTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: q.get('code')!,
      redirect_uri: `${config.publicUrl}/auth/callback`,
      client_id: config.oauthClientId,
      client_secret: config.oauthClientSecret,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!tok.ok) throw new OAuthError(`token ${tok.status}`)
  const token = (await tok.json()) as { access_token?: unknown }
  if (typeof token?.access_token !== 'string') throw new OAuthError('no access_token')
  const r = await io.fetch(config.oauthProfileUrl, {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!r.ok) throw new OAuthError(`profile ${r.status}`)
  const profile = await r.json()
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new OAuthError('profile is not an object')
  return profile as Record<string, unknown>
}

route('GET', '/auth/callback', async (ctx) => {
  const { s, con } = ctx
  let profile: Record<string, unknown>
  try {
    profile = await oauthProfile(ctx)
  } catch (e) {
    console.warn(`OAuth login failed: ${e instanceof OAuthError ? 'OAuthError' : e instanceof Error ? e.name : 'Error'}`)
    return redirect('/?login_error=oauth') // a browser page: the SPA shows the message
  }
  const str = (v: unknown) => (v ? String(v) : '')
  const ssoId = str(profile[config.oauthIdField])
  const email = str(profile[config.oauthEmailField])
  if (!SSO_ID_RE.test(ssoId)) {
    console.warn('OAuth login refused: invalid identity')
    return redirect('/?login_error=identity')
  }
  const next = local(typeof s.next === 'string' ? s.next : '/')
  for (const k of Object.keys(s)) delete s[k]
  // The CSRF token is issued here, not lazily by /api/session: the SPA fires several /api/session calls at once
  // after login, and each would mint a different token while only the last cookie wins (first POST → 403).
  Object.assign(s, { sso_id: ssoId, email, csrf: newToken() })
  const p = lookupIdentity(con, ssoId)
  if (p) {
    s.person_id = p.id
    if (email && !p.email) con.tx(() => con.run('UPDATE people SET email=? WHERE id=?', email, p.id))
  }
  return redirect(next)
})

route('POST', '/api/logout', (ctx) => {
  identity(ctx)
  for (const k of Object.keys(ctx.s)) delete ctx.s[k]
  return {}
})

route('GET', '/api/session', (ctx) => {
  const { s } = ctx
  const p = person(ctx)
  s.csrf ??= newToken()
  return {
    site: { name: config.siteName, oauth_name: config.oauthName },
    csrf: s.csrf,
    user: p ? userJson(p) : null,
    identity: s.sso_id ? { sso_id: s.sso_id, email: s.email ?? null } : null,
  }
})

// --- Discord linking (personal notifications) ------------------------------------------------

const DISCORD_REDIRECT = '/auth/discord/callback'

function discordOn() {
  if (!nt.discordEnabled()) throw new HttpError(404, '未設定 Discord 通知')
}

/** OAuth2 authorization code (scope identify); the state is bound to this session and person. */
route('GET', '/auth/discord/start', (ctx) => {
  const me = member(ctx)
  discordOn()
  const state = newToken(24)
  ctx.s.discord_state = `${me.id}:${state}`
  return redirect(
    withQuery(config.discordAuthorizeUrl, {
      client_id: config.discordClientId, response_type: 'code', scope: 'identify',
      redirect_uri: config.publicUrl + DISCORD_REDIRECT, state, prompt: 'consent',
    }),
  )
})

route('GET', DISCORD_REDIRECT, async (ctx) => {
  const { s, con, url } = ctx
  const me = member(ctx)
  discordOn()
  const state = url.searchParams.get('state') ?? ''
  const code = url.searchParams.get('code') ?? ''
  const expected = String(s.discord_state ?? '')
  delete s.discord_state
  const want = Buffer.from(expected)
  const got = Buffer.from(`${me.id}:${state}`)
  if (!code || want.length !== got.length || !timingSafeEqual(want, got)) return redirect('/me?discord=error') // denied, replayed or forged
  let did: string
  let name: string
  try {
    const r = await io.fetch(config.discordTokenUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discordClientId, client_secret: config.discordClientSecret, grant_type: 'authorization_code',
        code, redirect_uri: config.publicUrl + DISCORD_REDIRECT,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) throw new Error(`HTTPStatusError ${r.status}`)
    const token = ((await r.json()) as { access_token: unknown }).access_token
    if (typeof token !== 'string') throw new Error('KeyError')
    const u = await io.fetch(config.discordProfileUrl, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
    if (!u.ok) throw new Error(`HTTPStatusError ${u.status}`)
    const user = (await u.json()) as Record<string, unknown>
    if (user?.id === undefined || user.id === null) throw new Error('KeyError')
    did = String(user.id)
    name = String(user.global_name || user.username || '')
  } catch (e) {
    console.warn(`Discord link failed: ${e instanceof Error ? e.message.split(' ')[0] : 'Error'}`)
    return redirect('/me?discord=error')
  }
  if (!nt.DISCORD_ID_RE.test(did)) return redirect('/me?discord=error')
  const shown = cut(Array.from(name).filter((c) => isPrintable(c)).join(''), 64) || null
  return con.tx(() => {
    if (con.get('SELECT 1 FROM people WHERE discord_id=? AND id != ?', did, me.id)) return redirect('/me?discord=taken')
    con.run('UPDATE people SET discord_id=?, discord_name=? WHERE id=?', did, shown, me.id)
    audit(con, me.username, 'discord_link', `people/${me.id}`, { discord_id: did })
    return redirect('/me?discord=linked')
  })
})
