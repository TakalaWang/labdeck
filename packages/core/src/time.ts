import { ValueErr, pyRepr } from './util.ts'

// Portal-generated times are stored as local ISO strings (YYYY-MM-DDTHH:MM:SS, the container's TZ);
// times observed on hosts are epoch seconds (schema.sql). Local = process TZ (compose sets TZ).

const p2 = (n: number) => String(n).padStart(2, '0')

export function localIso(d: Date): string {
  return `${String(d.getFullYear()).padStart(4, '0')}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

export function localDate(d: Date = new Date()): string {
  return localIso(d).slice(0, 10)
}

/** The stored form of "now". */
export function now(): string {
  return localIso(new Date())
}

function offset(d: Date): string {
  const m = -d.getTimezoneOffset()
  const sign = m < 0 ? '-' : '+'
  return `${sign}${p2(Math.floor(Math.abs(m) / 60))}:${p2(Math.abs(m) % 60)}`
}

/** A Date as ISO 8601 with the container's offset, to the second. */
export function isoOf(d: Date): string {
  return localIso(d) + offset(d)
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}:\d{2})?$/

function validYmd(y: number, m: number, d: number): boolean {
  if (y < 1 || m < 1 || m > 12 || d < 1) return false
  const days = new Date(Date.UTC(2000, m, 0)).getUTCDate() // month length in a leap year
  if (d > days) return false
  if (m === 2 && d === 29) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  return true
}

/** datetime.fromisoformat for the forms the portal stores and accepts; a naive time is local. Throws ValueErr. */
export function parseIso(s: string): Date {
  const m = ISO_RE.exec(s)
  if (!m) throw new ValueErr(`Invalid isoformat string: ${pyRepr(s)}`)
  const [y, mo, d, h = 0, mi = 0, sec = 0] = m.slice(1, 7).map((x) => (x === undefined ? 0 : Number(x)))
  if (!validYmd(y, mo, d) || h > 23 || mi > 59 || sec > 59) throw new ValueErr(`Invalid isoformat string: ${pyRepr(s)}`)
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0
  const tz = m[8]
  if (!tz) {
    const t = new Date(2000, 0, 1, h, mi, sec, ms)
    t.setFullYear(y, mo - 1, d)
    return t
  }
  const off = tz === 'Z' ? 0 : (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6)))
  const utc = Date.UTC(2000, 0, 1, h, mi, sec, ms)
  const t = new Date(utc)
  t.setUTCFullYear(y, mo - 1, d)
  return new Date(t.getTime() - off * 60_000)
}

/** Stored time (local ISO string or epoch seconds) → ISO 8601 with the container's offset; empty → null. */
export function iso(v: string | number | null | undefined): string | null {
  if (!v) return null
  const d = typeof v === 'number' ? new Date(Math.floor(v * 1000)) : parseIso(v)
  return isoOf(d)
}

export function parseDate(s: unknown): string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ValueErr(`日期格式錯誤：${pyRepr(s)}`)
  const [y, m, d] = s.split('-').map(Number)
  if (!validYmd(y, m, d)) throw new ValueErr(`日期格式錯誤：${pyRepr(s)}`)
  return s
}

/** ISO time → the stored local form; a given offset is converted to the container TZ, none means local. */
export function parseDatetime(s: unknown): string {
  if (
    typeof s !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?$/.test(s)
  ) {
    throw new ValueErr(`時間格式錯誤：${pyRepr(s)}`)
  }
  let t: Date
  try {
    t = parseIso(s)
  } catch {
    throw new ValueErr(`時間格式錯誤：${pyRepr(s)}`)
  }
  return localIso(t)
}

/** date + days, in local calendar days (YYYY-MM-DD in, YYYY-MM-DD out). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(2000, 0, 1))
  t.setUTCFullYear(y, m - 1, d + days)
  return t.toISOString().slice(0, 10).padStart(10, '0')
}

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    const t = new Date(Date.UTC(2000, 0, 1))
    t.setUTCFullYear(y, m - 1, d)
    return t.getTime()
  }
  return Math.round((ms(b) - ms(a)) / 86_400_000)
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000)
}

export function epoch(d: Date = new Date()): number {
  return d.getTime() / 1000
}
