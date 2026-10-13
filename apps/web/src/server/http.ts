import { OverflowErr, ValueErr } from '@labdeck/core'

// Request parsing with the former FastAPI semantics: missing / mistyped fields → 400 「欄位缺少或格式錯誤」,
// integers beyond SQLite's range → 400 「數值超出範圍」.

/** An HTTP error with a user-facing message (the former HTTPException). */
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** Request validation failed (the former RequestValidationError). */
export class InvalidRequest extends Error {
  constructor(message = '欄位缺少或格式錯誤') {
    super(message)
    this.name = 'InvalidRequest'
  }
}

const INT64_MAX = 2n ** 63n - 1n

/** An integer as Python parses it: digits only (sign allowed), arbitrary size. */
export function parseBigInt(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v)
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!/^[+-]?\d+$/.test(s)) return null
  return BigInt(s)
}

/** A bigint as a SQLite parameter: number when safe, bigint within int64, else OverflowErr. */
export function sqlInt(v: bigint): number | bigint {
  if (v > INT64_MAX || v < -INT64_MAX - 1n) throw new OverflowErr()
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v
}

/** An int path parameter ({pid}, {jid}, …). */
export function pathInt(v: string): number | bigint {
  const n = parseBigInt(v)
  if (n === null) throw new InvalidRequest()
  return sqlInt(n)
}

/** An int query parameter with a default. */
export function queryInt(url: URL, name: string, fallback: number): bigint {
  const v = url.searchParams.get(name)
  if (v === null) return BigInt(fallback)
  const n = parseBigInt(v)
  if (n === null) throw new InvalidRequest()
  return n
}

export function queryStr(url: URL, name: string, fallback = ''): string {
  return url.searchParams.get(name) ?? fallback
}

export const clampBig = (v: bigint, lo: bigint, hi: bigint) => (v < lo ? lo : v > hi ? hi : v)

// --- body models (pydantic, lax mode) ------------------------------------------------------

type Scalar = 'str' | 'bool' | 'int'
type FieldType = Scalar | 'str[]' | { list: Spec } | { obj: Spec }
type Field = { type: FieldType; optional?: boolean; nullable?: boolean; default?: unknown }
export type Spec = Record<string, Field | FieldType>

const TRUE = new Set(['true', '1', 'yes', 'on', 't', 'y'])
const FALSE = new Set(['false', '0', 'no', 'off', 'f', 'n'])

function coerce(type: FieldType, v: unknown): unknown {
  if (type === 'str') {
    if (typeof v !== 'string') throw new InvalidRequest()
    return v
  }
  if (type === 'bool') {
    if (typeof v === 'boolean') return v
    if (v === 0 || v === 1) return v === 1
    if (typeof v === 'string' && TRUE.has(v.toLowerCase())) return true
    if (typeof v === 'string' && FALSE.has(v.toLowerCase())) return false
    throw new InvalidRequest()
  }
  if (type === 'int') {
    if (typeof v === 'number' && Number.isInteger(v)) return v
    const n = parseBigInt(v)
    if (n === null || typeof v === 'boolean') throw new InvalidRequest()
    return sqlInt(n)
  }
  if (type === 'str[]') {
    if (!Array.isArray(v)) throw new InvalidRequest()
    return v.map((x) => coerce('str', x))
  }
  if ('list' in type) {
    if (!Array.isArray(v)) throw new InvalidRequest()
    return v.map((x) => model(x, type.list).data)
  }
  return model(v, type.obj).data
}

/** Validate a JSON body against a spec; `set` holds the fields the client sent (pydantic model_fields_set). */
export function model<T = Record<string, any>>(body: unknown, spec: Spec): { data: T; set: Set<string> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InvalidRequest()
  const src = body as Record<string, unknown>
  const data: Record<string, unknown> = {}
  const set = new Set<string>()
  for (const [name, f] of Object.entries(spec)) {
    const field: Field = typeof f === 'string' || !('type' in f) ? { type: f as FieldType } : f
    if (!(name in src)) {
      if (!field.optional) throw new InvalidRequest()
      data[name] = field.default ?? null
      continue
    }
    set.add(name)
    const v = src[name]
    data[name] = v === null && field.nullable ? null : coerce(field.type, v)
  }
  return { data: data as T, set }
}

export const opt = (type: FieldType, def: unknown = null): Field => ({ type, optional: true, nullable: true, default: def })
export const optNotNull = (type: FieldType, def: unknown): Field => ({ type, optional: true, default: def })

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

export { ValueErr }
