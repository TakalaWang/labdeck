// Small helpers that keep the stored data and user-facing text identical to the former Python implementation
// (audit detail JSON, repr() in messages, round() / format() of floats).

/** A rule violation the API answers with 400 (the former ValueError). */
export class ValueErr extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValueError'
  }
}

/** A ValueErr the API answers with 409 instead of 400 (state conflict). */
export class Conflict extends ValueErr {
  constructor(message: string) {
    super(message)
    this.name = 'Conflict'
  }
}

/** An integer outside SQLite's range (the former OverflowError): 400 「數值超出範圍」. */
export class OverflowErr extends Error {
  constructor(message = 'integer too large') {
    super(message)
    this.name = 'OverflowError'
  }
}

/** Python's repr() of a str / None / number / list of those (used inside error messages). */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`
  if (typeof v !== 'string') return String(v)
  const q = v.includes("'") && !v.includes('"') ? '"' : "'"
  let out = ''
  for (const ch of v) {
    const c = ch.codePointAt(0)!
    if (ch === '\\') out += '\\\\'
    else if (ch === q) out += `\\${q}`
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return q + out + q
}

function jsonString(s: string, ensureAscii: boolean): string {
  let out = '"'
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\b') out += '\\b'
    else if (ch === '\f') out += '\\f'
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`
    else if (ensureAscii && c > 0x7e) {
      for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`
    } else out += ch
  }
  return `${out}"`
}

/** Python's json.dumps (default separators ", " / ": "); sortKeys sorts nested objects too. */
export function pyJson(v: unknown, { sortKeys = false, ensureAscii = true } = {}): string {
  const enc = (x: unknown): string => {
    if (x === null || x === undefined) return 'null'
    if (typeof x === 'boolean') return x ? 'true' : 'false'
    if (typeof x === 'number') return Number.isFinite(x) ? String(x) : x > 0 ? 'Infinity' : x < 0 ? '-Infinity' : 'NaN'
    if (typeof x === 'string') return jsonString(x, ensureAscii)
    if (Array.isArray(x)) return `[${x.map(enc).join(', ')}]`
    const entries = Object.entries(x as Record<string, unknown>).filter(([, val]) => val !== undefined)
    if (sortKeys) entries.sort(([a], [b]) => cmp(a, b))
    return `{${entries.map(([k, val]) => `${jsonString(k, ensureAscii)}: ${enc(val)}`).join(', ')}}`
  }
  return enc(v)
}

/** Code-point order, as Python compares str. */
export function cmp(a: string, b: string): number {
  if (a === b) return 0
  const x = Array.from(a)
  const y = Array.from(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!
    if (d) return d
  }
  return x.length - y.length
}

/** Compare tuples of (string | number | boolean | null) like Python's tuple ordering (None never compared). */
export function cmpTuple(a: readonly (string | number | boolean)[], b: readonly (string | number | boolean)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    const d = typeof x === 'string' && typeof y === 'string' ? cmp(x, y) : Number(x) - Number(y)
    if (d) return d < 0 ? -1 : 1
  }
  return a.length - b.length
}

/** Python sorted(xs, key=…) (stable). */
export function sortBy<T>(xs: Iterable<T>, key: (x: T) => readonly (string | number | boolean)[]): T[] {
  return [...xs].map((x) => [key(x), x] as const).sort((p, q) => cmpTuple(p[0], q[0])).map((p) => p[1])
}

/** Round half to even on the exact binary value, as Python's round(x, nd) and format(x, f".{nd}f"). */
export function pyFixed(x: number, nd: number): string {
  if (!Number.isFinite(x)) return String(x)
  const neg = x < 0 || Object.is(x, -0)
  const exact = Math.abs(x).toFixed(Math.min(100, nd + 60))
  const [intPart, frac = ''] = exact.split('.')
  const keep = frac.slice(0, nd)
  const rest = frac.slice(nd)
  let digits = (intPart + keep).split('').map(Number)
  const first = rest ? Number(rest[0]) : 0
  const tail = rest.slice(1).replace(/0+$/, '')
  const last = digits[digits.length - 1] ?? 0
  const up = first > 5 || (first === 5 && (tail.length > 0 || last % 2 === 1))
  if (up) {
    let i = digits.length - 1
    while (i >= 0) {
      if (digits[i] === 9) {
        digits[i] = 0
        i--
      } else {
        digits[i]++
        break
      }
    }
    if (i < 0) digits = [1, ...digits]
  }
  const s = digits.join('')
  const ip = s.slice(0, s.length - nd) || '0'
  const fp = s.slice(s.length - nd)
  const out = nd ? `${ip}.${fp}` : ip
  return neg && /[1-9]/.test(out) ? `-${out}` : out
}

export function pyRound(x: number, nd = 0): number {
  return Number(pyFixed(x, nd))
}

/** Python's banker's round() of a float to an int. */
export function roundHalfEven(x: number): number {
  return Number(pyFixed(x, 0))
}

/** Python str(float) for CSV cells: 1200.0, 412.5. */
export function pyFloatStr(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return `${x}.0`
  return String(x)
}

/** First n code points (Python s[:n]). */
export function cut(s: string, n: number): string {
  const cps = Array.from(s)
  return cps.length <= n ? s : cps.slice(0, n).join('')
}

/** Python str.isprintable(), approximately: no control or format characters. */
export function isPrintable(s: string): boolean {
  return !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Cn}]|[\p{Zs}--\x20]/v.test(s)
}

/** Deep equality of JSON values (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return pyJson(a, { sortKeys: true }) === pyJson(b, { sortKeys: true })
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
