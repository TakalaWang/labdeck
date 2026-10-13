import {
  RANGES, SPARK_RANGES, ValueErr, diskTrend, diskUsage, filesystems, fleet, gpuBoard, gpuHistory, gpuHours, gpuMonthly,
  health, hostHistory, hostSeries, isoOf, lastMonth, pyFloatStr, userLoad,
} from '@labdeck/core'
import { admin, member, route } from './app.ts'
import { queryInt, queryStr } from './http.ts'
import { csvResponse, monitored, storedHost } from './views.ts'

// Fixed queries only (core PROMQL): request input never reaches Prometheus.

function rangeArg(rng: string, allowed: Record<string, unknown>): string {
  if (!Object.hasOwn(allowed, rng)) throw new ValueErr(`range 需為 ${Object.keys(allowed).join('、')}`)
  return rng
}

route('GET', '/api/metrics/hosts/{name}', (ctx) => {
  member(ctx)
  const rng = queryStr(ctx.url, 'range', '6h')
  const host = storedHost(ctx.con, ctx.params.name).name as string
  if (!Object.hasOwn(RANGES, rng)) throw new ValueErr('range 需為 1h、6h、24h、7d 或 30d')
  return hostSeries(host, rng)
})

route('GET', '/api/metrics/hosts/{name}/users', async (ctx) => {
  member(ctx)
  const h = storedHost(ctx.con, ctx.params.name)
  return (await userLoad([[h.name, h.group_name]], h.name))[0]
})

route('GET', '/api/metrics/hosts/{name}/gpu-hours', (ctx) => {
  member(ctx)
  return gpuHours(storedHost(ctx.con, ctx.params.name).name, 30)
})

route('GET', '/api/metrics/users', async (ctx) => {
  member(ctx)
  return { updated_at: isoOf(new Date()), hosts: await userLoad(monitored(ctx.con).map(([n, g]) => [n, g])) }
})

route('GET', '/api/metrics/gpus', async (ctx) => {
  member(ctx)
  return { updated_at: isoOf(new Date()), hosts: (await gpuBoard(monitored(ctx.con)))[0] }
})

route('GET', '/api/metrics/fleet', (ctx) => {
  member(ctx)
  const rng = queryStr(ctx.url, 'range', '24h')
  const hosts = ctx.con
    .all('SELECT name, group_name, monitored FROM hosts ORDER BY group_name, name')
    .map((r) => [r.name, r.group_name, Boolean(r.monitored)] as [string, string, boolean])
  return fleet(hosts, rangeArg(rng, RANGES))
})

route('GET', '/api/metrics/history/gpus', (ctx) => {
  member(ctx)
  const rng = queryStr(ctx.url, 'range', '1h')
  return gpuHistory(new Set(monitored(ctx.con).map(([n]) => n)), rangeArg(rng, SPARK_RANGES))
})

route('GET', '/api/metrics/history/hosts', (ctx) => {
  member(ctx)
  const rng = queryStr(ctx.url, 'range', '6h')
  return hostHistory(monitored(ctx.con).map(([n]) => n), rangeArg(rng, SPARK_RANGES))
})

route('GET', '/api/metrics/disk/filesystems', (ctx) => {
  member(ctx)
  return filesystems(monitored(ctx.con).map(([n, g]) => [n, g]))
})

route('GET', '/api/metrics/disk/trend', (ctx) => {
  member(ctx)
  const days = queryInt(ctx.url, 'days', 30)
  if (days < 7n || days > 90n) throw new ValueErr('days 需為 7–90')
  return diskTrend(new Set(monitored(ctx.con).map(([n]) => n)), Number(days))
})

route('GET', '/api/admin/health', (ctx) => {
  admin(ctx)
  return health(ctx.con.all('SELECT * FROM hosts ORDER BY group_name, name'))
})

route('GET', '/api/metrics/disk', (ctx) => {
  member(ctx)
  return diskUsage()
})

route('GET', '/api/metrics/gpu-monthly', (ctx) => {
  member(ctx)
  return gpuMonthly(queryStr(ctx.url, 'month') || lastMonth())
})

route('GET', '/api/metrics/gpu-monthly.csv', async (ctx) => {
  member(ctx)
  const m = await gpuMonthly(queryStr(ctx.url, 'month') || lastMonth())
  return csvResponse(`gpu-monthly-${m.month}.csv`, ['user', 'host', 'gpu_hours'],
    m.by_user_host.map((r) => [r.user, r.host, pyFloatStr(r.gpu_hours)]))
})
