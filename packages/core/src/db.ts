import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { config } from './config.ts'
import { OverflowErr } from './util.ts'

// SQLite through node:sqlite (Node 24). One connection per process and DB file; statements are synchronous,
// so a transaction must never span an `await` (another request would run inside it).

export type Row = Record<string, any>
export type Param = string | number | bigint | boolean | null | undefined

const INT64_MAX = 2n ** 63n - 1n

/** Directory holding schema.sql and guide.md (packages/core). LABDECK_CORE_DIR overrides it in images. */
export function coreDir(): string {
  let here: string | undefined
  try {
    here = import.meta.dirname ? path.resolve(import.meta.dirname, '..') : undefined
  } catch {
    here = undefined // bundled (Next.js): no source location
  }
  const candidates = [
    process.env.LABDECK_CORE_DIR,
    here,
    path.resolve(process.cwd(), 'packages/core'),
    path.resolve(process.cwd(), '../../packages/core'),
  ]
  for (const c of candidates) {
    if (c && existsSync(path.join(c, 'schema.sql'))) return c
  }
  throw new Error('packages/core (schema.sql) not found; set LABDECK_CORE_DIR')
}

export function schemaSql(): string {
  return readFileSync(path.join(coreDir(), 'schema.sql'), 'utf8')
}

function bind(v: Param): SQLInputValue {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) {
    throw new OverflowErr('Python int too large to convert to SQLite INTEGER')
  }
  if (typeof v === 'bigint' && (v > INT64_MAX || v < -INT64_MAX - 1n)) {
    throw new OverflowErr('Python int too large to convert to SQLite INTEGER')
  }
  return v
}

/** A UNIQUE / CHECK / foreign key violation (the former sqlite3.IntegrityError). */
export function isConstraintError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'errcode' in e && ((e as { errcode: number }).errcode & 0xff) === 19
}

export class DB {
  readonly raw: DatabaseSync
  readonly path: string
  private cache = new Map<string, StatementSync>()

  constructor(file: string) {
    this.path = file
    this.raw = new DatabaseSync(file)
    this.raw.exec('PRAGMA busy_timeout=30000')
    this.raw.exec('PRAGMA foreign_keys=ON')
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.raw.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params.map(bind)) as T | undefined
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params.map(bind)) as T[]
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params.map(bind))
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
  }

  /** First column of the first row. */
  value<T = unknown>(sql: string, ...params: Param[]): T | undefined {
    const r = this.get(sql, ...params)
    return r ? (Object.values(r)[0] as T) : undefined
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  get inTransaction(): boolean {
    return this.raw.isTransaction
  }

  /**
   * Python's `with con:` — commit at the end, roll back on any error. Nested calls join the outer one.
   * IMMEDIATE by default: web and runner are separate processes, and a DEFERRED read-then-write in WAL mode fails
   * with SQLITE_BUSY_SNAPSHOT (busy_timeout doesn't help) when the other process committed in between.
   */
  tx<T>(fn: () => T, mode: 'DEFERRED' | 'IMMEDIATE' = 'IMMEDIATE'): T {
    if (this.raw.isTransaction) return fn()
    this.raw.exec(`BEGIN ${mode}`)
    try {
      const out = fn()
      if (out instanceof Promise) throw new Error('db.tx callback must be synchronous')
      if (this.raw.isTransaction) this.raw.exec('COMMIT')
      return out
    } catch (e) {
      if (this.raw.isTransaction) this.raw.exec('ROLLBACK')
      throw e
    }
  }

  close(): void {
    this.cache.clear()
    this.raw.close()
  }
}

let shared: DB | null = null

/** The process-wide connection to config.dbPath (reopened when the path changes, e.g. in tests). */
export function db(): DB {
  if (!shared || shared.path !== config.dbPath) {
    shared?.close()
    shared = new DB(config.dbPath)
  }
  return shared
}

/** A separate connection (the runner's notification sender, or a test simulating another process). */
export function openDb(): DB {
  return new DB(config.dbPath)
}

export function initDb(): void {
  for (const d of [path.dirname(config.dbPath), config.collectDir, config.backupDir]) {
    mkdirSync(d, { recursive: true })
  }
  mkdirSync(config.jobsDir, { recursive: true, mode: 0o700 })
  const con = new DB(config.dbPath)
  try {
    con.exec('PRAGMA journal_mode=WAL')
    const schema = schemaSql()
    migrate(con, schema)
    con.exec(schema) // new tables, and the indexes/triggers of rebuilt ones
  } finally {
    con.close()
  }
}

const SQL_LITERAL = String.raw`'(?:[^']|'')*'|"(?:[^"]|"")*"|\`[^\`]*\`|\[[^\]]*\]`

/** A table definition reduced to what SQLite acts on: comments dropped, whitespace collapsed (string literals kept). */
export function normalizeSql(sql: string): string {
  return sql
    .replace(new RegExp(String.raw`(${SQL_LITERAL})|--[^\n]*|/\*[\s\S]*?\*/|\s+`, 'g'), (_m, lit?: string) => lit ?? ' ')
    .replace(new RegExp(String.raw`(${SQL_LITERAL})| *([(),]) *`, 'g'), (_m, lit?: string, p?: string) => lit ?? p ?? '')
    .trim()
}

/** Tables whose column definitions differ from schema.sql; throws when a rebuild would drop a column. */
function rebuildPlan(con: DB, want: DatabaseSync): { name: string; body: string; cols: string[] }[] {
  const plan: { name: string; body: string; cols: string[] }[] = []
  const dropped: string[] = []
  const tables = want.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all() as { name: string; sql: string }[]
  for (const { name, sql } of tables) {
    const have = con.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", name)
    const body = sql.slice(sql.indexOf('(') + 1)
    if (!have || normalizeSql(have.sql.slice(have.sql.indexOf('(') + 1)) === normalizeSql(body)) continue
    const fresh = new Set((want.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((r) => r.name))
    const cols = con.all<{ name: string }>(`PRAGMA table_info(${name})`).map((r) => r.name)
    const gone = cols.filter((c) => !fresh.has(c))
    if (gone.length) dropped.push(`${name}(${gone.join(', ')})`)
    plan.push({ name, body, cols })
  }
  if (dropped.length) {
    throw new Error(`schema.sql would drop columns that hold data: ${dropped.join('; ')} — refusing to migrate; write a real migration`)
  }
  return plan
}

/** `VACUUM INTO <dir of the DB>/backup/pre-migrate-<timestamp>.db`, created 0600 before any data lands in it. */
function backupBeforeMigrate(con: DB): string {
  const dir = path.join(path.dirname(con.path), 'backup')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `pre-migrate-${new Date().toISOString().replace(/[-:]/g, '').replace('.', '-')}.db`)
  closeSync(openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)) // VACUUM INTO accepts an empty file
  con.raw.prepare('VACUUM INTO ?').run(file)
  return file
}

/**
 * Rebuild every existing table whose column definitions differ from schema.sql (comments and whitespace don't
 * count), copying all of its columns. Before any rebuild the DB is copied to backup/pre-migrate-*.db; a rebuild
 * that would drop a column refuses to start instead, and a foreign key violation rolls the whole migration back.
 *
 * ponytail: covers added columns and widened CHECKs (a DB from an older schema.sql); a change that needs
 * data conversion fails here and rolls back — write a real migration then.
 */
export function migrate(con: DB, schema: string): void {
  const want = new DatabaseSync(':memory:')
  try {
    want.exec(schema)
    if (!rebuildPlan(con, want).length) return
    const file = backupBeforeMigrate(con)
    console.warn(`backed up the DB to ${file} before migrating it`)
    con.exec('PRAGMA foreign_keys=OFF') // DROP TABLE of a referenced table; a no-op inside a transaction
    con.exec('BEGIN IMMEDIATE') // web, runner and cli may start at once
    try {
      for (const { name, body, cols } of rebuildPlan(con, want)) { // again: another process may have migrated meanwhile
        const list = cols.join(', ')
        con.exec(`CREATE TABLE ${name}_new (${body}`)
        con.exec(`INSERT INTO ${name}_new (${list}) SELECT ${list} FROM ${name}`)
        con.exec(`DROP TABLE ${name}`)
        con.exec(`ALTER TABLE ${name}_new RENAME TO ${name}`)
        console.warn(`migrated table ${name} to schema.sql`)
      }
      const bad = con.all<{ table: string; parent: string }>('PRAGMA foreign_key_check')
      if (bad.length) {
        const where = [...new Set(bad.map((r) => `${r.table} → ${r.parent}`))].join(', ')
        throw new Error(`migration left ${bad.length} foreign key violations (${where}); rolled back`)
      }
      con.exec('COMMIT')
    } catch (e) {
      con.exec('ROLLBACK')
      throw e
    } finally {
      con.exec('PRAGMA foreign_keys=ON')
    }
  } finally {
    want.close()
  }
}
