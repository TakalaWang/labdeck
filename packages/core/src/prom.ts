import { config } from './config.ts'
import { io } from './io.ts'
import { iso, localIso, parseIso } from './time.ts'
import { ValueErr, cmp, pyRound, roundHalfEven, sortBy } from './util.ts'

// Prometheus: fixed queries only, never PromQL from a request (api.md 監控資料).

const FS = 'fstype!~"tmpfs|devtmpfs|ramfs|overlay|squashfs|nsfs|autofs|nfs.*|cifs|smb3|fuse.*"'
const NIC = 'device!~"lo|docker.*|veth.*|br-.*"'

/** $h = job="node"[,instance="<host name from the DB>"], $w = rate window, $r = subquery range. */
export const PROMQL: Record<string, string> = {
  // Host.status: instant, one series per instance
  'status.up': 'max by (instance) (up{$h})',
  'status.cpu_pct': '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{$h,mode="idle"}[$w])))',
  'status.mem_pct': 'max by (instance) (100 * (1 - node_memory_MemAvailable_bytes{$h} / node_memory_MemTotal_bytes{$h}))',
  'status.root_pct':
    'max by (instance) (100 * (1 - node_filesystem_avail_bytes{$h,mountpoint="/"} / node_filesystem_size_bytes{$h,mountpoint="/"}))',
  'status.gpu_util_avg': 'avg by (instance) (lab_gpu_utilization_percent{$h})',
  'status.net_rx_bps': 'sum by (instance) (rate(node_network_receive_bytes_total{$h,$nic}[$w]))',
  'status.net_tx_bps': 'sum by (instance) (rate(node_network_transmit_bytes_total{$h,$nic}[$w]))',
  // /api/metrics/hosts/{name}: range queries for one instance
  'host.cpu_pct': '100 * (1 - avg(rate(node_cpu_seconds_total{$h,mode="idle"}[$w])))',
  'host.mem_pct': 'max(100 * (1 - node_memory_MemAvailable_bytes{$h} / node_memory_MemTotal_bytes{$h}))',
  'host.net_rx_bps': 'sum by (device) (rate(node_network_receive_bytes_total{$h,$nic}[$w]))',
  'host.net_tx_bps': 'sum by (device) (rate(node_network_transmit_bytes_total{$h,$nic}[$w]))',
  'host.disk_pct': 'max by (mountpoint) (100 * (1 - node_filesystem_avail_bytes{$h,$fs} / node_filesystem_size_bytes{$h,$fs}))',
  'host.gpu_util_pct': 'max by (gpu) (lab_gpu_utilization_percent{$h})',
  'host.gpu_mem_pct': 'max by (gpu) (100 * lab_gpu_memory_used_bytes{$h} / lab_gpu_memory_total_bytes{$h})',
  // raw series: GPU board + summary, disk page, /api/me/usage
  gpus:
    '{$h,__name__=~"up|lab_nvidia_smi_ok|lab_gpu_(info|pci_count|utilization_percent|memory_(used|total)_bytes|temperature_celsius|power_watts|process_memory_bytes)"}',
  disk: '{$h,__name__=~"lab_user_disk_bytes|lab_du_success_timestamp_seconds"}',
  usage: '{$h,__name__=~"lab_user_(disk_bytes|cpu_cores|memory_bytes|processes)|lab_gpu_process_memory_bytes"}',
  // /api/metrics/users: raw series, plus each host's own CPU count and busy cores (not the sum of its users)
  users: '{$h,__name__=~"up|node_memory_Mem(Total|Available)_bytes|lab_user_(cpu_cores|memory_bytes|processes)|lab_gpu_process_memory_bytes"}',
  'users.cpu_count': 'count by (instance) (node_cpu_seconds_total{$h,mode="idle"})',
  'users.cpu_busy': 'sum by (instance) (1 - rate(node_cpu_seconds_total{$h,mode="idle"}[$w]))',
  // GPU hours per (instance, user); one user's processes on one card count once per 1-minute sample.
  // ponytail: a month-long 1m subquery over raw series; if it gets slow, add a recording rule for the inner count.
  gpu_monthly: 'sum by (instance, user) (count_over_time((count by (instance, uuid, user) (lab_gpu_process_memory_bytes{$h}))[$r:1m])) / 60',
  // /api/admin/health: per real filesystem, plus the raw SMART / GPU count series
  'health.fs_pct': 'max by (instance, mountpoint) (100 * (1 - node_filesystem_avail_bytes{$h,$fs} / node_filesystem_size_bytes{$h,$fs}))',
  'health.fs_avail': 'max by (instance, mountpoint) (node_filesystem_avail_bytes{$h,$fs})',
  // Days until predict_linear over the last 6 h reaches 0 free bytes (a / (a - a in 1 day)); only shrinking ones.
  'health.fs_days':
    'min by (instance, mountpoint) (predict_linear(node_filesystem_avail_bytes{$h,$fs}[6h], 0) / (predict_linear(node_filesystem_avail_bytes{$h,$fs}[6h], 0) - predict_linear(node_filesystem_avail_bytes{$h,$fs}[6h], 86400)) > 0)',
  'health.raw': '{$h,__name__=~"lab_smart_healthy|lab_gpu_pci_count|lab_gpu_smi_count|lab_nvidia_smi_ok"}',
  // History charts: range queries over every instance at once, split by DB host here
  'fleet.gpus': 'count by (instance) (lab_gpu_utilization_percent{$h})',
  'fleet.gpus_idle':
    'count by (instance) ((lab_gpu_utilization_percent{$h} < 5) and on (instance, uuid) (lab_gpu_memory_used_bytes{$h} < 1073741824))',
  'fleet.gpu_util_sum': 'sum by (instance) (lab_gpu_utilization_percent{$h})',
  'fleet.cpu_busy': 'sum by (instance) (1 - rate(node_cpu_seconds_total{$h,mode="idle"}[$w]))',
  'fleet.cpu_count': 'count by (instance) (node_cpu_seconds_total{$h,mode="idle"})',
  'history.gpu_util': 'max by (instance, uuid) (lab_gpu_utilization_percent{$h})',
  'history.cpu_pct': '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{$h,mode="idle"}[$w])))',
  'history.gpu_util_avg': 'avg by (instance) (lab_gpu_utilization_percent{$h})',
  // /api/metrics/disk/filesystems (instant) and the du trend (the last value within 2 days bridges a missed night)
  'fs.size': 'max by (instance, device, mountpoint) (node_filesystem_size_bytes{$h,$fs})',
  'fs.free': 'max by (instance, device, mountpoint) (node_filesystem_free_bytes{$h,$fs})',
  'fs.avail': 'max by (instance, device, mountpoint) (node_filesystem_avail_bytes{$h,$fs})',
  'disk.trend': 'sum by (instance, owner) (last_over_time(lab_user_disk_bytes{$h}[2d]))',
}

export const STATUS = ['up', 'cpu_pct', 'mem_pct', 'root_pct', 'gpu_util_avg', 'net_rx_bps', 'net_tx_bps'] as const
/** field → label the series are keyed by */
export const CHARTS: Record<string, string | null> = {
  cpu_pct: null, mem_pct: null, net_rx_bps: 'device', net_tx_bps: 'device', disk_pct: 'mountpoint',
  gpu_util_pct: 'gpu', gpu_mem_pct: 'gpu',
}
export const RANGES: Record<string, [number, number]> = {
  '1h': [3600, 15], '6h': [6 * 3600, 60], '24h': [86400, 300], '7d': [7 * 86400, 1800], '30d': [30 * 86400, 7200],
}
/** sparklines: 61–97 points */
export const SPARK_RANGES: Record<string, [number, number]> = { '1h': [3600, 60], '6h': [6 * 3600, 300], '24h': [86400, 900] }
const GPU_FIELDS: Record<string, string> = {
  lab_gpu_utilization_percent: 'util_pct', lab_gpu_memory_used_bytes: 'mem_used_bytes',
  lab_gpu_memory_total_bytes: 'mem_total_bytes', lab_gpu_temperature_celsius: 'temp_c', lab_gpu_power_watts: 'power_w',
}
const USER_FIELDS: Record<string, string> = {
  lab_user_cpu_cores: 'cpu_cores', lab_user_memory_bytes: 'mem_bytes', lab_user_processes: 'processes',
}

/** Prometheus unreachable or answered garbage. */
export class PromError extends Error {
  constructor(message = 'prometheus query failed') {
    super(message)
    this.name = 'PromError'
  }
}

/** Fill a PROMQL template; the only variable input is a host name from the DB, escaped as a label value anyway. */
export function promql(key: string, host?: string | null, vars: Record<string, string> = {}): string {
  let h = 'job="node"'
  if (host !== undefined && host !== null) {
    h += `,instance="${host.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`
  }
  const values: Record<string, string> = { h, nic: NIC, fs: FS, w: '5m', ...vars }
  return PROMQL[key].replace(/\$(\w+)/g, (_, name: string) => {
    if (!(name in values)) throw new Error(`promql ${key}: missing $${name}`)
    return values[name]
  })
}

export type Labels = Record<string, string | undefined>
export type Point = [number, number | null]

/** float(v) that turns NaN / ±Inf into null; throws on garbage. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') throw new PromError('bad value')
  const s = v.trim().toLowerCase()
  if (['nan', '+nan', '-nan', 'inf', '+inf', '-inf', 'infinity', '+infinity', '-infinity'].includes(s)) return null
  const f = Number(v)
  if (!s || Number.isNaN(f)) throw new PromError('bad value')
  return Number.isFinite(f) ? f : null
}

/** One query (query_range when `step` is given) → [labels, value] pairs. */
export async function prom(query: string, params?: { time?: number }): Promise<[Labels, number | null][]>
export async function prom(query: string, params: { start: number; end: number; step: number }): Promise<[Labels, Point[]][]>
export async function prom(query: string, params: Record<string, number> = {}): Promise<[Labels, any][]> {
  const kind = 'step' in params ? 'query_range' : 'query'
  const qs = new URLSearchParams({ query })
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v))
  try {
    const r = await io.fetch(`${config.prometheusUrl}/api/v1/${kind}?${qs}`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new PromError(`HTTP ${r.status}`)
    const result = ((await r.json()) as any).data.result
    if (!Array.isArray(result)) throw new PromError('result is not a list')
    return result.map((s: any) => {
      const labels = s.metric as Labels
      if (!labels || typeof labels !== 'object') throw new PromError('bad series')
      if ('values' in s) return [labels, (s.values as [unknown, unknown][]).map(([t, v]) => [Math.trunc(Number(t)), num(v)])]
      return [labels, num(s.value[1])]
    })
  } catch (e) {
    console.warn(`prometheus query failed: ${e instanceof Error ? e.name : 'Error'}`)
    throw new PromError()
  }
}

const nowSec = () => Math.floor(Date.now() / 1000)

/** {instance: Host.status}; values that Prometheus doesn't have are null. */
export async function hostStatus(): Promise<Map<string | undefined, Record<string, number | boolean | null>>> {
  const st = new Map<string | undefined, Record<string, number | boolean | null>>()
  const results = await Promise.all(STATUS.map((f) => prom(promql(`status.${f}`))))
  STATUS.forEach((field, i) => {
    for (const [labels, v] of results[i]) {
      const inst = labels.instance
      if (!st.has(inst)) st.set(inst, Object.fromEntries(STATUS.map((k) => [k, null])))
      st.get(inst)![field] = v
    }
  })
  for (const s of st.values()) s.up = s.up === null ? null : s.up === 1
  return st
}

/** /api/metrics/hosts/{name}: chart series of one DB host over a RANGES key. */
export async function hostSeries(host: string, rng: string) {
  const [secs, step] = RANGES[rng]
  const end = nowSec() // not rounded to `step`: the newest point would lag by up to one step (2 h on 30d)
  const out: Record<string, unknown> = { range: rng, step }
  const fields = Object.entries(CHARTS)
  const results = await Promise.all(
    fields.map(([field]) => prom(promql(`host.${field}`, host, { w: `${Math.max(60, 2 * step)}s` }), { start: end - secs, end, step })),
  )
  fields.forEach(([field, by], i) => {
    const res = results[i]
    out[field] = by ? Object.fromEntries(res.map(([labels, pts]) => [labels[by] ?? '', pts])) : res.length ? res[0][1] : []
  })
  return out
}

const labelInt = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : null)

export type GpuCard = Record<string, any>

/**
 * [/api/metrics/gpus hosts[], {instance: up}] for [[name, group, GPUs the last collect saw]].
 * A GPU is a uuid with a lab_gpu_info series; other uuids (e.g. only in a process series) are dropped.
 * Hosts without GPUs are left out: no GPU series and lab_gpu_pci_count 0 — or, while that is absent
 * (down, not scraped yet), none in the collected facts. idle = utilization < 5 % and memory < 1 GiB.
 */
export async function gpuBoard(hosts: [string, string, number][]) {
  const up = new Map<string | undefined, boolean>()
  const ok = new Map<string | undefined, boolean>()
  const pci = new Map<string | undefined, number | null>()
  const gpus = new Map<string | undefined, Map<string | undefined, GpuCard>>()
  for (const [labels, v] of await prom(promql('gpus'))) {
    const name = labels.__name__
    const inst = labels.instance
    const uuid = labels.uuid
    if (name === 'up') up.set(inst, v === 1)
    else if (name === 'lab_nvidia_smi_ok') ok.set(inst, v === 1)
    else if (name === 'lab_gpu_pci_count') pci.set(inst, v)
    else {
      if (!gpus.has(inst)) gpus.set(inst, new Map())
      const cards = gpus.get(inst)!
      if (!cards.has(uuid)) {
        cards.set(uuid, {
          index: null, uuid, name: null,
          ...Object.fromEntries(Object.values(GPU_FIELDS).map((f) => [f, null])),
          processes: [],
        })
      }
      const g = cards.get(uuid)!
      if (name === 'lab_gpu_info') {
        g.index = labelInt(labels.gpu)
        g.name = labels.name || '未知 GPU'
      } else if (name === 'lab_gpu_process_memory_bytes') {
        g.processes.push({ user: labels.user ?? null, pid: labelInt(labels.pid), comm: labels.comm ?? null, mem_bytes: v })
      } else if (name !== undefined && name in GPU_FIELDS) {
        g[GPU_FIELDS[name]] = v
      }
    }
  }
  const out: Record<string, unknown>[] = []
  for (const [host, group, collected] of hosts) {
    const gs = sortBy(
      [...(gpus.get(host)?.values() ?? [])].filter((g) => g.name !== null),
      (g) => [g.index === null, g.index ?? 0],
    )
    if (!gs.length && !(pci.has(host) ? pci.get(host) : collected)) continue
    for (const g of gs) {
      g.idle = g.util_pct !== null && g.mem_used_bytes !== null && g.util_pct < 5 && g.mem_used_bytes < 2 ** 30
    }
    out.push({ host, group, up: up.get(host) ?? null, nvidia_ok: ok.get(host) ?? null, gpus: gs })
  }
  return [out, up] as const
}

/** /api/metrics/disk: du rows, totals per owner, last successful scan per (host, root). */
export async function diskUsage() {
  const rows: Record<string, any>[] = []
  const scans: Record<string, any>[] = []
  const owners = new Map<string | undefined, { owner: string | null; bytes: number; paths: number }>()
  for (const [labels, v] of await prom(promql('disk'))) {
    const host = labels.instance ?? null
    const root = labels.root ?? null
    if (labels.__name__ === 'lab_du_success_timestamp_seconds') {
      scans.push({ host, root, at: iso(v) })
      continue
    }
    const owner = labels.owner
    rows.push({ host, root, path: labels.path ?? null, owner: owner ?? null, bytes: v })
    if (!owners.has(owner)) owners.set(owner, { owner: owner ?? null, bytes: 0, paths: 0 })
    const o = owners.get(owner)!
    o.bytes += v ?? 0
    o.paths += 1
  }
  return {
    owners: sortBy(owners.values(), (o) => [-o.bytes]),
    rows: sortBy(rows, (r) => [-(r.bytes ?? 0)]),
    last_scan: sortBy(scans, (s) => [s.host ?? '', s.root ?? '']),
  }
}

// --- history charts: series aligned to one time grid ([v | null] at start + i·step) --------

export type Grid = { step: number; start: number; end: number }

export function grid(secs: number, step: number): Grid {
  const end = nowSec()
  return { step, start: end - secs, end }
}

const gridLen = (g: Grid) => Math.floor((g.end - g.start) / g.step) + 1

/** One range query over every instance → {label value(s) (joined by \u0000): [v | null] on g's grid}. */
export async function aligned(g: Grid, key: string, by: string[] = ['instance'], vars: Record<string, string> = {}) {
  const n = gridLen(g)
  const out = new Map<string | undefined, (number | null)[]>()
  for (const [labels, pts] of await prom(promql(key, null, vars), { start: g.start, end: g.end, step: g.step })) {
    const k = by.length > 1 ? JSON.stringify(by.map((b) => labels[b] ?? null)) : labels[by[0]]
    if (!out.has(k)) out.set(k, Array<number | null>(n).fill(null))
    const row = out.get(k)!
    for (const [t, v] of pts) {
      const i = roundHalfEven((t - g.start) / g.step)
      if (i >= 0 && i < n && v !== null) row[i] = v
    }
  }
  return out
}

const r1 = (vals: (number | null)[]) => vals.map((v) => (v === null ? null : pyRound(v, 1)))

/**
 * /api/metrics/fleet for DB hosts [[name, group, monitored]]: GPUs in use / idle over time (idle as on the board)
 * and per group the average GPU utilization (over its GPUs), CPU utilization (over its cores) and hosts up now.
 */
export async function fleet(hosts: [string, string, boolean][], rng: string) {
  const [secs, step] = RANGES[rng]
  const g = grid(secs, step)
  const w = `${Math.max(60, 2 * step)}s`
  const [gpus, idle, util, busy, cores] = await Promise.all(
    ['fleet.gpus', 'fleet.gpus_idle', 'fleet.gpu_util_sum', 'fleet.cpu_busy', 'fleet.cpu_count'].map((k) => aligned(g, k, ['instance'], { w })),
  )
  const up = new Map((await prom(promql('status.up'))).map(([labels, v]) => [labels.instance, v === 1]))
  const n = gridLen(g)

  const ratio = (num: typeof gpus, den: typeof gpus, members: string[], scale = 1) => {
    const out: (number | null)[] = []
    for (let i = 0; i < n; i++) {
      const pairs = members
        .filter((h) => num.has(h) && den.has(h) && num.get(h)![i] !== null && den.get(h)![i])
        .map((h) => [num.get(h)![i]!, den.get(h)![i]!] as const)
      out.push(pairs.length ? (scale * pairs.reduce((s, [a]) => s + a, 0)) / pairs.reduce((s, [, b]) => s + b, 0) : null)
    }
    return r1(out)
  }

  const live = hosts.filter(([, , m]) => m).map(([h]) => h)
  const total: (number | null)[] = []
  const free: (number | null)[] = []
  for (let i = 0; i < n; i++) {
    const seen = live.filter((h) => gpus.has(h) && gpus.get(h)![i] !== null)
    const idleI = seen.filter((h) => idle.has(h)).reduce((s, h) => s + (idle.get(h)![i] ?? 0), 0) // no idle series = 0 idle
    total.push(seen.length ? Math.trunc(seen.reduce((s, h) => s + gpus.get(h)![i]!, 0)) : null)
    free.push(seen.length ? Math.trunc(idleI) : null)
  }
  const groups = new Map<string, { group: string; hosts_total: number; hosts_up: number; members: string[] }>()
  for (const [h, group, m] of hosts) {
    if (!groups.has(group)) groups.set(group, { group, hosts_total: 0, hosts_up: 0, members: [] })
    const grp = groups.get(group)!
    grp.hosts_total += 1
    if (m) {
      grp.members.push(h)
      grp.hosts_up += up.get(h) === true ? 1 : 0
    }
  }
  const outGroups = [...groups.values()].map(({ members, ...grp }) => ({
    ...grp,
    gpu_util: ratio(util, gpus, members),
    cpu_pct: ratio(busy, cores, members, 100),
  }))
  return {
    range: rng,
    ...g,
    gpus_busy: total.map((t, i) => (t === null ? null : t - free[i]!)),
    gpus_idle: free,
    groups: outGroups.sort((a, b) => cmp(a.group, b.group)),
  }
}

/** /api/metrics/history/gpus: every GPU's utilization on one grid, {host: {uuid: [v | null]}} for DB hosts. */
export async function gpuHistory(hosts: Set<string>, rng: string) {
  const [secs, step] = SPARK_RANGES[rng]
  const g = grid(secs, step)
  const out: Record<string, Record<string, (number | null)[]>> = {}
  for (const [key, vals] of await aligned(g, 'history.gpu_util', ['instance', 'uuid'])) {
    const [inst, uuid] = JSON.parse(key as string) as [string | null, string | null]
    if (inst !== null && hosts.has(inst) && uuid) (out[inst] ??= {})[uuid] = r1(vals)
  }
  return { range: rng, ...g, hosts: out }
}

/** /api/metrics/history/hosts: CPU and average GPU utilization of every DB host; hosts without data are left out. */
export async function hostHistory(hosts: string[], rng: string) {
  const [secs, step] = SPARK_RANGES[rng]
  const g = grid(secs, step)
  const w = `${Math.max(60, 2 * step)}s`
  const [cpu, gpu] = await Promise.all([aligned(g, 'history.cpu_pct', ['instance'], { w }), aligned(g, 'history.gpu_util_avg')])
  const out: Record<string, unknown> = {}
  for (const h of hosts) {
    if (cpu.has(h) || gpu.has(h)) {
      out[h] = { cpu_pct: cpu.has(h) ? r1(cpu.get(h)!) : null, gpu_util: gpu.has(h) ? r1(gpu.get(h)!) : null }
    }
  }
  return { range: rng, ...g, hosts: out }
}

/**
 * /api/metrics/disk/filesystems for DB hosts [[name, group]]: size / used / available per real filesystem.
 * used = size − free (as df); a device mounted twice (bind mounts) is listed once, at its shortest mountpoint.
 */
export async function filesystems(hosts: [string, string][]) {
  const fs = new Map<string, { inst?: string; dev?: string; mount?: string; v: (number | null)[] }>()
  const results = await Promise.all(['fs.size', 'fs.free', 'fs.avail'].map((k) => prom(promql(k))))
  results.forEach((res, i) => {
    for (const [labels, v] of res) {
      const k = JSON.stringify([labels.instance ?? null, labels.device ?? null, labels.mountpoint ?? null])
      if (!fs.has(k)) fs.set(k, { inst: labels.instance, dev: labels.device, mount: labels.mountpoint, v: [null, null, null] })
      fs.get(k)!.v[i] = v
    }
  })
  const seen = new Set<string>()
  const perHost = new Map<string | undefined, Record<string, unknown>[]>()
  for (const { inst, dev, mount, v } of sortBy(fs.values(), (x) => [Array.from(x.mount ?? '').length, x.mount ?? ''])) {
    const [size, free, avail] = v
    const key = JSON.stringify([inst ?? null, dev || mount || null])
    if (!size || free === null || avail === null || seen.has(key)) continue
    seen.add(key)
    if (!perHost.has(inst)) perHost.set(inst, [])
    perHost.get(inst)!.push({ mountpoint: mount ?? null, device: dev ?? null, size_bytes: size, used_bytes: Math.max(0, size - free), avail_bytes: avail })
  }
  return {
    hosts: hosts.map(([h, group]) => ({
      host: h,
      group,
      filesystems: sortBy(perHost.get(h) ?? [], (f) => [(f.mountpoint as string) ?? '']),
    })),
  }
}

/** /api/metrics/disk/trend: daily du total per owner over DB hosts, the config.trendTop largest by their latest value. */
export async function diskTrend(hosts: Set<string>, days: number) {
  if (!(days >= 7 && days <= 90)) throw new ValueErr('days 需為 7–90')
  const g = grid(days * 86400, 86400)
  const totals = new Map<string, (number | null)[]>()
  for (const [key, vals] of await aligned(g, 'disk.trend', ['instance', 'owner'])) {
    const [inst, owner] = JSON.parse(key as string) as [string | null, string | null]
    if (inst === null || !hosts.has(inst) || !owner) continue
    if (!totals.has(owner)) totals.set(owner, Array<number | null>(vals.length).fill(null))
    const row = totals.get(owner)!
    vals.forEach((v, i) => {
      if (v !== null) row[i] = (row[i] ?? 0) + v
    })
  }
  const latest = (vals: (number | null)[]) => [...vals].reverse().find((v) => v !== null) ?? 0
  const top = sortBy(totals, ([o, vals]) => [-latest(vals), o]).slice(0, config.trendTop)
  return { days, ...g, owners: top.map(([owner, bytes]) => ({ owner, bytes })) }
}

/** [field, value] of a lab_user_* sample; process counts are whole numbers. */
function userField(name: string, v: number | null): [string, number | null] {
  const field = USER_FIELDS[name]
  return [field, field === 'processes' && v !== null ? Math.trunc(v) : v]
}

/**
 * /api/metrics/users hosts[] for [[name, group]]; `host` narrows the queries to that one instance.
 * Rows merge labdeck-agent procs (CPU, RSS, processes) with the GPU processes of the same user name; a user seen
 * only on a GPU has null CPU/RAM. Heaviest first: the larger of the CPU and RAM share of the host.
 */
export async function userLoad(hosts: [string, string][], host: string | null = null) {
  const up = new Map<string | undefined, boolean>()
  const memTotal = new Map<string | undefined, number | null>()
  const memAvail = new Map<string | undefined, number | null>()
  const users = new Map<string | undefined, Map<string | undefined, Record<string, any>>>()
  const [raw, cpuRes, busyRes] = await Promise.all([
    prom(promql('users', host)),
    prom(promql('users.cpu_count', host)),
    prom(promql('users.cpu_busy', host, { w: '2m' })),
  ])
  for (const [labels, v] of raw) {
    const name = labels.__name__
    const inst = labels.instance
    const user = labels.user
    if (name === 'up') up.set(inst, v === 1)
    else if (name === 'node_memory_MemTotal_bytes') memTotal.set(inst, v)
    else if (name === 'node_memory_MemAvailable_bytes') memAvail.set(inst, v)
    else {
      if (!users.has(inst)) users.set(inst, new Map())
      const m = users.get(inst)!
      if (!m.has(user)) {
        m.set(user, { user: user ?? null, cpu_cores: null, mem_bytes: null, processes: null, gpu_count: 0, gpu_mem_bytes: 0, uuids: new Set() })
      }
      const u = m.get(user)!
      if (name === 'lab_gpu_process_memory_bytes') {
        u.uuids.add(labels.uuid ?? null)
        u.gpu_mem_bytes += v ?? 0
      } else if (name !== undefined && name in USER_FIELDS) {
        const [field, value] = userField(name, v)
        u[field] = value
      }
    }
  }
  const cpus = new Map(cpuRes.map(([l, v]) => [l.instance, v]))
  const busy = new Map(busyRes.map(([l, v]) => [l.instance, v]))
  return hosts.map(([name, group]) => {
    const n = cpus.get(name) ?? null
    const total = memTotal.get(name) ?? null
    const avail = memAvail.get(name) ?? null
    const rows = [...(users.get(name)?.values() ?? [])].map(({ uuids, ...u }) => ({ ...u, gpu_count: uuids.size }) as Record<string, any>)
    const sorted = sortBy(rows, (u) => [
      -Math.max(n ? (u.cpu_cores ?? 0) / n : 0, total ? (u.mem_bytes ?? 0) / total : 0),
      -u.gpu_count,
      u.user ?? '',
    ])
    return {
      host: name,
      group,
      up: up.get(name) ?? null,
      cpu_count: n !== null ? Math.trunc(n) : null,
      cpu_used_cores: busy.get(name) ?? null,
      mem_total_bytes: total,
      mem_used_bytes: total !== null && avail !== null ? total - avail : null,
      users: sorted,
    }
  })
}

/** /api/me/usage for a set of "host\u0000username": GPU processes, CPU/RAM per host and du paths of those accounts. */
export async function usage(accounts: Set<string>) {
  const key = (h?: string, u?: string) => `${h}\u0000${u}`
  const procs: Record<string, unknown>[] = []
  const disk: Record<string, any>[] = []
  const load = new Map<string | undefined, Record<string, any>>()
  for (const [labels, v] of await prom(promql('usage'))) {
    const host = labels.instance
    const name = labels.__name__
    if (name === 'lab_gpu_process_memory_bytes') {
      if (accounts.has(key(host, labels.user))) {
        procs.push({ host: host ?? null, gpu: labelInt(labels.gpu), pid: labelInt(labels.pid), comm: labels.comm ?? null, mem_bytes: v })
      }
    } else if (name !== undefined && name in USER_FIELDS) {
      if (accounts.has(key(host, labels.user))) {
        const [field, value] = userField(name, v)
        if (!load.has(host)) load.set(host, { host: host ?? null, cpu_cores: null, mem_bytes: null, processes: null })
        load.get(host)![field] = value
      }
    } else if (accounts.has(key(host, labels.owner))) {
      disk.push({ host: host ?? null, path: labels.path ?? null, bytes: v })
    }
  }
  return {
    gpu_processes: procs,
    cpu_mem: sortBy(load.values(), (r) => [r.host ?? '']),
    disk: sortBy(disk, (d) => [-(d.bytes ?? 0)]),
  }
}

/** GPU hours per user on one host over the last `days` (the same count as gpuMonthly). */
export async function gpuHours(host: string, days: number) {
  const res = await prom(promql('gpu_monthly', host, { r: `${days * 86400}s` }))
  const users = res.filter(([, v]) => v).map(([labels, v]) => ({ user: labels.user ?? null, gpu_hours: pyRound(v!, 1) }))
  return { days, users: sortBy(users, (r) => [-r.gpu_hours]) }
}

/** GPU hours of one calendar month in the container TZ; the current month counts up to now. */
export async function gpuMonthly(month: string) {
  let start: Date | null = null
  if (/^[0-9]{4}-[0-9]{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number)
    if (y >= 1 && m >= 1 && m <= 12) start = parseIso(`${month}-01T00:00:00`)
  }
  if (!start) throw new ValueErr('月份格式錯誤，應為 YYYY-MM')
  const next = new Date(start)
  next.setMonth(next.getMonth() + 1)
  const nowS = Date.now() / 1000
  const t0 = start.getTime() / 1000
  const t1 = Math.min(next.getTime() / 1000, nowS)
  if (t0 > nowS) throw new ValueErr('月份不可在未來')
  const res = await prom(promql('gpu_monthly', null, { r: `${Math.max(60, Math.trunc(t1 - t0))}s` }), { time: t1 })
  const rows = sortBy(
    res.filter(([, v]) => v).map(([labels, v]) => ({ user: labels.user ?? null, host: labels.instance ?? null, gpu_hours: v! })),
    (r) => [-r.gpu_hours],
  )
  const total = (key: 'user' | 'host') => {
    const sums = new Map<string | null, number>()
    for (const r of rows) sums.set(r[key], (sums.get(r[key]) ?? 0) + r.gpu_hours)
    return sortBy(sums, ([, h]) => [-h]).map(([k, h]) => ({ [key]: k, gpu_hours: pyRound(h, 1) }))
  }
  return {
    month,
    by_user: total('user'),
    by_host: total('host'),
    by_user_host: rows.map((r) => ({ ...r, gpu_hours: pyRound(r.gpu_hours, 1) })),
  }
}

/** The calendar month before today's, YYYY-MM. */
export function lastMonth(): string {
  const d = new Date()
  d.setDate(1)
  d.setDate(0)
  return localIso(d).slice(0, 7)
}
