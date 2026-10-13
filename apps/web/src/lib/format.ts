const DASH = '—'

const IEC = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']

export function fmtBytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  let v = Math.abs(n)
  let i = 0
  while (v >= 1024 && i < IEC.length - 1) {
    v /= 1024
    i++
  }
  const s = i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : digits)
  return `${n < 0 ? '-' : ''}${s} ${IEC[i]}`
}

/** Compact axis label: 1.5e8 → "143M". */
export function fmtBytesShort(n: number): string {
  const units = ['', 'K', 'M', 'G', 'T', 'P']
  let v = Math.abs(n)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`
}

/** Bytes per second (assumed unit of the API's *_bps fields). */
export function fmtRate(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  return `${fmtBytes(n)}/s`
}

export function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  return `${n.toFixed(digits)}%`
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  return n.toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: digits })
}

/** CPU cores in use: 12.34 → "12.3 核". */
export function fmtCores(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  return `${fmtNum(n, 1)} 核`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local "YYYY-MM-DD HH:mm". */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return DASH
  return iso.length === 10 ? iso : fmtDateTime(iso).slice(0, 10)
}

const rtf = new Intl.RelativeTimeFormat('zh-TW', { numeric: 'auto' })

export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return DASH
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const s = Math.round((t - now) / 1000)
  const a = Math.abs(s)
  if (a < 45) return '剛剛'
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour')
  if (a < 86400 * 45) return rtf.format(Math.round(s / 86400), 'day')
  return fmtDate(iso)
}

/** Days from today until an ISO date (negative = past). */
export function daysUntil(date: string | null | undefined): number | null {
  if (!date) return null
  const t = new Date(date.length === 10 ? `${date}T23:59:59` : date).getTime()
  if (Number.isNaN(t)) return null
  return Math.floor((t - Date.now()) / 86400000)
}

/** datetime-local input value → ISO 8601 with the browser's offset. */
export function localInputToIso(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const oh = pad(Math.floor(Math.abs(off) / 60))
  const om = pad(Math.abs(off) % 60)
  return `${v.length === 16 ? `${v}:00` : v}${sign}${oh}:${om}`
}

/** "YYYY-MM" of the month before `d`. */
export function lastMonth(d = new Date()): string {
  const m = new Date(d.getFullYear(), d.getMonth() - 1, 1)
  return `${m.getFullYear()}-${pad(m.getMonth() + 1)}`
}

/** Clock label for chart axes depending on the time span. */
export function fmtAxisTime(epochSec: number, spanSec: number): string {
  const d = new Date(epochSec * 1000)
  if (spanSec <= 86400) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}
