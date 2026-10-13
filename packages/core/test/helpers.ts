import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import { type DB, config, db, initDb, io, now } from '../src/index.ts'

// Test fixtures shared by the core, web and runner suites (ported from apps/api/test_portal.py).

export const TMP = process.env.TEST_TMP!

/** The fake inventory: hosts rows inserted by fresh(). gpu03 has no BMC and is excluded from batch shutdown. */
export const HOSTS: [string, string, string, string | null, number][] = [
  ['gpu01', '192.0.2.11', 'gpu', '198.51.100.11', 0],
  ['gpu02', '192.0.2.12', 'gpu', '198.51.100.12', 0],
  ['gpu03', '192.0.2.13', 'legacy', null, 1],
]

export const NOTIFIED: string[] = []
io.notify = (text: string) => {
  NOTIFIED.push(text)
}

/** Tests never reach the network unless a test installs a fake. */
export function offline(): void {
  io.fetch = async () => {
    throw new TypeError('fetch failed: tests never reach the network')
  }
}
offline()

let n = 0

export function fresh(): DB {
  n++
  config.dbPath = path.join(TMP, `t${n}.db`)
  initDb()
  NOTIFIED.length = 0
  for (const f of readdirSync(config.collectDir)) if (f.endsWith('.json')) rmSync(path.join(config.collectDir, f))
  const con = db()
  con.tx(() => {
    for (const h of HOSTS) {
      con.run(
        "INSERT INTO hosts(name, address, group_name, bmc_address, no_shutdown, created_at) VALUES (?,?,?,?,?,'2026-01-01T00:00:00')",
        ...h,
      )
    }
  })
  return con
}

export function person(
  con: DB,
  username: string,
  { role = 'member', status = 'active', uid = null, sso_id = null, expires_at = null }: {
    role?: string; status?: string; uid?: number | null; sso_id?: string | null; expires_at?: string | null
  } = {},
): number {
  return con.tx(
    () =>
      con.run(
        'INSERT INTO people(username, role, status, uid, sso_id, expires_at, created_at) VALUES (?,?,?,?,?,?,?)',
        username, role, status, uid, sso_id, expires_at, now(),
      ).lastInsertRowid,
  )
}

export function observe(con: DB, host: string, username: string, uid: number, locked = 0): void {
  con.tx(() =>
    con.run(
      'INSERT INTO accounts(host, username, uid, observed_locked, exists_on_host, seen_at) VALUES (?,?,?,?,1,1)',
      host, username, uid, locked,
    ),
  )
}

export function row(con: DB, sql: string, ...params: (string | number | null)[]): Record<string, any> | undefined {
  return con.get(sql, ...params)
}

/** First column of the first row. */
export function val(con: DB, sql: string, ...params: (string | number | null)[]): any {
  return con.value(sql, ...params)
}

export function keygen(name: string, ...args: string[]): string {
  const file = path.join(TMP, name)
  if (!existsSync(file)) execFileSync('ssh-keygen', ['-q', '-N', '', '-C', `${name}@test`, '-f', file, ...args])
  return readFileSync(`${file}.pub`, 'utf8').trim()
}

/** Expect fn to throw an Error whose message contains `match`. */
export function raises(fn: () => unknown, match = ''): void {
  let err: unknown
  try {
    fn()
  } catch (e) {
    err = e
  }
  expect(err, `${fn} did not raise`).toBeInstanceOf(Error)
  expect((err as Error).message).toContain(match)
}

export async function raisesAsync(fn: () => Promise<unknown>, match = ''): Promise<void> {
  let err: unknown
  try {
    await fn()
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(Error)
  expect((err as Error).message).toContain(match)
}

// --- fake Prometheus -----------------------------------------------------------------------

export type PromCall = { url: string; query: string; [k: string]: any }

/**
 * Fake Prometheus: a query gets the result of the first [substring, result] pair it contains, else [].
 * Returns the recorded calls; call the returned `restore` (or offline()) when done.
 */
export function prometheus(answers: [string, unknown][] = [], { down = false } = {}): PromCall[] {
  const calls: PromCall[] = []
  io.fetch = async (input: string) => {
    const u = new URL(input)
    const call: PromCall = { url: `${u.origin}${u.pathname}`, query: u.searchParams.get('query') ?? '' }
    for (const [k, v] of u.searchParams) if (k !== 'query') call[k] = Number(v)
    calls.push(call)
    if (down) throw new TypeError('fetch failed: down')
    const result = answers.find(([key]) => call.query.includes(key))?.[1] ?? []
    return Response.json({ status: 'success', data: { result } })
  }
  return calls
}

/** instant sample */
export function vec(v: number | string, labels: Record<string, string> = {}) {
  return { metric: labels, value: [1790000000, String(v)] }
}

/** range samples */
export function mat(points: [number, number | string][], labels: Record<string, string> = {}) {
  return { metric: labels, values: points.map(([t, v]) => [t, String(v)]) }
}

/** A range result on the grid the endpoint will ask for (start = now − secs); null = no sample there. */
export function onGrid(secs: number, step: number, values: (number | string | null)[], labels: Record<string, string> = {}) {
  const t0 = Math.floor(Date.now() / 1000) - secs
  return mat(
    values.flatMap((v, i) => (v === null ? [] : [[t0 + i * step, v] as [number, number | string]])),
    labels,
  )
}

/** Local datetime → ISO without offset, like Python datetime.isoformat(timespec="seconds"). */
export function localIsoOf(d: Date): string {
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function today(): string {
  return localIsoOf(new Date()).slice(0, 10)
}

export function addDaysIso(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return localIsoOf(d).slice(0, 10)
}
