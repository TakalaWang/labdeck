import { expect } from 'vitest'
import { handle, testHooks } from '../src/server/index.ts'

// In-process client for the API dispatcher with an injected session (the former TestClient + dependency override).

export const SESSION: Record<string, any> = {}
testHooks.session = SESSION

export const ORIGIN = 'https://portal.test'
export const HDRS: Record<string, string> = { Origin: ORIGIN, 'X-CSRF-Token': 'tok' }

export type Res = { status: number; headers: Headers; text: string; json: () => any }

export function login(pid: number): void {
  for (const k of Object.keys(SESSION)) delete SESSION[k]
  Object.assign(SESSION, { person_id: pid, csrf: 'tok' })
}

export function setSession(s: Record<string, unknown>): void {
  for (const k of Object.keys(SESSION)) delete SESSION[k]
  Object.assign(SESSION, s)
}

export async function call(method: string, url: string, body?: unknown, headers: Record<string, string | undefined> = HDRS): Promise<Res> {
  const init: RequestInit = { method, headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)) as Record<string, string> }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
  }
  const r = await handle(new Request(new URL(url, ORIGIN), init))
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer()) // keep the CSV's BOM
  return { status: r.status, headers: r.headers, text, json: () => JSON.parse(text) }
}

export const get = (url: string) => call('GET', url, undefined, {})
export const post = (url: string, body?: unknown) => call('POST', url, body)
export const put = (url: string, body?: unknown) => call('PUT', url, body)

export function ok(r: Res, status = 200): any {
  expect(r.status, r.text.slice(0, 300)).toBe(status)
  return r.json()
}

export function err(r: Res, status: number, match = ''): void {
  expect(r.status, r.text.slice(0, 300)).toBe(status)
  expect(r.json().error).toContain(match)
}
