// Home page charts, lazily loaded so Recharts stays out of the initial bundle (the home page itself is not code-split).
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { Link } from '@/lib/router'

import { StackedAreaChart, type StackSeries } from '@/components/charts'
import { Section } from '@/components/page'
import { Sparkline } from '@/components/sparkline'
import { ErrorState, SkeletonCards } from '@/components/states'
import { api } from '@/lib/api'
import { fmtPct } from '@/lib/format'
import { summarize } from '@/lib/series'
import type { FleetGroup, FleetHistory } from '@/lib/types'

const PERIOD = '過去 24 小時'

function GroupCard({ g }: { g: FleetGroup }) {
  const gpu = summarize(g.gpu_util)
  const cpu = summarize(g.cpu_pct)
  const row = (label: string, values: typeof g.cpu_pct, s: typeof gpu, color: string, none: string) => (
    <>
      <span className="text-muted-foreground">{label}</span>
      {s ? (
        <Sparkline values={values} label={`${g.group} ${label} 平均使用率`} period={PERIOD} color={color} className="h-6 w-full" />
      ) : (
        <span className="text-muted-foreground">{none}</span>
      )}
      <span className="num w-10 text-right">{s ? fmtPct(s.last) : '—'}</span>
    </>
  )
  return (
    <li>
      <Link
        to={`/hosts?group=${encodeURIComponent(g.group)}`}
        data-testid={`fleet-group-${g.group}`}
        className="flex h-full flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold">{g.group}</span>
          <span className="num text-xs text-muted-foreground">
            在線 <span className="font-medium text-foreground">{g.hosts_up}</span> / {g.hosts_total}
          </span>
        </div>
        <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_2.5rem] items-center gap-x-2 gap-y-1 text-xs">
          {row('GPU', g.gpu_util, gpu, 'var(--chart-1)', '無 GPU')}
          {row('CPU', g.cpu_pct, cpu, 'var(--chart-2)', '無資料')}
        </div>
      </Link>
    </li>
  )
}

export default function FleetOverview() {
  const q = useQuery({
    queryKey: ['fleet', '24h'],
    queryFn: () => api.get<FleetHistory>('/api/metrics/fleet?range=24h'),
    refetchInterval: 60_000,
  })
  const d = q.data
  const series = useMemo<StackSeries[]>(
    () => (d ? [
      { name: '使用中', values: d.gpus_busy, color: 'var(--chart-1)' },
      { name: '閒置', values: d.gpus_idle, color: 'var(--ok)' },
    ] : []),
    [d],
  )
  if (!d) return q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} className="mt-8" /> : <SkeletonCards count={3} className="mt-8 lg:grid-cols-3" />
  return (
    <>
      <Section title="GPU 使用狀況" description="過去 24 小時，每 5 分鐘一點；閒置 = 使用率 < 5% 且記憶體用量 < 1 GiB。" className="mt-8">
        <div className="rounded-lg border bg-card p-3">
          <StackedAreaChart grid={d} series={series} format={(v) => `${Math.round(v)}`} ariaLabel="過去 24 小時使用中與閒置的 GPU 張數" className="h-56" />
        </div>
      </Section>
      <Section title="各群組" description="平均 GPU 與 CPU 使用率（過去 24 小時），右側為最新值。" className="mt-8">
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {d.groups.map((g) => (
            <GroupCard key={g.group} g={g} />
          ))}
        </ul>
      </Section>
    </>
  )
}
