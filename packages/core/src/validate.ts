import { execFileSync } from 'node:child_process'
import { config, PLAYBOOKS, validUsername } from './config.ts'
import type { DB } from './db.ts'
import { inventory } from './inventory.ts'
import { isIpAddress } from './net.ts'
import { parseDate } from './time.ts'
import { ValueErr, cmp, pyRepr } from './util.ts'

// Validators shared by web and runner (約定 C, F).

export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
export const GROUP_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
const DNS_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
export const RESERVED_GROUPS = new Set(['all', 'ungrouped', 'no_shutdown'])
const KEY_RE = '(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+'
/** New keys: a comment can't carry template code. */
const PUBKEY_RE = new RegExp(`^${KEY_RE}( [A-Za-z0-9@._+=:-]{0,100})?$`)
/** Keys stored before the comment rule may have spaces etc. in the comment; validateJob refuses braces anywhere. */
const STORED_KEY_RE = new RegExp(`^${KEY_RE}( [\\x20-\\x7e]{0,100})?$`)
export const KEY_TYPES: Record<string, string> = { 'ssh-ed25519': 'ED25519', 'ecdsa-sha2-nistp256': 'ECDSA', 'ssh-rsa': 'RSA' }

/** Return [key line, SHA256 fingerprint]; throw ValueErr for anything but one plain key. */
export function parsePubkey(text: string): [string, string] {
  const line = text.trim()
  if (!PUBKEY_RE.test(line)) {
    if (new RegExp(`^${KEY_RE} .*$`, 's').test(line) && !line.includes('\n')) {
      throw new ValueErr('SSH 金鑰的註解只能包含英數字與 @ . _ + = : -（不可有空白，最多 100 字），請修改註解後再貼上')
    }
    throw new ValueErr('SSH 公鑰格式不符：只接受單行 ssh-ed25519 / ecdsa-sha2-nistp256 / ssh-rsa，不可含 options')
  }
  let out = ''
  try {
    out = execFileSync('ssh-keygen', ['-lf', '-'], { input: `${line}\n`, encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'pipe', 'ignore'] })
  } catch {
    out = ''
  }
  const m = /^(\d+) (SHA256:[A-Za-z0-9+/]+) .*\((\w+)\)\s*$/.exec(out)
  if (!m || m[3] !== KEY_TYPES[line.split(' ')[0]]) throw new ValueErr('SSH 公鑰無法解析')
  if (m[3] === 'RSA' && Number(m[1]) < 3072) throw new ValueErr('RSA key 需至少 3072 bits')
  return [line, m[2]]
}

/** IPv4, IPv6 or DNS name (約定 C): nothing that could smuggle spaces, commas or options into ansible/ssh. */
export function validAddress(s: unknown): boolean {
  if (typeof s !== 'string' || !/^[A-Za-z0-9.:-]{1,253}$/.test(s)) return false
  if (isIpAddress(s)) return true
  // a numeric last label would be read as an IPv4 address by ssh
  return DNS_RE.test(s) && !/^\d+$/.test(s.slice(s.lastIndexOf('.') + 1))
}

export type HostFields = { name: string; address: string; group_name: string }

const field = (v: unknown) => (v ? String(v) : '').trim()

/** Normalized {name, address, group_name} of one host (約定 C), or ValueErr. */
export function validateHost(h: Record<string, unknown>): HostFields {
  const name = field(h.name)
  const address = field(h.address)
  const group = field(h.group_name)
  if (!HOST_RE.test(name) || RESERVED_GROUPS.has(name)) throw new ValueErr(`主機名稱不合法：${pyRepr(name)}`)
  if (!validAddress(address)) throw new ValueErr(`位址不合法：${pyRepr(address)}`)
  if (!GROUP_RE.test(group) || RESERVED_GROUPS.has(group)) {
    throw new ValueErr(`群組名稱不合法：${pyRepr(group)}（不可為 all、ungrouped、no_shutdown）`)
  }
  return { name, address, group_name: group }
}

/** Python str.splitlines(). */
function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** One CSV record (csv.reader on a single line): commas, "quoted" fields with "" escapes. */
function csvCells(line: string): string[] {
  if (line === '') return []
  const cells: string[] = []
  let cur = ''
  let quoted = false
  let start = true
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"' && start) {
      quoted = true
      start = false
    } else if (ch === ',') {
      cells.push(cur)
      cur = ''
      start = true
    } else {
      cur += ch
      start = false
    }
  }
  cells.push(cur)
  return cells
}

export type HostIn = HostFields & Record<string, unknown>

/** Pasted `name,address,group` lines (header optional) → [validated hosts, [{line, error}]]. */
export function parseHostsCsv(text: string): [HostIn[], { line: number; error: string }[]] {
  const hosts: HostIn[] = []
  const errors: { line: number; error: string }[] = []
  splitlines(text).forEach((raw, i) => {
    const n = i + 1
    const cells = csvCells(raw).map((c) => c.trim())
    if (!cells.some(Boolean) || (n === 1 && cells[0].toLowerCase() === 'name')) return
    try {
      if (cells.length !== 3) throw new ValueErr('需要 3 欄：name,address,group')
      const h: HostIn = validateHost({ name: cells[0], address: cells[1], group_name: cells[2] })
      if (hosts.some((x) => x.name === h.name)) throw new ValueErr(`主機名稱重複：${h.name}`)
      hosts.push(h)
    } catch (e) {
      if (!(e instanceof ValueErr)) throw e
      errors.push({ line: n, error: e.message })
    }
  })
  return [hosts, errors]
}

/** Every string in a JSON value, object keys included. */
export function* strings(v: unknown): Generator<string> {
  if (typeof v === 'string') yield v
  else if (Array.isArray(v)) for (const x of v) yield* strings(x)
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      yield k
      yield* strings(x)
    }
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Strict check of a job payload; used at enqueue time and again by the runner.
 * Exact key sets, so payloads carrying runner-injected fields (約定 F †) or anything unknown are rejected.
 */
export function validateJob(kind: string, args: unknown, con: DB): void {
  if (!(kind in PLAYBOOKS) || !isObj(args)) throw new ValueErr(`unknown job kind ${pyRepr(kind)}`)
  for (const s of strings(args)) {
    if (s.includes('{') || s.includes('}')) throw new ValueErr('job 參數不可含 { 或 }') // Jinja markers
  }
  const inv = inventory(con)
  const th = args.target_hosts
  const hosts = typeof th === 'string' ? th.split(',') : []
  if (!(kind === 'collect' && th === 'all')) {
    if (!hosts.length || new Set(hosts).size !== hosts.length || hosts.some((h) => !inv.has(h))) {
      throw new ValueErr(`target_hosts 不合法：${pyRepr(th)}`)
    }
  }
  const keys = (...expected: string[]) => {
    const want = new Set(['target_hosts', ...expected])
    const have = Object.keys(args)
    if (have.length !== want.size || have.some((k) => !want.has(k))) {
      throw new ValueErr(`${kind} job 欄位不符：${pyRepr([...have].sort(cmp))}`)
    }
  }
  if (kind === 'collect') {
    keys('collect_dir')
    if (args.collect_dir !== config.collectDir) throw new ValueErr('collect_dir 不符')
  } else if (kind === 'agents') {
    keys()
  } else {
    // users; temp_password / reserved_users / keys_only are added by the runner only, never stored
    keys('accounts', ...('only_user' in args ? ['only_user'] : []))
    const acc = args.accounts
    if (!isObj(acc) || Object.keys(acc).length !== new Set(hosts).size || hosts.some((h) => !(h in acc))) {
      throw new ValueErr('accounts 與 target_hosts 不符')
    }
    const entryKeys = ['username', 'uid', 'state', 'expires', 'keys_add', 'keys_remove']
    for (const entries of Object.values(acc)) {
      if (!Array.isArray(entries) || !entries.length) throw new ValueErr('accounts 內容不合法')
      for (const e of entries) {
        // remove_home (a boolean) exactly on accounts to delete
        const want = isObj(e) && e.state === 'absent' ? [...entryKeys, 'remove_home'] : entryKeys
        if (!isObj(e) || Object.keys(e).length !== want.length || want.some((k) => !(k in e))) {
          throw new ValueErr('account 欄位不符')
        }
        if (!validUsername(e.username) || !isInt(e.uid) || e.uid < 1000) {
          throw new ValueErr(`username/uid 不合法：${pyRepr(e.username)}`)
        }
        if (!['present', 'locked', 'absent'].includes(e.state as string)) throw new ValueErr('state 不合法')
        if (e.expires !== null) parseDate(e.expires)
        if (!Array.isArray(e.keys_add) || !Array.isArray(e.keys_remove)) throw new ValueErr('keys 不合法')
        if (e.state === 'absent' && (typeof e.remove_home !== 'boolean' || e.expires !== null || e.keys_add.length || e.keys_remove.length)) {
          throw new ValueErr('刪除帳號的欄位不合法')
        }
        for (const k of [...e.keys_add, ...e.keys_remove]) {
          if (typeof k !== 'string' || !STORED_KEY_RE.test(k)) throw new ValueErr('SSH key 不合法')
        }
      }
    }
    // only_user: an admin assignment's job, applied without a preview — exactly one account on one host
    if ('only_user' in args) {
      const mine = (acc[hosts[0]] as Record<string, unknown>[]) ?? []
      if (
        !validUsername(args.only_user) ||
        hosts.length !== 1 ||
        mine.length !== 1 ||
        mine[0].username !== args.only_user ||
        mine[0].state !== 'present'
      ) {
        throw new ValueErr('only_user 與 accounts 不符')
      }
    }
  }
}
