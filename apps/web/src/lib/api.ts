import type { Session } from '@/lib/types'

/** Error carrying the backend's user-facing `{error}` message (繁中) and HTTP status. */
export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const FALLBACK: Record<number, string> = {
  400: '輸入資料有誤',
  401: '請先登入',
  403: '權限不足',
  404: '找不到資料',
  409: '資料衝突',
  502: '監控資料暫時無法取得',
}

let csrfToken: string | null = null
let redirecting = false

export function loginHref(next?: string): string {
  const here = next ?? window.location.pathname + window.location.search
  return `/login?next=${encodeURIComponent(here)}`
}

function redirectToLogin() {
  if (redirecting) return
  redirecting = true
  window.location.assign(loginHref())
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (method !== 'GET') {
    if (!csrfToken) await getSession()
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'include',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('無法連線到伺服器，請稍後再試', 0)
  }

  if (res.status === 401) {
    redirectToLogin()
    throw new ApiError(FALLBACK[401], 401)
  }

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : (FALLBACK[res.status] ?? `伺服器錯誤（${res.status}）`)
    throw new ApiError(msg, res.status)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
}

/** GET /api/session (public). Also caches the CSRF token for later mutations. */
export async function getSession(): Promise<Session> {
  const s = await request<Session>('GET', '/api/session')
  csrfToken = s.csrf
  return s
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return '發生未預期的錯誤'
}

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}
