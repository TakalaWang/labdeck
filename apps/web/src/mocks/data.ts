// Dev-only fixture data shaped exactly like docs/api.md. Neutral names only
// (gpu01…, alice/bob/carol) and RFC 5737 documentation addresses.
import type {
  AccountRequest,
  AdminAccountRow,
  AdoptConflict,
  AdoptGroup,
  Announcement,
  AuditPage,
  DiskTrend,
  DiskUsage,
  FilesystemBoard,
  FleetHistory,
  Gpu,
  GpuBoard,
  GpuHistory,
  GpuMonthly,
  HealthBoard,
  HealthCheck,
  HealthKey,
  HealthStatus,
  Host,
  HostAccount,
  HostHistory,
  HostLoad,
  HostMetrics,
  JobDetail,
  MyAccount,
  Person,
  Range,
  SeriesMap,
  SshKey,
  UserLoad,
  UserLoadBoard,
  Values,
} from '@/lib/types'

// ---- deterministic noise ----------------------------------------------------

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967295
}
const noise = (key: string, t: number) => hash(`${key}:${Math.floor(t)}`)
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v))

const now = () => Date.now()
const iso = (ms: number) => {
  const d = new Date(ms)
  const off = -d.getTimezoneOffset()
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const local = new Date(ms + off * 60000).toISOString().slice(0, 19)
  return `${local}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`
}
const daysAgo = (d: number) => iso(now() - d * 86400000)
const dateIn = (d: number) => iso(now() + d * 86400000).slice(0, 10)

// ---- people / hosts ----------------------------------------------------------

export const USERS = ['alice', 'bob', 'carol'] as const

export const people: Person[] = [
  { id: 1, username: 'alice', name: 'Alice', email: 'alice@example.org', sso_id: 'alice01', role: 'admin', status: 'active', expires_at: dateIn(640), uid: 20001, created_at: daysAgo(400), hosts_count: 4, removed_at: null },
  { id: 2, username: 'bob', name: 'Bob', email: 'bob@example.org', sso_id: 'bob02', role: 'member', status: 'active', expires_at: dateIn(210), uid: 20002, created_at: daysAgo(300), hosts_count: 3, removed_at: null },
  { id: 3, username: 'carol', name: 'Carol', email: 'carol@example.org', sso_id: 'carol03', role: 'member', status: 'active', expires_at: dateIn(12), uid: 20003, created_at: daysAgo(90), hosts_count: 2, removed_at: null },
  // adopted from host accounts, no SSO ID yet: a registration can be linked to them
  { id: 6, username: 'dchen', name: null, email: null, sso_id: null, role: 'member', status: 'active', expires_at: null, uid: 1004, created_at: daysAgo(30), hosts_count: 2, removed_at: null },
  { id: 7, username: 'kevin', name: null, email: null, sso_id: null, role: 'member', status: 'active', expires_at: null, uid: null, created_at: daysAgo(30), hosts_count: 1, removed_at: null },
  // 移除成員: offboarded, kept for history (人員 → 已移除)
  { id: 8, username: 'oldgrad', name: 'Old Grad', email: 'oldgrad@example.org', sso_id: null, role: 'member', status: 'locked', expires_at: null, uid: 20008, created_at: daysAgo(900), hosts_count: 0, removed_at: daysAgo(20) },
]

type HostSpec = {
  model: string
  count: number
  memGiB: number
  up: boolean
  nvidiaOk: boolean
  monitored: boolean
  group: string
  smi?: number
  /** monitoring just installed: never collected, not scraped yet (status.up null, GPU/disk counts null) */
  fresh?: boolean
}

function specFor(i: number): HostSpec {
  switch (i) {
    case 1:
    case 2:
      return { model: 'NVIDIA GeForce RTX 3090', count: 8, memGiB: 24, up: true, nvidiaOk: true, monitored: true, group: 'gpu' }
    case 3:
      return { model: 'NVIDIA A100-SXM4-80GB', count: 4, memGiB: 80, up: true, nvidiaOk: false, monitored: true, group: 'gpu', smi: 3 }
    case 4:
      return { model: 'NVIDIA GeForce RTX 4090', count: 8, memGiB: 24, up: false, nvidiaOk: false, monitored: true, group: 'gpu' }
    case 5:
      return { model: '', count: 0, memGiB: 0, up: false, nvidiaOk: false, monitored: false, group: 'storage' }
    case 6: // CPU-only: never on the GPU board
      return { model: '', count: 0, memGiB: 0, up: false, nvidiaOk: false, monitored: true, group: 'cpu', fresh: true }
    case 7: // CPU-only and reporting (CPU / 記憶體 page)
      return { model: '', count: 0, memGiB: 0, up: true, nvidiaOk: false, monitored: true, group: 'cpu' }
    default: // VITE_MOCK_HOSTS > 7: a mixed fleet in three groups, one host offline
      return {
        model: i % 4 === 0 ? 'NVIDIA RTX A6000' : 'NVIDIA GeForce RTX 3090',
        count: i % 3 === 1 ? 4 : 8,
        memGiB: i % 4 === 0 ? 48 : 24,
        up: i !== 13,
        nvidiaOk: true,
        monitored: true,
        group: ['gpu2', 'gpu3', 'gpu4'][i % 3],
      }
  }
}

const hostCount = Math.max(1, Math.min(60, Number(process.env.NEXT_PUBLIC_MOCK_HOSTS) || 7))
const names = Array.from({ length: hostCount }, (_, i) => (i === 5 ? 'cpu01' : i === 6 ? 'cpu02' : `gpu${String(i + 1).padStart(2, '0')}`))
export const specs = new Map(names.map((n, i) => [n, specFor(i + 1)]))

const OS_MIX = ['Ubuntu 22.04.4 LTS', 'Ubuntu 22.04.5 LTS', 'Ubuntu 20.04.6 LTS', 'Ubuntu 24.04.1 LTS', 'Ubuntu 22.04.4 LTS']
const DRIVER_MIX = ['550.127.05', '550.127.05', '535.183.01', '525.147.05', '550.144.03', '580.82.07']

function baseHost(name: string, i: number): Host {
  const s = specs.get(name)!
  const hasGpu = s.count > 0
  const smi = s.smi ?? s.count
  const known = s.monitored && !s.fresh // collected at least once
  return {
    name,
    address: `192.0.2.${11 + i}`,
    group: s.group,
    ssh_no_retry: name === 'gpu04',
    monitored: s.monitored,
    room: 'R101',
    rack: `A${1 + (i % 4)}`,
    psu: i % 2 ? 'UPS-2' : 'UPS-1',
    notes: name === 'gpu03' ? '一張 A100 間歇性掉卡，已報修。' : null,
    facts_at: known ? daysAgo(0.3 + i * 0.1) : null,
    os: known ? OS_MIX[i % OS_MIX.length] : null,
    kernel: known ? '5.15.0-105-generic' : null,
    cpu_model: known ? (hasGpu ? 'AMD EPYC 7543 32-Core Processor' : 'Intel Xeon Silver 4314') : null,
    cpu_count: known ? 64 : null,
    mem_gb: known ? 251.5 : null,
    nvidia_driver: hasGpu ? DRIVER_MIX[i % DRIVER_MIX.length] : null,
    cuda: hasGpu ? '12.2' : null,
    gpu_summary: hasGpu ? `${smi}× ${s.model.replace(/^NVIDIA (GeForce )?/, '')}` : null,
    gpu_count: known ? smi : null, // api.md: null until the first collect
    gpu_pci_count: known ? s.count : null,
    disk_count: known ? 4 : null,
    status: null,
    primary_users: [], // filled per request from hostAccounts (mocks/index.ts)
  }
}

export const hosts: Host[] = names.map(baseHost)

export function hostWithStatus(h: Host, metricsDown: boolean): Host {
  const s = specs.get(h.name)
  if (!s || !h.monitored || metricsDown) return { ...h, status: null }
  const t = now() / 30000
  const none = { cpu_pct: null, mem_pct: null, root_pct: null, gpu_util_avg: null, net_rx_bps: null, net_tx_bps: null }
  if (s.fresh) return { ...h, status: { up: null, ...none } }
  if (!s.up) return { ...h, status: { up: false, ...none } }
  const k = h.name
  return {
    ...h,
    status: {
      up: true,
      cpu_pct: clamp(20 + 60 * noise(`${k}cpu`, t)),
      mem_pct: clamp(30 + 50 * noise(`${k}mem`, t / 4)),
      root_pct: k === 'gpu02' ? 93.4 : clamp(45 + 30 * hash(`${k}root`)),
      gpu_util_avg: s.count && s.nvidiaOk ? clamp(70 * noise(`${k}gpu`, t)) : null,
      net_rx_bps: 2e5 + 5e7 * noise(`${k}rx`, t),
      net_tx_bps: 1e5 + 1e7 * noise(`${k}tx`, t),
    },
  }
}

// ---- accounts ------------------------------------------------------------

/** `${host}/${username}` of the primary users (PUT …/primary changes it). */
export const primaryUsers = new Set(['gpu01/alice', 'gpu01/carol', 'gpu02/bob', 'gpu03/alice', 'gpu03/bob', 'gpu03/carol'])
const DISCORD_NAMES: Record<string, string> = { alice: 'alice.w', carol: 'carol_c' }

export function hostAccounts(name: string): HostAccount[] {
  const i = names.indexOf(name)
  const s = specs.get(name)
  if (!s?.monitored || s.fresh) return []
  const ref = (u: string) => {
    const p = people.find((x) => x.username === u)!
    return { id: p.id, username: p.username, name: p.name, discord_name: DISCORD_NAMES[u] ?? null }
  }
  const pri = (u: string) => primaryUsers.has(`${name}/${u}`)
  const retired = name === 'gpu04' // being retired: every account revoked and locked there, so it can be deleted
  const rows: Omit<HostAccount, 'reserved'>[] = [
    { username: 'alice', uid: 20001, exists: true, locked: retired, expires: dateIn(640), last_active: daysAgo(0.1 + i), managed: true, desired: retired ? 'locked' : 'present', primary: pri('alice'), person: ref('alice') },
    { username: 'bob', uid: name === 'gpu02' ? 1005 : 20002, exists: true, locked: retired, expires: dateIn(210), last_active: daysAgo(2 + i), managed: true, desired: retired ? 'locked' : 'present', primary: pri('bob'), person: ref('bob') },
  ]
  if (i < 2) rows.push({ username: 'carol', uid: 20003, exists: i === 0, locked: false, expires: dateIn(12), last_active: i === 0 ? daysAgo(1) : null, managed: true, desired: 'present', primary: pri('carol'), person: ref('carol') })
  if (name === 'gpu03') rows.push({ username: 'carol', uid: 20003, exists: true, locked: true, expires: dateIn(12), last_active: daysAgo(40), managed: true, desired: 'present', primary: pri('carol'), person: ref('carol') })
  if (name === 'gpu01') rows.push({ username: 'olduser', uid: 1001, exists: true, locked: false, expires: null, last_active: daysAgo(500), managed: false, desired: null, primary: false, person: null })
  if (name === 'gpu02') rows.push({ username: 'guest', uid: 1002, exists: true, locked: false, expires: null, last_active: daysAgo(30), managed: false, desired: null, primary: false, person: null })
  return rows.map((r) => ({ ...r, reserved: false }))
}

export function adminAccountRows(): AdminAccountRow[] {
  return hosts.flatMap((h) =>
    hostAccounts(h.name).map((a) => {
      const expected = a.person ? (people.find((p) => p.id === a.person!.id)?.uid ?? null) : null
      const drift: string[] = []
      if (a.managed && a.exists && expected !== null && a.uid !== expected) drift.push('uid 與認領時不同')
      if (a.managed && a.desired === 'present' && a.locked) drift.push('應開通但主機上為鎖定')
      if (a.managed && a.desired === 'present' && !a.exists) drift.push('尚未在主機上建立')
      return { ...a, host: h.name, expected_uid: expected, drift }
    }),
  )
}

export function myAccounts(username: string): MyAccount[] {
  return hosts.flatMap((h) =>
    hostAccounts(h.name)
      .filter((a) => a.username === username && a.managed)
      .map((a) => ({ host: h.name, username: a.username, uid: a.uid, exists: a.exists, locked: a.locked, expires: a.expires, last_active: a.last_active, desired: a.desired ?? 'present', primary: a.primary, address: hosts.find((x) => x.name === h.name)?.address ?? null, job_status: a.exists ? null : 'running' })),
  )
}

export const keys: SshKey[] = [
  { id: 1, fingerprint: 'SHA256:3kF1mZyq8pXb9R2vN0cWlJ7uE5dT4hK6sA1oQ8iY2gM', type: 'ED25519', comment: 'alice@laptop', state: 'active', added_at: daysAgo(120) },
  { id: 2, fingerprint: 'SHA256:Qm7bT2xV9nL4pR8sK1wD6fH3jC5gZ0aE2yU7iO9tB4c', type: 'RSA', comment: 'alice@old-desktop', state: 'revoked', added_at: daysAgo(380) },
]

// ---- GPU board --------------------------------------------------------------

export function gpuBoard(): GpuBoard {
  const t = now() / 15000
  return {
    updated_at: iso(now() - 4000),
    hosts: hosts
      .filter((h) => h.monitored && (specs.get(h.name)?.count ?? 0) > 0)
      .map((h) => {
        const s = specs.get(h.name)!
        const n = s.up && s.nvidiaOk ? (s.smi ?? s.count) : 0 // nvidia-smi failing → no GPU series at all
        const gpus: Gpu[] = Array.from({ length: n }, (_, idx) => {
          const k = `${h.name}-${idx}`
          const busy = hash(`${k}busy${Math.floor(t / 20)}`) > 0.35
          const owner = USERS[Math.floor(hash(`${k}owner`) * USERS.length)]
          const total = s.memGiB * 1024 ** 3
          const used = busy ? total * (0.35 + 0.6 * noise(`${k}m`, t / 8)) : 0.3 * 1024 ** 2 * 100 * hash(k)
          const util = busy ? clamp(40 + 60 * noise(`${k}u`, t)) : clamp(3 * hash(`${k}i`))
          const procs = busy
            ? [
                { user: owner, pid: 10000 + Math.floor(hash(`${k}pid`) * 50000), comm: 'python', mem_bytes: used * 0.92 },
                ...(hash(`${k}two`) > 0.8 ? [{ user: USERS[(USERS.indexOf(owner) + 1) % 3], pid: 20000 + idx, comm: 'python3', mem_bytes: used * 0.08 }] : []),
              ]
            : []
          return {
            index: idx,
            uuid: `GPU-${hash(k).toString(16).slice(2, 10)}-${idx}`,
            name: s.model,
            util_pct: util,
            mem_used_bytes: used,
            mem_total_bytes: total,
            temp_c: busy ? 62 + 20 * noise(`${k}t`, t) : 34 + 6 * hash(k),
            power_w: busy ? 220 + 130 * noise(`${k}p`, t) : 22 + 10 * hash(k),
            idle: util < 5 && used < 1024 ** 3,
            processes: procs,
          }
        })
        if (h.name === 'gpu02') {
          // a sick card: lab_gpu_info without name/index labels, every value N/A
          const last = gpus[gpus.length - 1]
          gpus[gpus.length - 1] = { ...last, index: null, name: '未知 GPU', util_pct: null, mem_used_bytes: null, mem_total_bytes: null, temp_c: null, power_w: null, idle: false, processes: [] }
        }
        return { host: h.name, group: h.group, up: s.up, nvidia_ok: s.nvidiaOk, gpus }
      }),
  }
}

// ---- per-user CPU / memory (labdeck-agent procs) ----------------------------------------

const GiB = 1024 ** 3

/** One host of /api/metrics/users: root and system rows, the lab users, GPU columns from the GPU board. */
export function hostLoad(name: string, board: GpuBoard = gpuBoard()): HostLoad {
  const h = hosts.find((x) => x.name === name)!
  const s = specs.get(name)!
  const none = { cpu_count: null, cpu_used_cores: null, mem_total_bytes: null, mem_used_bytes: null, users: [] }
  if (!h.monitored || s.fresh) return { host: name, group: h.group, up: null, ...none } // not scraped yet
  if (!s.up) return { host: name, group: h.group, up: false, ...none }
  const t = now() / 30000
  const cpus = s.count ? 64 : 32
  const total = (s.count ? 251.5 : 125.7) * GiB
  const gpu = new Map<string, { uuids: Set<string>; mem: number }>()
  for (const g of board.hosts.find((x) => x.host === name)?.gpus ?? [])
    for (const p of g.processes) {
      const e = gpu.get(p.user) ?? { uuids: new Set<string>(), mem: 0 }
      e.uuids.add(g.uuid)
      e.mem += p.mem_bytes
      gpu.set(p.user, e)
    }
  const row = (user: string, cores: number | null, mem: number | null, processes: number | null): UserLoad => ({
    user, cpu_cores: cores, mem_bytes: mem, processes, gpu_count: gpu.get(user)?.uuids.size ?? 0, gpu_mem_bytes: gpu.get(user)?.mem ?? 0,
  })
  const rows = [
    row('root', 0.3 + 0.4 * noise(`${name}root`, t), 3.4 * GiB, 214),
    row('system', 0.1 + 0.2 * noise(`${name}sys`, t), 1.2 * GiB, 57),
    ...USERS.filter((u) => gpu.has(u) || hash(`${name}${u}here`) > 0.25).map((u) => {
      let cores = Math.round(cpus * 0.3 * hash(`${name}${u}c`) * (0.7 + 0.6 * noise(`${name}${u}`, t)) * 100) / 100
      let mem = total * 0.22 * hash(`${name}${u}m`)
      if (name === 'gpu01' && u === 'bob') mem = 0.62 * total // heavy on RAM: highlighted
      if (name === 'cpu02' && u === 'carol') cores = 0.72 * cpus // heavy on CPU: highlighted
      return row(u, cores, mem, 3 + Math.floor(60 * hash(`${name}${u}p`)))
    }),
  ]
  if (name === 'gpu02') rows.push({ ...row('erin', null, null, null), gpu_count: 1, gpu_mem_bytes: 9.5 * GiB }) // GPU only: no procs row
  const share = (u: UserLoad) => Math.max((u.cpu_cores ?? 0) / cpus, (u.mem_bytes ?? 0) / total)
  rows.sort((a, b) => share(b) - share(a) || b.gpu_count - a.gpu_count || a.user.localeCompare(b.user))
  const used = rows.reduce((n, u) => n + (u.cpu_cores ?? 0), 0)
  const mem = rows.reduce((n, u) => n + (u.mem_bytes ?? 0), 0)
  return {
    host: name,
    group: h.group,
    up: true,
    cpu_count: cpus,
    cpu_used_cores: Math.min(cpus, used + 0.8),
    mem_total_bytes: total,
    mem_used_bytes: Math.min(total * 0.97, mem * 0.9 + 6 * GiB),
    users: rows,
  }
}

export function userLoad(): UserLoadBoard {
  const board = gpuBoard()
  return { updated_at: iso(now() - 6000), hosts: hosts.filter((h) => h.monitored).map((h) => hostLoad(h.name, board)) }
}

// ---- metrics time series ----------------------------------------------------

const STEP: Record<Range, number> = { '1h': 15, '6h': 60, '24h': 300, '7d': 1800, '30d': 7200 }
const SPAN: Record<Range, number> = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 }

export function hostMetrics(name: string, range: Range): HostMetrics {
  const step = STEP[range]
  const end = Math.floor(now() / 1000 / step) * step
  const ts: number[] = []
  for (let t = end - SPAN[range]; t <= end; t += step) ts.push(t)
  const wave = (key: string, base: number, amp: number, period = 43200) =>
    ts.map((t) => [t, clamp(base + amp * Math.sin((t / period) * 2 * Math.PI + hash(key) * 6) + 8 * (noise(key, t / step) - 0.5))] as [number, number])
  const s = specs.get(name)!
  if (s.fresh) return { range, step, cpu_pct: [], mem_pct: [], net_rx_bps: {}, net_tx_bps: {}, disk_pct: {}, gpu_util_pct: {}, gpu_mem_pct: {} }
  const gpu: SeriesMap = {}
  const gpuMem: SeriesMap = {}
  for (let i = 0; i < (s.smi ?? s.count); i++) {
    gpu[String(i)] = wave(`${name}g${i}`, 50, 45, 20000 + i * 3000)
    gpuMem[String(i)] = wave(`${name}gm${i}`, 55, 35, 30000 + i * 2000)
  }
  const bps = (key: string, base: number) => ts.map((t) => [t, base * (0.3 + noise(key, t / step) + 0.5 * Math.sin(t / 7200))] as [number, number])
  return {
    range,
    step,
    cpu_pct: wave(`${name}cpu`, 45, 30),
    mem_pct: wave(`${name}mem`, 55, 15, 86400),
    net_rx_bps: { eno1: bps(`${name}rx`, 3e7), ib0: bps(`${name}ib`, 8e7) },
    net_tx_bps: { eno1: bps(`${name}tx`, 6e6) },
    disk_pct: { '/': wave(`${name}d0`, 60, 2, 604800), '/home': wave(`${name}d1`, 72, 3, 604800), '/data0': wave(`${name}d2`, 81, 4, 604800) },
    gpu_util_pct: gpu,
    gpu_mem_pct: gpuMem,
  }
}

// ---- history charts (values on one grid, null = gap) -------------------------

function grid(span: number, step: number) {
  const end = Math.floor(now() / 1000)
  return { step, start: end - span, end, n: Math.floor(span / step) + 1 }
}
const r1 = (v: number) => Math.round(v * 10) / 10
/** Daily-ish wave in 0…100 around `base`; `gapAt` blanks a run of points (host offline, scrape missed). */
function waveValues(key: string, g: { step: number; start: number; n: number }, base: number, amp: number, gaps: [number, number][] = []): Values {
  return Array.from({ length: g.n }, (_, i) => {
    if (gaps.some(([a, b]) => i >= a && i < b)) return null
    const t = g.start + i * g.step
    return r1(clamp(base + amp * Math.sin((t / 43200) * 2 * Math.PI + hash(key) * 6) + 14 * (noise(key, t / g.step) - 0.5)))
  })
}
/** A host that is down now went offline 40 % of the way from the end. */
const downFrom = (name: string, n: number): [number, number][] => (specs.get(name)?.up ? [] : [[Math.floor(n * 0.6), n]])
const gpuHosts = () => hosts.filter((h) => h.monitored && (specs.get(h.name)?.count ?? 0) > 0 && specs.get(h.name)?.nvidiaOk)

export function fleetHistory(range: Range): FleetHistory {
  const g = grid(SPAN[range], STEP[range])
  const busy: Values = []
  const idle: Values = []
  for (let i = 0; i < g.n; i++) {
    if (i >= g.n - 4 && i < g.n - 2) {
      busy.push(null) // Prometheus restarted: nobody reported
      idle.push(null)
      continue
    }
    let b = 0
    let f = 0
    for (const h of gpuHosts()) {
      const s = specs.get(h.name)!
      if (!s.up && i >= Math.floor(g.n * 0.6)) continue
      const n = s.smi ?? s.count
      const t = g.start + i * g.step
      const day = 0.55 + 0.35 * Math.sin((t / 86400) * 2 * Math.PI - 1.2) // busier in the afternoon
      const k = Math.round(clamp(n * day + 2 * (noise(`${h.name}fb`, t / 3600) - 0.5), 0, n))
      b += k
      f += n - k
    }
    busy.push(b)
    idle.push(f)
  }
  const groups = [...new Set(hosts.map((h) => h.group))].sort().map((group) => {
    const members = hosts.filter((h) => h.group === group)
    const live = members.filter((h) => h.monitored && !specs.get(h.name)?.fresh)
    const withGpu = live.filter((h) => (specs.get(h.name)?.count ?? 0) > 0 && specs.get(h.name)?.nvidiaOk)
    const allDown = live.length > 0 && live.every((h) => !specs.get(h.name)?.up)
    const gaps: [number, number][] = allDown ? [[Math.floor(g.n * 0.6), g.n]] : []
    return {
      group,
      hosts_total: members.length,
      hosts_up: live.filter((h) => specs.get(h.name)?.up).length,
      gpu_util: withGpu.length ? waveValues(`${group}g`, g, 55, 30, gaps) : Array<number | null>(g.n).fill(null),
      cpu_pct: live.length ? waveValues(`${group}c`, g, 35, 20, gaps) : Array<number | null>(g.n).fill(null),
    }
  })
  return { range, step: g.step, start: g.start, end: g.end, gpus_busy: busy, gpus_idle: idle, groups }
}

export function gpuHistory(): GpuHistory {
  const g = grid(3600, 60)
  const board = gpuBoard()
  const out: GpuHistory['hosts'] = {}
  for (const h of board.hosts) {
    const m: Record<string, Values> = {}
    for (const gpu of h.gpus) {
      if (gpu.util_pct === null) continue // the sick card: no utilization series
      const k = `${h.host}-${gpu.index}`
      const idleNow = gpu.idle
      const vals = waveValues(k, g, idleNow ? 8 : 70, idleNow ? 6 : 25, k.endsWith('-3') && h.host === 'gpu01' ? [[20, 27]] : [])
      // idle cards went idle a while ago; the newest point is the board's current value
      m[gpu.uuid] = vals.map((v, i) => (v === null ? null : idleNow && i > g.n * (0.3 + 0.5 * hash(k)) ? r1(2 * hash(`${k}${i}`)) : v))
      m[gpu.uuid][g.n - 1] = r1(gpu.util_pct)
    }
    if (Object.keys(m).length) out[h.host] = m
  }
  return { range: '1h', step: g.step, start: g.start, end: g.end, hosts: out }
}

export function hostHistory(): HostHistory {
  const g = grid(21600, 300)
  const out: HostHistory['hosts'] = {}
  for (const h of hosts) {
    const s = specs.get(h.name)!
    if (!h.monitored || s.fresh) continue // never scraped: absent
    const gaps = downFrom(h.name, g.n)
    out[h.name] = {
      cpu_pct: waveValues(`${h.name}cpu6`, g, 40, 30, gaps),
      gpu_util: s.count && s.nvidiaOk ? waveValues(`${h.name}gpu6`, g, 50, 40, gaps) : null,
    }
  }
  return { range: '6h', step: g.step, start: g.start, end: g.end, hosts: out }
}

const TiB = 1024 ** 4

export function filesystems(): FilesystemBoard {
  return {
    hosts: hosts
      .filter((h) => h.monitored)
      .map((h) => {
        const s = specs.get(h.name)!
        if (!s.up || s.fresh) return { host: h.name, group: h.group, filesystems: [] }
        const fs = (mountpoint: string, device: string, size: number, pct: number) => {
          const used = size * pct
          const reserved = mountpoint === '/' || mountpoint === '/home' ? size * 0.05 : 0 // ext4 root reserve
          return { mountpoint, device, size_bytes: size, used_bytes: used, avail_bytes: Math.max(0, size - used - reserved) }
        }
        const list = [
          fs('/', '/dev/nvme0n1p2', 0.94 * TiB, h.name === 'gpu02' ? 0.9 : 0.35 + 0.4 * hash(`${h.name}root`)),
          fs('/home', '/dev/md0', 1.8 * TiB, 0.4 + 0.5 * hash(`${h.name}home`)),
          fs('/data0', '/dev/sda1', 32 * TiB, h.name === 'gpu03' ? 0.97 : 0.3 + 0.6 * hash(`${h.name}data`)),
        ]
        if (hash(`${h.name}d1`) > 0.6) list.push(fs('/data1', '/dev/sdb1', 16 * TiB, 0.05 + 0.5 * hash(`${h.name}d1x`)))
        return { host: h.name, group: h.group, filesystems: list }
      }),
  }
}

export function diskTrend(days: number): DiskTrend {
  const g = grid(days * 86400, 86400)
  const owners = [...USERS, 'olduser', 'root', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan']
  const out = owners.map((owner, k) => {
    const base = (0.3 + 4 * hash(`${owner}base`)) * TiB
    const growth = (hash(`${owner}grow`) - 0.25) * 0.04 * base // some shrink (cleanup)
    const firstDay = owner === 'erin' ? g.n - 3 : owner === 'dave' ? g.n - 1 : 0 // new users: a short or one-point series
    const bytes: Values = Array.from({ length: g.n }, (_, i) => {
      if (i < firstDay) return null
      if (k % 3 === 0 && i >= 10 && i < 12) return null // a host was down on those nights
      return Math.round(base + growth * i + (i > g.n - 8 && owner === 'bob' ? 1.5 * TiB : 0))
    })
    return { owner, bytes }
  })
  const latest = (v: Values) => [...v].reverse().find((x) => x !== null) ?? 0
  out.sort((a, b) => latest(b.bytes) - latest(a.bytes))
  return { days, step: g.step, start: g.start, end: g.end, owners: out.slice(0, 10) }
}

// ---- disk / monthly -----------------------------------------------------

export function diskUsage(): DiskUsage {
  const rows: DiskUsage['rows'] = []
  for (const h of hosts.filter((x) => x.facts_at)) {
    for (const u of [...USERS, 'olduser']) {
      if (u === 'olduser' && h.name !== 'gpu01') continue
      rows.push({ host: h.name, root: '/home', path: `/home/${u}`, owner: u, bytes: 2e10 + 4e11 * hash(`${h.name}${u}h`) })
      if (hash(`${h.name}${u}d`) > 0.3) rows.push({ host: h.name, root: '/data0', path: `/data0/${u}`, owner: u, bytes: 1e11 + 3e12 * hash(`${h.name}${u}d`) })
    }
    rows.push({ host: h.name, root: '/data0', path: '/data0/shared', owner: 'root', bytes: 5e12 * hash(`${h.name}shared`) })
  }
  const owners = new Map<string, { bytes: number; paths: number }>()
  for (const r of rows) {
    const o = owners.get(r.owner) ?? { bytes: 0, paths: 0 }
    o.bytes += r.bytes
    o.paths++
    owners.set(r.owner, o)
  }
  return {
    owners: [...owners.entries()].map(([owner, v]) => ({ owner, ...v })),
    rows,
    last_scan: hosts
      .filter((x) => x.facts_at)
      .flatMap((h, i) => [
        { host: h.name, root: '/home', at: specs.get(h.name)!.up ? daysAgo(0.4) : daysAgo(11) },
        { host: h.name, root: '/data0', at: daysAgo(2 + i) },
      ]),
  }
}

export function gpuMonthly(month: string): GpuMonthly {
  const by_user_host: GpuMonthly['by_user_host'] = []
  for (const h of hosts.filter((x) => (specs.get(x.name)?.count ?? 0) > 0)) {
    for (const u of USERS) {
      const v = Math.round(hash(`${month}${h.name}${u}`) * 900 * 10) / 10
      if (v > 40) by_user_host.push({ user: u, host: h.name, gpu_hours: v })
    }
  }
  const sum = <K extends 'user' | 'host'>(k: K) => {
    const m = new Map<string, number>()
    for (const r of by_user_host) m.set(r[k], (m.get(r[k]) ?? 0) + r.gpu_hours)
    return [...m.entries()].map(([key, gpu_hours]) => ({ key, gpu_hours: Math.round(gpu_hours * 10) / 10 }))
  }
  return {
    month,
    by_user: sum('user').map((r) => ({ user: r.key, gpu_hours: r.gpu_hours })),
    by_host: sum('host').map((r) => ({ host: r.key, gpu_hours: r.gpu_hours })),
    by_user_host,
  }
}

// ---- announcements / requests / jobs / audit ---------------------------------

const MIN = 60000

export const announcements: Announcement[] = [
  {
    id: 5,
    title: 'gpu03 驅動程式更新',
    body: '更新 NVIDIA 驅動與 CUDA，期間 gpu03 無法使用 GPU，請勿在上面排程工作。',
    starts_at: iso(new Date(new Date(now() + 6 * 86400000).setHours(9, 0, 0, 0)).getTime()),
    ends_at: iso(new Date(new Date(now() + 6 * 86400000).setHours(12, 0, 0, 0)).getTime()),
    created_by: 'alice',
    hosts: ['gpu03'],
  },
  {
    id: 4,
    title: 'gpu01 更換風扇（延期）',
    body: '原定今天更換 gpu01 的風扇，零件未到，延期到下週，另行公告。',
    starts_at: daysAgo(0.2),
    ends_at: iso(now() + 86400000),
    created_by: 'alice',
    hosts: ['gpu01'],
  },
  {
    id: 3,
    title: '緊急維修：gpu02 電源供應器',
    body: 'gpu02 電源供應器告警，稍後停機檢修，請立刻存檔。',
    starts_at: daysAgo(0.1),
    ends_at: iso(now() + 86400000),
    created_by: 'alice',
    hosts: [],
  },
  {
    id: 2,
    title: '機房電力維護：部分主機將關機',
    body: '配合機房年度電力檢修，gpu01、gpu02 將於下列時間關機，請提前存檔並停止訓練工作。\n預計隔天早上恢復。',
    starts_at: daysAgo(1),
    ends_at: iso(now() + 4 * 86400000),
    created_by: 'alice',
    hosts: [],
  },
  {
    id: 1,
    title: '請定期清理 /data0',
    body: '資料碟使用率已超過 80%，請將不再需要的 checkpoint 移除或搬到自己的儲存空間。',
    starts_at: daysAgo(10),
    ends_at: null,
    created_by: 'alice',
    hosts: [],
  },
]

const req = (r: Partial<AccountRequest> & Pick<AccountRequest, 'id' | 'kind' | 'sso_id' | 'username' | 'purpose'>): AccountRequest => ({
  person_id: null, email: null, name: null, gpus: null, min_vram_gb: null, until: null, hosts: [], status: 'pending',
  created_at: daysAgo(1), updated_at: r.created_at ?? daysAgo(1), decided_by: null, decided_at: null, job_id: null, jobs: [], reject_reason: null, ...r,
})

export const requests: AccountRequest[] = [
  req({ id: 5, kind: 'hosts', person_id: 2, sso_id: 'bob02', email: 'bob@example.org', username: 'bob', purpose: '前處理資料需要大量 CPU，另外要兩張卡做推論。',
    gpus: 2, min_vram_gb: 24, until: dateIn(90), created_at: daysAgo(0.1) }),
  req({ id: 4, kind: 'account', sso_id: 'dave04', email: 'dave@example.org', name: '陳大衛', username: 'dave',
    purpose: '碩士論文實驗，需要 GPU 訓練影像分割模型（PyTorch），每次約跑 2 天。', gpus: 4, min_vram_gb: 40, until: dateIn(365), created_at: daysAgo(0.2) }),
  req({ id: 3, kind: 'account', sso_id: 'erin05', name: '林怡君', username: 'erin', purpose: '專題研究，短期使用。', gpus: 1, until: dateIn(120),
    created_at: daysAgo(1.5), updated_at: daysAgo(1.2) }),
  req({ id: 2, kind: 'account', person_id: 3, sso_id: 'carol03', email: 'carol@example.org', name: 'Carol', username: 'carol', purpose: '課程專題。',
    gpus: 1, until: dateIn(12), hosts: ['gpu01', 'gpu03'], status: 'approved', created_at: daysAgo(91), decided_by: 'alice', decided_at: daysAgo(90) }),
]

const CHECK_OUTPUT = `PLAY [users] *******************************************************************

TASK [assert username] *********************************************************
ok: [gpu01]
ok: [gpu02]

TASK [ensure account present] **************************************************
--- before
+++ after
@@ -1 +1 @@
-state: absent
+state: present
+uid: 20004
changed: [gpu01] => (item=dave)
changed: [gpu02] => (item=dave)

TASK [authorized keys] *********************************************************
ok: [gpu01]
ok: [gpu02]

PLAY RECAP *********************************************************************
gpu01                      : ok=3    changed=1    unreachable=0    failed=0
gpu02                      : ok=3    changed=1    unreachable=0    failed=0
`

const COLLECT_LINES = [
  'PLAY [collect] *****************************************************************',
  '',
  'TASK [Gathering Facts] *********************************************************',
  'ok: [gpu01]',
  'ok: [gpu02]',
  'ok: [gpu03]',
  '',
  'TASK [labdeck-agent collect] *****************************************************',
  'ok: [gpu01]',
  'ok: [gpu02]',
  'ok: [gpu03]',
  '',
  'TASK [fetch result] ************************************************************',
  'changed: [gpu01]',
  'changed: [gpu02]',
  'changed: [gpu03]',
  '',
  'PLAY RECAP *********************************************************************',
  'gpu01                      : ok=3    changed=1    unreachable=0    failed=0',
  'gpu02                      : ok=3    changed=1    unreachable=0    failed=0',
  'gpu03                      : ok=3    changed=1    unreachable=0    failed=0',
]

const bootedAt = now()

const SHUTDOWN_OUT = (cmd: string, host: string) => `TASK [${cmd}] *****************************************************\nchanged: [${host}]\n\nPLAY RECAP\n${host} : ok=1 changed=1 unreachable=0 failed=0\n`

const rawJobs: Omit<JobDetail, 'summary' | 'scoped' | 'failure'>[] = [
  {
    id: 16, kind: 'shutdown', target_hosts: ['gpu01'], status: 'ok', actor: 'alice', created_at: iso(now() - MIN), run_at: iso(now() - MIN), finished_at: iso(now() - 0.8 * MIN), auto_confirm: false,
    args: { target_hosts: 'gpu01', action: 'cancel', delay_min: 10 }, check_output: null, output: SHUTDOWN_OUT('shutdown -c', 'gpu01'),
  },
  {
    id: 15, kind: 'shutdown', target_hosts: ['gpu01'], status: 'ok', actor: 'alice', created_at: daysAgo(0.2), run_at: iso(now() - 2 * MIN), finished_at: iso(now() - 1.9 * MIN), auto_confirm: false,
    args: { target_hosts: 'gpu01', action: 'poweroff', delay_min: 10 }, check_output: null, output: SHUTDOWN_OUT('shutdown -P +10', 'gpu01'),
  },
  {
    id: 14, kind: 'shutdown', target_hosts: ['gpu02'], status: 'ok', actor: 'alice', created_at: daysAgo(0.1), run_at: iso(now() - 4 * MIN), finished_at: iso(now() - 3.9 * MIN), auto_confirm: false,
    args: { target_hosts: 'gpu02', action: 'poweroff', delay_min: 10 }, check_output: null, output: SHUTDOWN_OUT('shutdown -P +10', 'gpu02'),
  },
  {
    id: 12, kind: 'users', target_hosts: ['gpu01', 'gpu02'], status: 'awaiting', actor: 'alice', created_at: daysAgo(0.01), run_at: daysAgo(0.01), finished_at: null, auto_confirm: false,
    args: { target_hosts: 'gpu01,gpu02', accounts: { gpu01: [{ username: 'dave', uid: 20004, state: 'present' }], gpu02: [{ username: 'dave', uid: 20004, state: 'present' }] } },
    check_output: `[rc=0]\n${CHECK_OUTPUT}`, output: null,
  },
  {
    // the scheduler's daily collect: target "all" is listed as [] (api.md)
    id: 11, kind: 'collect', target_hosts: [], status: 'running', actor: 'scheduler', created_at: iso(bootedAt - 5000), run_at: iso(bootedAt - 5000), finished_at: null, auto_confirm: false,
    args: { collect_dir: '/data/collect', target_hosts: 'all' }, check_output: null, output: '',
  },
  {
    id: 10, kind: 'agents', target_hosts: ['gpu03'], status: 'ok', actor: 'alice', created_at: daysAgo(2), run_at: daysAgo(2), finished_at: daysAgo(1.99), auto_confirm: true,
    args: { target_hosts: 'gpu03' }, check_output: null, output: 'PLAY RECAP\ngpu03 : ok=14 changed=3 unreachable=0 failed=0\n',
  },
  {
    id: 9, kind: 'power', target_hosts: ['gpu04'], status: 'failed', actor: 'alice', created_at: daysAgo(3), run_at: daysAgo(3), finished_at: daysAgo(2.99), auto_confirm: true,
    args: { target_hosts: 'gpu04', power_state: 'on' }, check_output: null, output: 'fatal: [gpu04]: FAILED! => {"msg": "Unable to establish IPMI v2 / RMCP+ session"}\n',
  },
  {
    id: 8, kind: 'shutdown', target_hosts: ['gpu01', 'gpu02'], status: 'queued', actor: 'alice', created_at: daysAgo(1), run_at: iso(now() + 3 * 86400000 - 600000), finished_at: null, auto_confirm: true,
    args: { target_hosts: 'gpu01,gpu02', action: 'poweroff', delay_min: 10 }, check_output: null, output: null,
  },
]

/** As the API describes them (summary, failure): see packages/core describeJob / failureSummary. */
export const jobs: JobDetail[] = rawJobs.map((j) => ({
  ...j,
  summary: `${({ collect: '收集資料', agents: '安裝監控', users: '帳號同步' } as Record<string, string>)[j.kind] ?? j.kind} @${j.target_hosts.join('、') || '全部主機'}`,
  scoped: false,
  failure: j.status === 'failed' ? '工作失敗，請看下方輸出' : null,
}))

/** Advance the simulated running collect job: one output line every ~1.5 s. */
export function tickJobs() {
  const j = jobs.find((x) => x.id === 11)!
  if (j.status !== 'running') return
  const n = Math.min(COLLECT_LINES.length, Math.floor((now() - bootedAt) / 1500))
  j.output = COLLECT_LINES.slice(0, n).join('\n')
  if (n >= COLLECT_LINES.length) {
    j.status = 'ok'
    j.finished_at = iso(now())
  }
}

export function auditPage(page: number): AuditPage {
  const total = 230
  const actions = ['host.add', 'job.confirm', 'person.update', 'key.add', 'request.approve', 'power', 'announcement.create', 'grants.update']
  const rows = Array.from({ length: Math.max(0, Math.min(100, total - (page - 1) * 100)) }, (_, i) => {
    const n = (page - 1) * 100 + i
    const action = actions[n % actions.length]
    return {
      ts: iso(now() - n * 3.7 * 3600000),
      actor: n % 7 === 0 ? null : USERS[n % 3],
      action,
      target: action.startsWith('host') || action === 'power' ? names[n % names.length] : USERS[(n + 1) % 3],
      detail: action === 'grants.update' ? { hosts: names.slice(0, 2) } : action === 'job.confirm' ? { job_id: 12 - (n % 5) } : {},
    }
  })
  return { rows, page, has_more: page * 100 < total }
}

// ---- adoption suggestions ------------------------------------------------------

/** Unmanaged accounts with one uid everywhere (a few pilot-like names), plus carol's leftover account on another host. */
export const adoptGroups: AdoptGroup[] = [
  { username: 'olduser', uid: 1001, hosts: ['gpu01'], last_active: daysAgo(500), existing_person: null },
  { username: 'judy', uid: 1003, hosts: ['gpu01', 'gpu02', 'gpu03', 'cpu02'], last_active: daysAgo(0.4), existing_person: null },
  { username: 'mallory', uid: 1004, hosts: ['gpu01', 'gpu02', 'gpu04'], last_active: daysAgo(3), existing_person: null },
  { username: 'niaj', uid: 1010, hosts: ['gpu02', 'gpu03'], last_active: daysAgo(12), existing_person: null },
  { username: 'oscar', uid: 1011, hosts: ['gpu01', 'gpu02', 'gpu03', 'gpu04', 'cpu01', 'cpu02'], last_active: daysAgo(1.2), existing_person: null },
  { username: 'peggy', uid: 1012, hosts: ['gpu03'], last_active: daysAgo(210), existing_person: null },
  { username: 'carol', uid: 20003, hosts: ['cpu02'], last_active: daysAgo(6), existing_person: { id: 3, username: 'carol' } },
]

export const adoptConflicts: AdoptConflict[] = [
  { username: 'bob', reason: '同名帳號的 UID 不同，不一定是同一人', entries: [{ host: 'gpu02', uid: 1005 }, { host: 'cpu02', uid: 1006 }] },
  { username: 'guest', reason: 'UID 1002 也被 labuser 使用', entries: [{ host: 'gpu02', uid: 1002 }] },
]

// ---- host health ----------------------------------------------------------------

const HEALTH_LABELS: [HealthKey, string][] = [
  ['reachable', '連線'],
  ['collect_age', '資料收集'],
  ['apt', 'apt 套件來源'],
  ['reboot_required', '待重開機'],
  ['disk_root', '根目錄空間'],
  ['disk_any', '最滿的磁碟'],
  ['smart', '硬碟 SMART'],
  ['gpu_missing', 'GPU 數量'],
  ['driver_drift', 'NVIDIA driver'],
  ['os_eol', 'OS 支援期'],
]

/** GET /api/admin/health, derived from the fixture hosts: broken apt, a nearly full /, mixed drivers and Ubuntu versions. */
export function healthBoard(metricsDown: boolean): HealthBoard {
  const fleet = '550'
  return {
    updated_at: iso(now()),
    metrics_ok: !metricsDown,
    fleet_driver: fleet,
    hosts: hosts.map((h) => {
      const i = names.indexOf(h.name)
      const s = specs.get(h.name)
      const live = h.monitored && !metricsDown && !s?.fresh
      const noLive = !h.monitored ? '未監控' : metricsDown ? '監控資料暫時無法取得' : s?.fresh ? '尚未抓取到資料' : null
      const collected = h.facts_at !== null
      const c: Record<HealthKey, [HealthStatus, string]> = {
        reachable: noLive ? ['unknown', noLive] : s?.up ? ['ok', 'node_exporter 正常回應'] : ['bad', 'node_exporter 抓不到（關機、斷網或服務停止）'],
        collect_age: collected ? ['ok', `${Math.max(1, Math.round((0.3 + i * 0.1) * 24))} 小時前收集`] : ['bad', '從未收集資料'],
        apt: !collected
          ? ['unknown', '尚無資料（收集腳本更新後的下一次收集才有）']
          : i % 7 === 1
            ? ['bad', `最後一次成功 apt update：${38 + i} 天前（apt 來源可能壞掉：金鑰過期、套件庫不存在或網路不通）`]
            : i % 10 === 6
              ? ['warn', '最後一次成功 apt update：5 天前（apt 來源可能壞掉：金鑰過期、套件庫不存在或網路不通）']
              : ['ok', '最後一次成功 apt update：9 小時前'],
        reboot_required: !collected
          ? ['unknown', '尚無資料（收集腳本更新後的下一次收集才有）']
          : i % 3 === 0
            ? ['warn', `需要重新開機（linux-image-6.8.0-45-generic、linux-base）；已開機 ${180 + i * 7} 天`]
            : ['ok', `已開機 ${12 + i} 天`],
        disk_root: noLive
          ? ['unknown', noLive]
          : h.name === 'gpu02'
            ? ['bad', '/ 已用 93%，剩 7.8 GB，照目前速度約 2.1 天後寫滿']
            : ['ok', `/ 已用 ${Math.round(45 + 30 * hash(`${h.name}root`))}%，剩 ${Math.round(40 + 200 * hash(h.name))}.0 GB`],
        disk_any: noLive
          ? ['unknown', noLive]
          : h.name === 'gpu03'
            ? ['bad', '/data0 已用 97%，剩 118.2 GB，照目前速度約 6.3 天後寫滿']
            : h.name === 'gpu02'
              ? ['bad', '/ 已用 93%，剩 7.8 GB，照目前速度約 2.1 天後寫滿']
              : ['ok', `/data0 已用 ${Math.round(50 + 30 * hash(`${h.name}data`))}%，剩 1.9 TB`],
        smart: noLive ? ['unknown', noLive] : i === 2 ? ['bad', '未通過：sdc'] : ['ok', '4 顆硬碟正常'],
        gpu_missing: !s?.count
          ? ['ok', '無 GPU']
          : s.smi !== undefined && s.smi < s.count
            ? ['bad', `lspci 看到 ${s.count} 張，nvidia-smi 只看到 ${s.smi} 張`]
            : !s.nvidiaOk && live
              ? ['bad', `nvidia-smi 執行失敗（lspci 看到 ${s.count} 張）`]
              : ['ok', `${s.count} 張`],
        driver_drift: !h.nvidia_driver
          ? s?.count
            ? ['unknown', '讀不到 NVIDIA driver 版本']
            : ['ok', '無 GPU']
          : h.nvidia_driver.startsWith(`${fleet}.`)
            ? ['ok', h.nvidia_driver]
            : ['warn', `${h.nvidia_driver}（多數主機為 ${fleet} 版）`],
        os_eol: !h.os
          ? ['unknown', '沒有 OS 資料']
          : h.os.includes('20.04')
            ? ['warn', `${h.os}：標準支援已於 2025-06 前結束，不再有安全更新`]
            : ['ok', `${h.os}（支援到 ${h.os.includes('24.04') ? '2029-06' : '2027-06'}）`],
      }
      const checks: HealthCheck[] = HEALTH_LABELS.map(([key, label]) => ({ key, label, status: c[key][0], detail: c[key][1] }))
      return { host: h.name, group: h.group, checks }
    }),
  }
}

// ---- new-member guide ------------------------------------------------------------

// Short stand-in for packages/core/guide.md (the backend's built-in default).
export const defaultGuide = `# 歡迎使用 {{site_name}}

這份指南帶你從登記帳號到開始跑實驗。

## 1. 登記

以 **{{oauth_name}}** 登入後到「[登記](/request)」填寫姓名、希望的帳號名稱、用途、GPU 需求與預計使用到的日期，助教會指派主機。

## 3. 第一次登入（改密碼）

1. 「[我的帳號](/me)」會顯示一次**臨時密碼**。
2. 用**終端機**登入：

   \`\`\`bash
   ssh <帳號>@<主機位址>
   \`\`\`

**注意**：VS Code Remote-SSH、\`scp\` 無法完成強制改密碼，第一次一定要用終端機。

## 5. 找空卡

| 指令 | 用途 |
|---|---|
| \`nvidia-smi\` | 看每張卡的使用率 |
| \`CUDA_VISIBLE_DEVICES=2 python train.py\` | 只用第 2 張卡 |

> 閒置 = 使用率 < 5% 且記憶體 < 1 GiB，見 [GPU 即時看板](/gpus)。
`

export const guide = { source: defaultGuide, updated_at: null as string | null, updated_by: null as string | null, members: '## 實驗室 Wi-Fi\n\nSSID `Example-Lab`，密碼請見這裡（示範資料）。' }
