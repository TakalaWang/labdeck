import { afterEach, expect, test } from 'vitest'
import { HEALTH_LABELS, STATUS, adopt, config, isoOf, localIso, type DB } from '@labdeck/core'
import { fresh, mat, observe, offline, onGrid, person, prometheus, vec } from '../../../packages/core/test/helpers.ts'
import { err, get, login, ok } from './client.ts'

// --- metrics (fake Prometheus) ----------------------------------------------------------

afterEach(() => offline())

test('host status', async () => {
  const con = fresh()
  con.tx(() => {
    con.run("UPDATE hosts SET monitored=1 WHERE name IN ('gpu01', 'gpu03')")
    con.run("INSERT INTO hosts(name, address, group_name, monitored) VALUES ('gpu04', '192.0.2.14', 'legacy', 1)")
  })
  login(person(con, 'mem'))
  const calls = prometheus([
    ['max by (instance) (up{', [vec(1, { instance: 'gpu01' }), vec(0, { instance: 'gpu03' })]],
    ['node_cpu_seconds_total', [vec(43.1, { instance: 'gpu01' })]],
    ['mountpoint="/"', [vec('NaN', { instance: 'gpu01' })]],
    ['sum by (instance) (rate(node_network_receive', [vec(4830, { instance: 'gpu01' })]],
  ])
  const hosts = ok(await get('/api/hosts'))
  const detail = ok(await get('/api/hosts/gpu01'))
  expect(hosts[0].status).toEqual({ up: true, cpu_pct: 43.1, mem_pct: null, root_pct: null, gpu_util_avg: null, net_rx_bps: 4830, net_tx_bps: null })
  expect(hosts[1].status).toBeNull() // gpu02 is not monitored
  expect(hosts[2].status.up).toBe(false)
  expect(hosts[3].status).toEqual(Object.fromEntries(STATUS.map((k) => [k, null]))) // gpu04: not scraped yet → up null, not "down"
  expect(detail.status).toEqual(hosts[0].status)
  expect(calls.length).toBe(14)
  expect(calls.every((c) => c.url === 'http://prometheus.invalid:9090/api/v1/query')).toBe(true)
  expect(calls.some((c) => c.query.includes('instance='))).toBe(false)
})

test('host range', async () => {
  const con = fresh()
  login(person(con, 'mem'))
  let calls = prometheus([
    ['node_cpu_seconds_total', [mat([[1790000000, 43.1], [1790000015, 'NaN']], { instance: 'gpu01' })]],
    ['by (device) (rate(node_network_receive', [mat([[1790000000, 4830]], { device: 'eth0' })]],
    ['by (mountpoint)', [mat([[1790000000, 71.2]], { mountpoint: '/' }), mat([[1790000000, '+Inf']], { mountpoint: '/data0' })]],
    ['max by (gpu) (lab_gpu_utilization', [mat([[1790000000, 97]], { gpu: '0' }), mat([[1790000000, 0]], { gpu: '1' })]],
  ])
  const d = ok(await get('/api/metrics/hosts/gpu01?range=1h'))
  expect(d).toEqual({
    range: '1h', step: 15, cpu_pct: [[1790000000, 43.1], [1790000015, null]], mem_pct: [],
    net_rx_bps: { eth0: [[1790000000, 4830]] }, net_tx_bps: {},
    disk_pct: { '/': [[1790000000, 71.2]], '/data0': [[1790000000, null]] },
    gpu_util_pct: { 0: [[1790000000, 97]], 1: [[1790000000, 0]] }, gpu_mem_pct: {},
  })
  expect(calls.length).toBe(7)
  expect(calls.every((c) => c.url.endsWith('/api/v1/query_range') && c.step === 15)).toBe(true)
  expect(calls.every((c) => c.query.includes('job="node",instance="gpu01"'))).toBe(true)
  expect(calls[0].end - calls[0].start).toBe(3600)
  expect(calls[0].query).toContain('[60s]')
  expect(Math.abs(calls[0].end - Date.now() / 1000)).toBeLessThan(5) // newest point is "now", not rounded down to the step
  calls = prometheus()
  expect(ok(await get('/api/metrics/hosts/gpu01')).step).toBe(60)
  expect(calls[0].query).toContain('[120s]')
  expect(ok(await get('/api/metrics/hosts/gpu01?range=30d')).step).toBe(7200)
  const n = calls.length
  err(await get('/api/metrics/hosts/gpu01?range=2h'), 400, 'range')
  err(await get('/api/metrics/hosts/gpu01"}or{x="'), 404)
  err(await get('/api/metrics/hosts/nope'), 404)
  expect(calls.length).toBe(n) // request input never reaches Prometheus
})

function gpuSeries() {
  const gpus = ['a', 'b', 'c'].map((c, i) => ({ instance: 'gpu01', uuid: `GPU-${c}`, gpu: String(i) }))
  const s = [vec(1, { __name__: 'up', instance: 'gpu01' }), vec(0, { __name__: 'up', instance: 'gpu03' }), vec(1, { __name__: 'up', instance: 'gpu02' }),
    vec(1, { __name__: 'lab_nvidia_smi_ok', instance: 'gpu01' })]
  const util = [97, 2, 0]
  const used = [2.3e10, 1e8, 2 ** 31] // busy; idle; low util but 2 GiB used
  gpus.forEach((g, i) => {
    s.push(vec(1, { __name__: 'lab_gpu_info', name: 'NVIDIA GeForce RTX 3090', ...g }), vec(util[i], { __name__: 'lab_gpu_utilization_percent', ...g }),
      vec(used[i], { __name__: 'lab_gpu_memory_used_bytes', ...g }))
  })
  return [...s, vec(2.5e10, { __name__: 'lab_gpu_memory_total_bytes', ...gpus[0] }), vec(71, { __name__: 'lab_gpu_temperature_celsius', ...gpus[0] }),
    vec(310.5, { __name__: 'lab_gpu_power_watts', ...gpus[0] }),
    vec(2.2e10, { __name__: 'lab_gpu_process_memory_bytes', user: 'alice', pid: '1234', comm: 'python', ...gpus[0] })]
}

test('GPU board and summary', async () => {
  const con = fresh()
  const three = JSON.stringify({ gpus: [{ index: 0 }, { index: 1 }, { index: 2 }] })
  con.tx(() => {
    con.run("UPDATE hosts SET monitored=1, facts_json=? WHERE name IN ('gpu01', 'gpu03')", three) // gpu03 is down
    con.run("UPDATE hosts SET monitored=1, facts_json=? WHERE name='gpu02'", JSON.stringify({ gpus: [], gpu_pci_count: 0 }))
    for (const [n, a, g, f] of [['gpu04', '192.0.2.14', 'gpu', three], // lspci sees 2 cards, nvidia-smi fails: a real fault
      ['gpu05', '192.0.2.15', 'gpu', three], // not scraped yet
      ['cpu01', '192.0.2.16', 'cpu', null]]) { // never collected, no GPU exporter
      con.run('INSERT INTO hosts(name, address, group_name, monitored, facts_json) VALUES (?, ?, ?, 1, ?)', n, a, g, f)
    }
  })
  login(person(con, 'mem'))
  const series = [
    vec(2e9, { __name__: 'lab_gpu_process_memory_bytes', instance: 'gpu01', uuid: 'GPU-b', gpu: '', user: 'bob', pid: '7', comm: 'python' }),
    vec(1e9, { __name__: 'lab_gpu_process_memory_bytes', instance: 'gpu01', uuid: 'GPU-zzz', gpu: '', user: 'eve', pid: '8', comm: 'python' }),
    ...gpuSeries(), vec(3, { __name__: 'lab_gpu_pci_count', instance: 'gpu01' }),
    vec(0, { __name__: 'lab_gpu_pci_count', instance: 'gpu02' }), vec(0, { __name__: 'lab_nvidia_smi_ok', instance: 'gpu02' }),
    vec(1, { __name__: 'up', instance: 'gpu04' }), vec(2, { __name__: 'lab_gpu_pci_count', instance: 'gpu04' }),
    vec(0, { __name__: 'lab_nvidia_smi_ok', instance: 'gpu04' }), vec(1, { __name__: 'up', instance: 'cpu01' }),
  ]
  const calls = prometheus([['lab_nvidia_smi_ok', series]])
  const d = ok(await get('/api/metrics/gpus'))
  let s = ok(await get('/api/summary'))
  // monitored hosts with GPUs only: CPU-only gpu02 (pci 0) and cpu01 (no pci series, none collected) are left out
  expect(d.hosts.map((h: any) => h.host)).toEqual(['gpu01', 'gpu04', 'gpu05', 'gpu03'])
  expect(d.updated_at.endsWith('+08:00')).toBe(true)
  const h = d.hosts[0]
  expect([h.group, h.up, h.nvidia_ok]).toEqual(['gpu', true, true])
  expect(h.gpus.map((g: any) => [g.index, g.uuid, g.util_pct, g.idle])).toEqual([[0, 'GPU-a', 97, false], [1, 'GPU-b', 2, true], [2, 'GPU-c', 0, false]])
  expect(h.gpus[0]).toEqual({ index: 0, uuid: 'GPU-a', name: 'NVIDIA GeForce RTX 3090', util_pct: 97, mem_used_bytes: 2.3e10,
    mem_total_bytes: 2.5e10, temp_c: 71, power_w: 310.5, idle: false, processes: [{ user: 'alice', pid: 1234, comm: 'python', mem_bytes: 2.2e10 }] })
  expect(h.gpus[1].processes).toEqual([{ user: 'bob', pid: 7, comm: 'python', mem_bytes: 2e9 }])
  expect(d.hosts.slice(1)).toEqual([{ host: 'gpu04', group: 'gpu', up: true, nvidia_ok: false, gpus: [] },
    { host: 'gpu05', group: 'gpu', up: null, nvidia_ok: null, gpus: [] }, { host: 'gpu03', group: 'legacy', up: false, nvidia_ok: null, gpus: [] }])
  // GPU total and idle from the same board; every monitored host that is up counts, GPUs or not
  expect([s.metrics_ok, s.hosts_total, s.hosts_up, s.gpus_total, s.gpus_idle]).toEqual([true, 6, 4, 3, 1])
  expect(calls.length).toBe(2)
  expect(calls.every((c) => c.url.endsWith('/api/v1/query') && c.query.includes('lab_gpu_(info|pci_count|'))).toBe(true)
  prometheus([], { down: true }) // facts (all 12 collected GPUs), idle unknown
  s = ok(await get('/api/summary'))
  expect([s.metrics_ok, s.gpus_total, s.gpus_idle, s.hosts_up]).toEqual([false, 12, null, null])
})

test('disk and my usage', async () => {
  const con = fresh()
  const alice = person(con, 'alice')
  observe(con, 'gpu01', 'alice', 1001)
  observe(con, 'gpu02', 'al', 1001) // her account on gpu02 has another name
  con.tx(() => {
    adopt(con, 'boss', 'gpu01', 'alice', alice)
    adopt(con, 'boss', 'gpu02', 'al', alice)
  })
  login(alice)
  const du = { __name__: 'lab_user_disk_bytes' }
  const disk = [vec(5.1e11, { ...du, instance: 'gpu01', root: '/home', path: '/home/alice', owner: 'alice' }),
    vec(2e11, { ...du, instance: 'gpu02', root: '/data0', path: '/data0/alice', owner: 'alice' }),
    vec(7e11, { ...du, instance: 'gpu01', root: '/home', path: '/home/bob', owner: 'bob' }),
    vec(3e9, { ...du, instance: 'gpu02', root: '/home', path: '/home/al', owner: 'al' }),
    vec(1790000000, { __name__: 'lab_du_success_timestamp_seconds', instance: 'gpu01', root: '/home' })]
  const proc = { __name__: 'lab_gpu_process_memory_bytes', comm: 'python', uuid: 'GPU-a' }
  const procs = [vec(1e9, { ...proc, instance: 'gpu01', gpu: '0', user: 'alice', pid: '11' }),
    vec(2e9, { ...proc, instance: 'gpu02', gpu: '1', user: 'alice', pid: '12' }), // another person's "alice" on gpu02
    vec(3e9, { ...proc, instance: 'gpu02', gpu: '1', user: 'al', pid: '13' })]
  const load = ([['gpu01', 'alice', 'cpu_cores', 1.5], ['gpu01', 'alice', 'memory_bytes', 3e9], ['gpu01', 'alice', 'processes', 4],
    ['gpu02', 'alice', 'cpu_cores', 8], ['gpu02', 'al', 'memory_bytes', 'NaN'], ['gpu01', 'bob', 'cpu_cores', 9]] as [string, string, string, number | string][])
    .map(([i, u, m, v]) => vec(v, { __name__: `lab_user_${m}`, instance: i, user: u }))
  prometheus([['lab_du_success', disk], ['lab_gpu_process_memory_bytes', [...disk.slice(0, 4), ...procs, ...load]]])
  const d = ok(await get('/api/metrics/disk'))
  const u = ok(await get('/api/me/usage'))
  expect(d.owners).toEqual([{ owner: 'alice', bytes: 7.1e11, paths: 2 }, { owner: 'bob', bytes: 7e11, paths: 1 }, { owner: 'al', bytes: 3e9, paths: 1 }])
  expect(d.rows.map((r: any) => r.path)).toEqual(['/home/bob', '/home/alice', '/data0/alice', '/home/al'])
  expect(d.rows[1]).toEqual({ host: 'gpu01', root: '/home', path: '/home/alice', owner: 'alice', bytes: 5.1e11 })
  expect(d.last_scan).toEqual([{ host: 'gpu01', root: '/home', at: '2026-09-21T22:13:20+08:00' }])
  expect(u).toEqual({
    gpu_processes: [{ host: 'gpu01', gpu: 0, pid: 11, comm: 'python', mem_bytes: 1e9 }, { host: 'gpu02', gpu: 1, pid: 13, comm: 'python', mem_bytes: 3e9 }],
    // her accounts only (not the other "alice" on gpu02, not bob); a field procs.py lacks is null
    cpu_mem: [{ host: 'gpu01', cpu_cores: 1.5, mem_bytes: 3e9, processes: 4 }, { host: 'gpu02', cpu_cores: null, mem_bytes: null, processes: null }],
    disk: [{ host: 'gpu01', path: '/home/alice', bytes: 5.1e11 }, { host: 'gpu02', path: '/home/al', bytes: 3e9 }],
  })
})

test('users (CPU / RAM / GPU per user)', async () => {
  const con = fresh()
  con.tx(() => {
    con.run("UPDATE hosts SET monitored=1 WHERE name IN ('gpu01', 'gpu02', 'gpu03')") // gpu02: not scraped yet
    con.run("INSERT INTO hosts(name, address, group_name, monitored) VALUES ('cpu01', '192.0.2.16', 'cpu', 1)")
  })
  login(person(con, 'mem'))
  const GiB = 2 ** 30
  const series = [vec(1, { __name__: 'up', instance: 'gpu01' }), vec(0, { __name__: 'up', instance: 'gpu03' }), vec(1, { __name__: 'up', instance: 'cpu01' }),
    vec(256 * GiB, { __name__: 'node_memory_MemTotal_bytes', instance: 'gpu01' }),
    vec(100 * GiB, { __name__: 'node_memory_MemAvailable_bytes', instance: 'gpu01' }),
    vec(64 * GiB, { __name__: 'node_memory_MemTotal_bytes', instance: 'cpu01' })] // no MemAvailable: used unknown
  for (const [inst, user, cores, mem, n] of [['gpu01', 'alice', 12.5, 150 * GiB, 42], ['gpu01', 'bob', 40, 10 * GiB, 3],
    ['gpu01', 'root', 0.3, 2 * GiB, 150], ['gpu01', 'system', 0.1, GiB, 210], ['cpu01', 'dave', 'NaN', GiB, 1],
    ['old01', 'eve', 99, GiB, 1]] as [string, string, number | string, number, number][]) { // old01: not in the DB
    series.push(vec(cores, { __name__: 'lab_user_cpu_cores', instance: inst, user }), vec(mem, { __name__: 'lab_user_memory_bytes', instance: inst, user }),
      vec(n, { __name__: 'lab_user_processes', instance: inst, user }))
  }
  const gpu = { __name__: 'lab_gpu_process_memory_bytes', instance: 'gpu01', gpu: '0', comm: 'python' }
  series.push(vec(2e9, { ...gpu, uuid: 'GPU-a', user: 'alice', pid: '1' }), vec(1e9, { ...gpu, uuid: 'GPU-a', user: 'alice', pid: '2' }),
    vec(3e9, { ...gpu, uuid: 'GPU-b', user: 'alice', pid: '3' }), vec(5e9, { ...gpu, uuid: 'GPU-c', user: 'carol', pid: '4' })) // a GPU process but no procs.py row
  const answers: [string, unknown][] = [
    ['count by (instance) (node_cpu_seconds_total', [vec(64, { instance: 'gpu01' }), vec(32, { instance: 'cpu01' })]],
    ['(1 - rate(node_cpu_seconds_total', [vec(52.3, { instance: 'gpu01' }), vec(20, { instance: 'cpu01' })]],
    ['node_memory_Mem(Total|Available)_bytes|lab_user_', series],
  ]
  let calls = prometheus(answers)
  const d = ok(await get('/api/metrics/users'))
  expect(d.updated_at.endsWith('+08:00')).toBe(true)
  expect(d.hosts.map((h: any) => h.host)).toEqual(['cpu01', 'gpu01', 'gpu02', 'gpu03'])
  const none = { cpu_cores: null, mem_bytes: null, processes: null }
  const r = (user: string, cores: number | null, mem: number, n: number, gpus = 0, gmem = 0) =>
    ({ user, cpu_cores: cores, mem_bytes: mem, processes: n, gpu_count: gpus, gpu_mem_bytes: gmem })
  const gpu01 = d.hosts[1]
  // heaviest first by the larger share: bob 40/64 CPU > alice 150/256 RAM > root > system > carol (GPU only)
  expect(gpu01).toEqual({ host: 'gpu01', group: 'gpu', up: true, cpu_count: 64, cpu_used_cores: 52.3, mem_total_bytes: 256 * GiB,
    mem_used_bytes: 156 * GiB, users: [r('bob', 40, 10 * GiB, 3), r('alice', 12.5, 150 * GiB, 42, 2, 6e9), r('root', 0.3, 2 * GiB, 150),
      r('system', 0.1, GiB, 210), { user: 'carol', ...none, gpu_count: 1, gpu_mem_bytes: 5e9 }] })
  expect(d.hosts[0]).toEqual({ host: 'cpu01', group: 'cpu', up: true, cpu_count: 32, cpu_used_cores: 20, mem_total_bytes: 64 * GiB,
    mem_used_bytes: null, users: [r('dave', null, GiB, 1)] })
  const empty = { cpu_count: null, cpu_used_cores: null, mem_total_bytes: null, mem_used_bytes: null, users: [] }
  expect(d.hosts.slice(2)).toEqual([{ host: 'gpu02', group: 'gpu', up: null, ...empty }, { host: 'gpu03', group: 'legacy', up: false, ...empty }])
  expect(calls.length).toBe(3)
  expect(calls.every((c) => c.url.endsWith('/api/v1/query') && !c.query.includes('instance='))).toBe(true)
  expect(calls[2].query).toContain('[2m]')

  calls = prometheus(answers) // one host: the same row, queries narrowed to its instance
  expect(ok(await get('/api/metrics/hosts/gpu01/users'))).toEqual(gpu01)
  expect(ok(await get('/api/metrics/hosts/gpu02/users'))).toEqual({ host: 'gpu02', group: 'gpu', up: null, ...empty })
  expect(calls.length).toBe(6)
  expect(calls.every((c) => c.query.includes('job="node",instance="gpu0'))).toBe(true)
  err(await get('/api/metrics/hosts/nope/users'), 404)
  expect(calls.length).toBe(6)
})

test('GPU monthly report', async () => {
  const con = fresh()
  login(person(con, 'mem'))
  const res = [vec(400, { instance: 'gpu01', user: 'alice' }), vec(412.5, { instance: 'gpu02', user: 'alice' }),
    vec(1200, { instance: 'gpu01', user: 'bob' }), vec(0, { instance: 'gpu02', user: 'idle' }), vec(3, { instance: 'gpu01', user: '=HYPERLINK(1)' })]
  let calls = prometheus([['count_over_time', res]])
  const d = ok(await get('/api/metrics/gpu-monthly?month=2026-08'))
  const r = await get('/api/metrics/gpu-monthly.csv?month=2026-08')
  expect(d).toEqual({
    month: '2026-08',
    by_user: [{ user: 'bob', gpu_hours: 1200 }, { user: 'alice', gpu_hours: 812.5 }, { user: '=HYPERLINK(1)', gpu_hours: 3 }],
    by_host: [{ host: 'gpu01', gpu_hours: 1603 }, { host: 'gpu02', gpu_hours: 412.5 }],
    by_user_host: [{ user: 'bob', host: 'gpu01', gpu_hours: 1200 }, { user: 'alice', host: 'gpu02', gpu_hours: 412.5 },
      { user: 'alice', host: 'gpu01', gpu_hours: 400 }, { user: '=HYPERLINK(1)', host: 'gpu01', gpu_hours: 3 }],
  })
  const q = calls[0]
  expect(q.url.endsWith('/api/v1/query')).toBe(true)
  expect(q.time).toBe(new Date(2026, 8, 1).getTime() / 1000)
  expect(q.query).toContain('(count by (instance, uuid, user) (lab_gpu_process_memory_bytes{')
  expect(q.query).toContain('[2678400s:1m]')
  expect(r.headers.get('content-disposition')).toBe('attachment; filename="gpu-monthly-2026-08.csv"')
  expect(r.text.split(/\r\n/).filter(Boolean)).toEqual(['\ufeffuser,host,gpu_hours', 'bob,gpu01,1200.0', 'alice,gpu02,412.5',
    'alice,gpu01,400.0', "'=HYPERLINK(1),gpu01,3.0"])
  calls = prometheus()
  for (const bad of ['2026-13', '2026-8', 'abc', '2026-08-01', '2099-01', '２０２６-０８', '0000-01']) {
    err(await get(`/api/metrics/gpu-monthly?month=${encodeURIComponent(bad)}`), 400, '月份')
    err(await get(`/api/metrics/gpu-monthly.csv?month=${encodeURIComponent(bad)}`), 400)
  }
  expect(calls).toEqual([])
  const last = new Date()
  last.setDate(0)
  expect(ok(await get('/api/metrics/gpu-monthly')).month).toBe(localIso(last).slice(0, 7))
  const thisMonth = ok(await get(`/api/metrics/gpu-monthly?month=${localIso(new Date()).slice(0, 7)}`)) // counts up to now
  expect(thisMonth.by_user).toEqual([])
  expect(Math.abs(calls[calls.length - 1].time - Date.now() / 1000)).toBeLessThan(60)
})

test('fleet', async () => {
  const con = fresh()
  con.tx(() => con.run("UPDATE hosts SET monitored=1 WHERE name IN ('gpu01', 'gpu03')")) // gpu02: in the DB, not monitored
  login(person(con, 'mem'))
  const n = 361
  const step = 60 // 6h
  const s = (values: (number | string | null)[], inst: string) => onGrid(6 * 3600, step, values, { instance: inst })
  const gpu01Gpus = Array.from({ length: n }, (_, i) => (i >= 100 && i < 110 ? null : 4)) // offline for 10 minutes: a gap, not zero
  const calls = prometheus([
    ['count by (instance) (lab_gpu_utilization_percent', [s(gpu01Gpus, 'gpu01'), s(Array(10).fill(2), 'gpu03'), s(Array(n).fill(3), 'gpu02'),
      s(Array(n).fill(8), 'old01')]],
    ['count by (instance) ((lab_gpu_utilization_percent', [s([...Array(200).fill(null), ...Array(161).fill(1)], 'gpu01')]],
    ['sum by (instance) (lab_gpu_utilization_percent', [s(Array(n).fill(200.0), 'gpu01'), s(Array(10).fill(100.0), 'gpu03'),
      s(Array(n).fill(800.0), 'old01')]],
    ['sum by (instance) (1 - rate(node_cpu', [s(Array(n).fill(16.0), 'gpu01'), s(Array(n).fill('NaN'), 'gpu03')]],
    ['count by (instance) (node_cpu', [s(Array(n).fill(64), 'gpu01'), s(Array(n).fill(32), 'gpu03')]],
    ['max by (instance) (up{', [vec(1, { instance: 'gpu01' }), vec(0, { instance: 'gpu03' }), vec(1, { instance: 'gpu02' })]],
  ])
  const d = ok(await get('/api/metrics/fleet?range=6h'))
  expect([d.range, d.step, d.end - d.start]).toEqual(['6h', 60, 6 * 3600])
  expect(d.gpus_busy.length).toBe(n)
  expect(d.gpus_idle.length).toBe(n)
  // gpu02 (not monitored) and old01 (not in the DB) never count; no idle series = 0 idle
  expect([d.gpus_busy[0], d.gpus_idle[0], d.gpus_busy[50], d.gpus_idle[50]]).toEqual([6, 0, 4, 0])
  expect([d.gpus_busy[105], d.gpus_idle[105]]).toEqual([null, null])
  expect([d.gpus_busy[250], d.gpus_idle[250]]).toEqual([3, 1])
  const [gpu, legacy] = d.groups
  expect([gpu.group, gpu.hosts_total, gpu.hosts_up]).toEqual(['gpu', 2, 1])
  expect([gpu.gpu_util[0], gpu.gpu_util[105], gpu.cpu_pct[0]]).toEqual([50, null, 25])
  expect([legacy.group, legacy.hosts_total, legacy.hosts_up]).toEqual(['legacy', 1, 0])
  expect(legacy.gpu_util.slice(0, 11)).toEqual([...Array(10).fill(50), null])
  expect(new Set(legacy.cpu_pct)).toEqual(new Set([null]))
  expect(calls.length).toBe(6)
  expect(calls.some((c) => c.query.includes('instance='))).toBe(false)
  expect(calls.map((c) => c.step)).toEqual([60, 60, 60, 60, 60, undefined])
  expect(calls[3].query).toContain('[120s]')
  expect(calls[1].query).toContain('and on (instance, uuid) (lab_gpu_memory_used_bytes{job="node"} < 1073741824)')
})

test('history sparklines', async () => {
  const con = fresh()
  con.tx(() => con.run("UPDATE hosts SET monitored=1 WHERE name IN ('gpu01', 'gpu03')"))
  login(person(con, 'mem'))
  const util = [...Array(30).fill(97.04), ...Array(5).fill(null), 'NaN', ...Array(25).fill(3)] // a gap and a NaN: both null
  let calls = prometheus([['max by (instance, uuid)', [onGrid(3600, 60, util, { instance: 'gpu01', uuid: 'GPU-a' }),
    onGrid(3600, 60, Array(61).fill(1), { instance: 'gpu02', uuid: 'GPU-z' }), // not monitored
    onGrid(3600, 60, Array(61).fill(1), { instance: 'gpu01' })]]]) // no uuid: dropped
  let d = ok(await get('/api/metrics/history/gpus'))
  expect([d.range, d.step, d.end - d.start]).toEqual(['1h', 60, 3600])
  expect(d.hosts).toEqual({ gpu01: { 'GPU-a': [...Array(30).fill(97), ...Array(6).fill(null), ...Array(25).fill(3)] } })
  expect(calls.length).toBe(1)
  expect(calls[0].url.endsWith('/query_range')).toBe(true)
  expect(calls[0].step).toBe(60)

  calls = prometheus([
    ['node_cpu_seconds_total', [onGrid(21600, 300, Array(73).fill(12.345), { instance: 'gpu01' }),
      onGrid(21600, 300, [...Array(72).fill(null), 80], { instance: 'gpu03' }), onGrid(21600, 300, Array(73).fill(5), { instance: 'old01' })]],
    ['avg by (instance) (lab_gpu_utilization_percent', [onGrid(21600, 300, Array(73).fill(55), { instance: 'gpu01' })]],
  ])
  d = ok(await get('/api/metrics/history/hosts'))
  expect([d.range, d.step]).toEqual(['6h', 300])
  expect(d.hosts).toEqual({ gpu01: { cpu_pct: Array(73).fill(12.3), gpu_util: Array(73).fill(55) },
    gpu03: { cpu_pct: [...Array(72).fill(null), 80], gpu_util: null } })
  expect(calls.length).toBe(2)
  expect(calls[0].query).toContain('[600s]')
  expect(calls.some((c) => c.query.includes('instance='))).toBe(false)
  calls = prometheus()
  expect(ok(await get('/api/metrics/history/hosts?range=24h')).step).toBe(900)
  expect(ok(await get('/api/metrics/history/gpus?range=6h')).hosts).toEqual({})
  const k = calls.length
  for (const url of ['/api/metrics/history/gpus?range=7d', '/api/metrics/history/hosts?range=1m', '/api/metrics/fleet?range=2h',
    '/api/metrics/fleet?range=6h"}or{x="']) {
    err(await get(url), 400, 'range')
  }
  expect(calls.length).toBe(k)
})

test('filesystems and the du trend', async () => {
  const con = fresh()
  con.tx(() => con.run("UPDATE hosts SET monitored=1 WHERE name IN ('gpu01', 'gpu03')"))
  login(person(con, 'mem'))
  const fs = (v: number | string, inst: string, dev: string, mount: string) => vec(v, { instance: inst, device: dev, mountpoint: mount })
  let calls = prometheus([
    ['node_filesystem_size_bytes', [fs(100, 'gpu01', '/dev/sda1', '/'), fs(1000, 'gpu01', '/dev/sdb1', '/srv/home2'),
      fs(1000, 'gpu01', '/dev/sdb1', '/home'), fs('NaN', 'gpu01', '/dev/sdc1', '/data0'), fs(50, 'old01', '/dev/sda1', '/')]],
    ['node_filesystem_free_bytes', [fs(40, 'gpu01', '/dev/sda1', '/'), fs(900, 'gpu01', '/dev/sdb1', '/srv/home2'),
      fs(900, 'gpu01', '/dev/sdb1', '/home'), fs(1, 'gpu01', '/dev/sdc1', '/data0')]],
    ['node_filesystem_avail_bytes', [fs(35, 'gpu01', '/dev/sda1', '/'), fs(850, 'gpu01', '/dev/sdb1', '/srv/home2'),
      fs(850, 'gpu01', '/dev/sdb1', '/home'), fs(1, 'gpu01', '/dev/sdc1', '/data0')]],
  ])
  let d = ok(await get('/api/metrics/disk/filesystems'))
  // the bind mount of /home is listed once; a filesystem without a size is left out; gpu03 has no data yet
  expect(d).toEqual({ hosts: [{ host: 'gpu01', group: 'gpu', filesystems: [
    { mountpoint: '/', device: '/dev/sda1', size_bytes: 100, used_bytes: 60, avail_bytes: 35 },
    { mountpoint: '/home', device: '/dev/sdb1', size_bytes: 1000, used_bytes: 100, avail_bytes: 850 }] },
  { host: 'gpu03', group: 'legacy', filesystems: [] }] })
  expect(calls.length).toBe(3)
  expect(calls.every((c) => c.query.includes('fstype!~"tmpfs|') && !c.query.includes('instance='))).toBe(true)

  const day = 86400
  const du = (values: (number | null)[], inst: string, owner: string) => onGrid(7 * day, day, values, { instance: inst, owner })
  calls = prometheus([['lab_user_disk_bytes', [du([100, null, 102, 103, 104, 105, 106, 107], 'gpu01', 'alice'),
    du([...Array(7).fill(null), 50], 'gpu03', 'alice'), du([...Array(7).fill(null), 500], 'gpu01', 'bob'), // one point: first scan last night
    du(Array(8).fill(1), 'gpu01', 'dave'), du(Array(8).fill(9e9), 'gpu02', 'carol')]]]) // gpu02 is not monitored
  const top = config.trendTop
  config.trendTop = 2
  try {
    d = ok(await get('/api/metrics/disk/trend?days=7'))
  } finally {
    config.trendTop = top
  }
  expect([d.days, d.step, d.end - d.start]).toEqual([7, day, 7 * day])
  expect(d.owners).toEqual([{ owner: 'bob', bytes: [...Array(7).fill(null), 500] }, { owner: 'alice', bytes: [100, null, 102, 103, 104, 105, 106, 157] }])
  expect(calls.length).toBe(1)
  expect(calls[0].query).toContain('last_over_time(lab_user_disk_bytes{')
  expect(calls[0].query).toContain('[2d]')
  calls = prometheus()
  expect(ok(await get('/api/metrics/disk/trend')).days).toBe(30)
  expect(calls[0].step).toBe(day)
  for (const bad of ['6', '91', 'x', '1e3']) err(await get(`/api/metrics/disk/trend?days=${bad}`), 400)
  expect(calls.length).toBe(1)
})

test('Prometheus down', async () => {
  const con = fresh()
  con.tx(() => con.run('UPDATE hosts SET monitored=1'))
  login(person(con, 'mem'))
  for (const broken of [() => prometheus([], { down: true }), () => prometheus([['', 'not a list']])]) {
    const calls = broken()
    expect(ok(await get('/api/hosts')).map((h: any) => h.status)).toEqual([null, null, null])
    const s = ok(await get('/api/summary'))
    expect([s.metrics_ok, s.hosts_up, s.gpus_idle, s.hosts_total]).toEqual([false, null, null, 3])
    for (const url of ['/api/metrics/gpus', '/api/metrics/disk', '/api/metrics/hosts/gpu01', '/api/metrics/gpu-monthly',
      '/api/metrics/gpu-monthly.csv', '/api/me/usage', '/api/metrics/users', '/api/metrics/hosts/gpu01/users', '/api/metrics/fleet',
      '/api/metrics/history/gpus', '/api/metrics/history/hosts', '/api/metrics/disk/filesystems', '/api/metrics/disk/trend']) {
      expect(ok(await get(url), 502), url).toEqual({ error: '監控資料暫時無法取得' })
    }
    expect(calls.length).toBeGreaterThan(0)
  }
})

test('host GPU hours', async () => {
  const con = fresh()
  login(person(con, 'mem'))
  const calls = prometheus([['count_over_time', [vec(12.34, { instance: 'gpu01', user: 'alice' }), vec(0, { instance: 'gpu01', user: 'x' }),
    vec(50, { instance: 'gpu01', user: 'bob' })]]])
  const d = ok(await get('/api/metrics/hosts/gpu01/gpu-hours'))
  expect(d).toEqual({ days: 30, users: [{ user: 'bob', gpu_hours: 50 }, { user: 'alice', gpu_hours: 12.3 }] })
  expect(calls[0].query).toContain('instance="gpu01"')
  expect(calls[0].query).toContain('[2592000s:1m]')
  err(await get('/api/metrics/hosts/nope/gpu-hours'), 404)
})

// --- host health ----------------------------------------------------------------------------

function healthOf(d: any, host: string): Record<string, [string, string]> {
  const h = d.hosts.find((x: any) => x.host === host)
  return Object.fromEntries(h.checks.map((c: any) => [c.key, [c.status, c.detail]]))
}

test('host health', async () => {
  const con: DB = fresh()
  const nowS = Math.floor(Date.now() / 1000)
  const base = { os: 'Ubuntu 22.04.4 LTS', nvidia_driver: '550.54.14', gpu_pci_count: 2, gpus: [{}, {}], apt_update_at: nowS - 3600,
    apt_check_ok: true, reboot_required: false, reboot_pkgs: [], uptime_s: 86400 * 12 }
  const old = { os: 'Ubuntu 20.04.6 LTS', nvidia_driver: '525.147.05', gpu_pci_count: 2, gpus: [{}], apt_update_at: nowS - 40 * 86400,
    apt_check_ok: true, reboot_required: true, reboot_pkgs: ['linux-image-5.15.0-120-generic', 'libc6'], uptime_s: 300 * 86400 }
  con.tx(() => {
    con.run("UPDATE hosts SET monitored=1, facts_json=?, facts_at=? WHERE name='gpu01'", JSON.stringify(base), nowS - 600)
    con.run("UPDATE hosts SET monitored=1, facts_json=?, facts_at=? WHERE name='gpu02'", JSON.stringify(old), nowS - 3 * 86400)
    con.run("INSERT INTO hosts(name, address, group_name, monitored, facts_json, facts_at) VALUES ('gpu04', '192.0.2.14', 'gpu', 0, ?, ?)",
      JSON.stringify({ ...base, apt_check_ok: false }), nowS - 600)
  })
  login(person(con, 'boss', { role: 'admin' }))
  const calls = prometheus([
    ['max by (instance) (up{', [vec(1, { instance: 'gpu01' }), vec(0, { instance: 'gpu02' })]],
    ['predict_linear', [vec(2.5, { instance: 'gpu01', mountpoint: '/' }), vec(40, { instance: 'gpu01', mountpoint: '/data0' })]],
    ['(100 * (1 - node_filesystem_avail_bytes', [vec(90.2, { instance: 'gpu01', mountpoint: '/' }),
      vec(97, { instance: 'gpu01', mountpoint: '/data0' }), vec(10, { instance: 'gpu02', mountpoint: '/' })]],
    ['max by (instance, mountpoint) (node_filesystem_avail_bytes', [vec(7.8e9, { instance: 'gpu01', mountpoint: '/' }),
      vec(3e10, { instance: 'gpu01', mountpoint: '/data0' })]],
    ['lab_smart_healthy|', [vec(1, { __name__: 'lab_smart_healthy', instance: 'gpu01', device: 'sda' }),
      vec(0, { __name__: 'lab_smart_healthy', instance: 'gpu01', device: 'sdb' }), vec(2, { __name__: 'lab_gpu_pci_count', instance: 'gpu01' }),
      vec(1, { __name__: 'lab_gpu_smi_count', instance: 'gpu01' }), vec(1, { __name__: 'lab_nvidia_smi_ok', instance: 'gpu01' })]],
  ])
  let d = ok(await get('/api/admin/health'))
  expect(calls.length).toBe(5)
  expect(calls.some((c) => c.query.includes('instance='))).toBe(false)
  expect([d.metrics_ok, d.fleet_driver]).toEqual([true, '550'])
  expect(d.hosts.map((h: any) => h.host)).toEqual(['gpu01', 'gpu02', 'gpu04', 'gpu03'])
  expect(d.hosts[0].checks.map((c: any) => c.key)).toEqual(Object.keys(HEALTH_LABELS))
  let g1 = healthOf(d, 'gpu01')
  const g2 = healthOf(d, 'gpu02')
  const g3 = healthOf(d, 'gpu03')
  const g4 = healthOf(d, 'gpu04')
  const statuses = (g: Record<string, [string, string]>) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v[0]]))
  expect(statuses(g1)).toEqual({ reachable: 'ok', collect_age: 'ok', apt: 'ok', reboot_required: 'ok', disk_root: 'bad', disk_any: 'bad',
    smart: 'bad', gpu_missing: 'bad', driver_drift: 'ok', os_eol: 'ok' })
  expect(g1.disk_root[1]).toBe('/ 已用 90%，剩 7.8 GB，照目前速度約 2.5 天後寫滿')
  expect(g1.disk_any[1].startsWith('/data0 已用 97%')).toBe(true)
  expect(g1.disk_any[1]).not.toContain('天後寫滿')
  expect(g1.smart[1]).toBe('未通過：sdb')
  expect(g1.gpu_missing[1]).toContain('只看到 1 張')
  expect(statuses(g2)).toEqual({ reachable: 'bad', collect_age: 'warn', apt: 'bad', reboot_required: 'warn', disk_root: 'ok', disk_any: 'ok',
    smart: 'unknown', gpu_missing: 'bad', driver_drift: 'warn', os_eol: 'warn' })
  expect(g2.reboot_required[1]).toContain('linux-image-5.15.0-120-generic、libc6')
  expect(g2.reboot_required[1]).toContain('300 天')
  expect(g2.driver_drift[1]).toBe('525.147.05（多數主機為 550 版）')
  expect(g2.os_eol[1]).toContain('2025-06')
  expect(g2.apt[1]).toContain('37 天') // counted from the collect, not from now
  expect(g3.reachable).toEqual(['unknown', '未監控'])
  expect(g3.collect_age[0]).toBe('bad') // never collected
  expect([g3.apt[0], g3.reboot_required[0], g3.os_eol[0]]).toEqual(['unknown', 'unknown', 'unknown']) // no facts yet
  expect(g4.apt[0]).toBe('bad')
  expect(g4.disk_root).toEqual(['unknown', '未監控'])
  prometheus([], { down: true })
  d = ok(await get('/api/admin/health')) // an outage only blanks the live checks
  expect(d.metrics_ok).toBe(false)
  g1 = healthOf(d, 'gpu01')
  expect(g1.reachable).toEqual(['unknown', '監控資料暫時無法取得'])
  expect(g1.smart).toEqual(['unknown', '監控資料暫時無法取得'])
  expect(g1.apt[0]).toBe('ok')
  expect(g1.gpu_missing).toEqual(['ok', '2 張']) // from the collected facts
  login(person(con, 'mem'))
  err(await get('/api/admin/health'), 403)
  expect(isoOf).toBeTypeOf('function')
})
