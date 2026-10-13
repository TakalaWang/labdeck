import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Download, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from '@/lib/router'

import { HealthSummary } from '@/components/health'
import { MoreGpusLink } from '@/components/more-gpus-link'
import { PageHeader, TableWrap } from '@/components/page'
import { SortHead } from '@/components/sort-head'
import { Sparkline } from '@/components/sparkline'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import { Meter, Pill, StatusDot, type DotState } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useSort } from '@/hooks/use-sort'
import { api } from '@/lib/api'
import { fmtRate } from '@/lib/format'
import { useAccess } from '@/lib/session'
import { cn } from '@/lib/utils'
import type { GpuBoard, HealthBoard, Host, HostHistory } from '@/lib/types'

type Row = {
  name: string
  group: string
  address: string
  state: DotState
  cpu: number | null
  mem: number | null
  disk: number | null
  gpu: number | null
  gpuSummary: string | null
  /** facts were collected at least once (else GPU/disk counts are unknown) */
  collected: boolean
  /** monitored and Prometheus answers, but this host hasn't been scraped yet */
  noData: boolean
  rx: number | null
  tx: number | null
  monitored: boolean
  primary: Host['primary_users']
}

function toRow(h: Host): Row {
  const s = h.status
  return {
    name: h.name,
    group: h.group,
    address: h.address,
    state: !s || s.up === null ? 'unknown' : s.up ? 'up' : 'down',
    cpu: s?.cpu_pct ?? null,
    mem: s?.mem_pct ?? null,
    disk: s?.root_pct ?? null,
    gpu: s?.gpu_util_avg ?? null,
    gpuSummary: h.gpu_summary,
    collected: h.facts_at !== null,
    noData: s !== null && s.up === null,
    rx: s?.net_rx_bps ?? null,
    tx: s?.net_tx_bps ?? null,
    monitored: h.monitored,
    primary: h.primary_users,
  }
}

/**
 * Phones (under sm): one card per host, the number people look for first — free GPUs — up front, then the load.
 */
function HostCard({ r, free }: { r: Row; free: { idle: number; total: number } | undefined }) {
  return (
    <li>
      <Link
        to={`/hosts/${encodeURIComponent(r.name)}`}
        data-testid={`host-card-${r.name}`}
        className="block rounded-lg border bg-card p-3 transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusDot state={r.state} />
              <span className="truncate font-medium">{r.name}</span>
              <Pill tone="muted">{r.group}</Pill>
            </div>
            <p className="mt-0.5 truncate pl-4 text-xs text-muted-foreground">
              {r.gpuSummary || (r.collected ? '無 GPU' : '尚未收集')}
            </p>
          </div>
          {free && free.total > 0 ? (
            <div className="shrink-0 text-right">
              <span className={cn('num text-xl font-semibold', free.idle > 0 ? 'text-ok-ink' : 'text-muted-foreground')}>{free.idle}</span>
              <span className="num text-xs text-muted-foreground"> / {free.total}</span>
              <p className="text-xs text-muted-foreground">張 GPU 空閒</p>
            </div>
          ) : r.gpuSummary ? (
            <p className="shrink-0 text-xs text-muted-foreground">空閒卡數未知</p>
          ) : null}
        </div>
        {r.state === 'up' ? (
          <dl className="mt-3 grid grid-cols-3 gap-3 text-xs">
            {([['CPU', r.cpu], ['記憶體', r.mem], ['根目錄', r.disk]] as const).map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="mb-0.5 text-muted-foreground">{k}</dt>
                <dd>
                  <Meter label={`${r.name} ${k}`} value={v} />
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className={cn('mt-2 text-xs', r.state === 'down' ? 'font-medium text-destructive' : 'text-muted-foreground')}>
            {r.state === 'down' ? '離線（node_exporter 無回應）' : !r.monitored ? '未安裝監控' : r.noData ? '尚無資料' : '無法取得監控資料'}
          </p>
        )}
        {r.primary.length > 0 && (
          <p className="mt-2 truncate text-xs text-muted-foreground">主要使用者：{r.primary.map((u) => u.username).join('、')}</p>
        )}
      </Link>
    </li>
  )
}

const SPARK_PERIOD = '過去 6 小時'
// under the meter, same width as its bar (the value column is w-10 + gap-2); hidden on phones
const SPARK = 'mt-1 hidden h-4 w-[calc(100%-3rem)] sm:block'

export default function Hosts() {
  const { isAdmin } = useAccess()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const group = params.get('group') ?? 'all'
  const [q, setQ] = useState(params.get('q') ?? '')
  const query = useQuery({
    queryKey: ['hosts'],
    queryFn: () => api.get<Host[]>('/api/hosts'),
    refetchInterval: 30_000,
  })
  // Row sparklines: one batched range query for all hosts (5-minute points), refreshed every 5 minutes.
  const history = useQuery({
    queryKey: ['host-history', '6h'],
    queryFn: () => api.get<HostHistory>('/api/metrics/history/hosts?range=6h'),
    refetchInterval: 300_000,
  }).data?.hosts
  // admins: the routine health checks of each host in one column (details on the host page and in 主機管理 → 健康)
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<HealthBoard>('/api/admin/health'),
    enabled: isAdmin,
    refetchInterval: 60_000,
  }).data
  const checksOf = useMemo(() => new Map((health?.hosts ?? []).map((h) => [h.host, h.checks])), [health])
  // free GPUs per host for the phone cards (the GPU board's query, shared with 使用量 → GPU 即時)
  const gpus = useQuery({ queryKey: ['gpus'], queryFn: () => api.get<GpuBoard>('/api/metrics/gpus'), refetchInterval: 30_000 }).data
  const freeOf = useMemo(
    () => new Map((gpus?.hosts ?? []).map((h) => [h.host, { idle: h.gpus.filter((g) => g.idle).length, total: h.gpus.length }])),
    [gpus],
  )

  const groups = useMemo(() => [...new Set((query.data ?? []).map((h) => h.group))].sort(), [query.data])
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (query.data ?? [])
      .filter((h) => group === 'all' || h.group === group)
      .filter(
        (h) =>
          !needle ||
          h.name.toLowerCase().includes(needle) ||
          h.address.toLowerCase().includes(needle) ||
          (h.gpu_summary ?? '').toLowerCase().includes(needle),
      )
      .map(toRow)
  }, [query.data, group, q])
  const sort = useSort(rows, 'name', 'asc')
  const up = rows.filter((r) => r.state === 'up').length

  const setGroup = (g: string) => {
    const next = new URLSearchParams(params)
    if (g === 'all') next.delete('group')
    else next.set('group', g)
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageHeader
        title="主機"
        description={query.data ? `${rows.length} 台，${up} 台在線 · 每 30 秒更新` : '每 30 秒更新'}
        actions={
          <>
            <MoreGpusLink />
            <Button variant="outline" size="sm" asChild>
              <a href="/api/hosts.csv" download>
                <Download /> 匯出 CSV
              </a>
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              aria-label="搜尋主機"
              placeholder="搜尋名稱、位址或 GPU 型號"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-8 pl-8"
            />
          </div>
          <Select value={group} onValueChange={setGroup}>
            <SelectTrigger size="sm" className="w-40" aria-label="群組">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部群組</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g} value={g}>
                  {g}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </PageHeader>

      {query.isError && query.data && <ErrorState error={query.error} className="mb-3" />}
      {!query.data ? (
        query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <SkeletonRows rows={8} />
        )
      ) : rows.length === 0 ? (
        <EmptyState title={query.data.length === 0 ? '尚未新增主機' : '沒有符合條件的主機'}>
          {query.data.length === 0 ? '管理員可在「主機管理」新增主機。' : q.trim() ? '試著清除搜尋字詞或切換群組。' : '試著切換群組。'}
        </EmptyState>
      ) : (
        <>
        <ul className="grid gap-2 sm:hidden" aria-label="主機" data-testid="host-cards">
          {sort.sorted.map((r) => (
            <HostCard key={r.name} r={r} free={freeOf.get(r.name)} />
          ))}
        </ul>
        <TableWrap className="hidden sm:block">
          <Table className="min-w-[1100px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortHead active={sort.key === 'name'} dir={sort.dir} onClick={() => sort.toggle('name')} className="sticky left-0 z-10 bg-muted">
                  主機
                </SortHead>
                <SortHead active={sort.key === 'cpu'} dir={sort.dir} onClick={() => sort.toggle('cpu')} className="w-36">
                  CPU
                </SortHead>
                <SortHead active={sort.key === 'mem'} dir={sort.dir} onClick={() => sort.toggle('mem')} className="w-36">
                  記憶體
                </SortHead>
                <SortHead active={sort.key === 'disk'} dir={sort.dir} onClick={() => sort.toggle('disk')} className="w-36">
                  根目錄
                </SortHead>
                <SortHead active={sort.key === 'gpu'} dir={sort.dir} onClick={() => sort.toggle('gpu')} className="w-52">
                  GPU
                </SortHead>
                <TableHead className="w-36">網路</TableHead>
                {isAdmin && <TableHead className="w-28">健康</TableHead>}
                <TableHead className="w-36">主要使用者</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sort.sorted.map((r) => (
                <TableRow
                  key={r.name}
                  data-testid={`host-row-${r.name}`}
                  className="group cursor-pointer"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('a,button')) return
                    navigate(`/hosts/${encodeURIComponent(r.name)}`)
                  }}
                >
                  <TableCell className="sticky left-0 z-10 bg-card group-hover:bg-muted">
                    <div className="flex items-center gap-2">
                      <StatusDot state={r.state} />
                      <Link to={`/hosts/${encodeURIComponent(r.name)}`} className="font-medium hover:underline focus-visible:underline">
                        {r.name}
                      </Link>
                      <Pill tone="muted" className="hidden sm:inline-flex">{r.group}</Pill>
                    </div>
                    {r.address !== r.name && (
                      <div className="mt-0.5 pl-4 font-mono text-xs text-muted-foreground">{r.address}</div>
                    )}
                  </TableCell>
                  {r.state === 'unknown' ? (
                    <TableCell colSpan={3} className="text-xs text-muted-foreground">
                      {!r.monitored ? '未安裝監控' : r.noData ? '尚無資料' : '無法取得監控資料'}
                    </TableCell>
                  ) : r.state === 'down' ? (
                    <TableCell colSpan={3} className="text-xs font-medium text-destructive">
                      離線（node_exporter 無回應）
                    </TableCell>
                  ) : (
                    <>
                      <TableCell>
                        <Meter label={`${r.name} CPU`} value={r.cpu} />
                        <Sparkline values={history?.[r.name]?.cpu_pct} label={`${r.name} CPU`} period={SPARK_PERIOD} className={SPARK} />
                      </TableCell>
                      <TableCell>
                        <Meter label={`${r.name} 記憶體`} value={r.mem} />
                      </TableCell>
                      <TableCell>
                        <Meter label={`${r.name} 根目錄`} value={r.disk} />
                      </TableCell>
                    </>
                  )}
                  <TableCell>
                    <div className="text-xs">
                      {r.gpuSummary || <span className="text-muted-foreground">{r.collected ? '無 GPU' : '尚未收集'}</span>}
                    </div>
                    {r.gpuSummary && r.state === 'up' && (
                      <>
                        <Meter label={`${r.name} GPU 平均使用率`} value={r.gpu} tone="info" className="mt-1" />
                        {history?.[r.name]?.gpu_util && (
                          <Sparkline values={history[r.name].gpu_util} label={`${r.name} GPU 平均使用率`} period={SPARK_PERIOD} className={SPARK} />
                        )}
                      </>
                    )}
                  </TableCell>
                  <TableCell className="num text-xs">
                    {r.state !== 'up' ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        <span className="inline-flex items-center gap-1">
                          <ArrowDown className="size-3 text-muted-foreground" aria-label="接收" />
                          {fmtRate(r.rx)}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <ArrowUp className="size-3 text-muted-foreground" aria-label="傳送" />
                          {fmtRate(r.tx)}
                        </span>
                      </div>
                    )}
                  </TableCell>
                  {isAdmin && (
                    <TableCell>
                      {checksOf.has(r.name) ? (
                        <HealthSummary host={r.name} checks={checksOf.get(r.name)!} />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="text-xs" title={r.primary.map((u) => u.username).join('、') || undefined}>
                    {r.primary.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <>
                        {r.primary.slice(0, 2).map((u) => u.username).join('、')}
                        {r.primary.length > 2 && <span className="ml-1 text-muted-foreground">+{r.primary.length - 2}</span>}
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableWrap>
        </>
      )}
    </>
  )
}
