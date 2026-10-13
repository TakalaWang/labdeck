import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { useMemo } from 'react'
import { useSearchParams } from '@/lib/router'

import { AnimatedNumber } from '@/components/animated-number'
import { RankBarChart } from '@/components/charts'
import { PageHeader, Section, TableWrap } from '@/components/page'
import { EmptyState, QueryState, SkeletonRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { fmtNum, lastMonth } from '@/lib/format'
import type { GpuMonthly } from '@/lib/types'
import { cn } from '@/lib/utils'

const hours = (v: number) => `${fmtNum(v, v < 10 ? 1 : 0)} h`

function shift(month: string, delta: number) {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function RankTable({ rows, keyLabel, total }: { rows: { key: string; gpu_hours: number }[]; keyLabel: string; total: number }) {
  return (
    <TableWrap>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{keyLabel}</TableHead>
            <TableHead className="text-right">GPU 小時</TableHead>
            <TableHead className="text-right">占比</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key}>
              <TableCell className="font-mono">{r.key}</TableCell>
              <TableCell className="num text-right">{hours(r.gpu_hours)}</TableCell>
              <TableCell className="num text-right text-muted-foreground">{total ? `${((r.gpu_hours / total) * 100).toFixed(1)}%` : '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableWrap>
  )
}

function Report({ data, onThisMonth }: { data: GpuMonthly; onThisMonth?: () => void }) {
  const byUser = useMemo(() => [...data.by_user].sort((a, b) => b.gpu_hours - a.gpu_hours), [data.by_user])
  const byHost = useMemo(() => [...data.by_host].sort((a, b) => b.gpu_hours - a.gpu_hours), [data.by_host])
  const detail = useMemo(() => [...data.by_user_host].sort((a, b) => b.gpu_hours - a.gpu_hours), [data.by_user_host])
  const total = byUser.reduce((n, r) => n + r.gpu_hours, 0)

  if (byUser.length === 0 && byHost.length === 0) {
    return (
      <EmptyState title={`${data.month} 沒有 GPU 使用紀錄`}>
        {onThisMonth ? (
          <>
            上個月沒有任何 GPU 使用紀錄（可能是監控在那之後才開始）。
            <Button variant="outline" size="sm" className="mt-3" onClick={onThisMonth} data-testid="monthly-this-month">
              看本月到目前為止
            </Button>
          </>
        ) : (
          '可能是監控資料尚未涵蓋這個月份。'
        )}
      </EmptyState>
    )
  }
  return (
    <>
      <div className="mb-6 flex flex-wrap gap-x-10 gap-y-3 rounded-lg border bg-card px-4 py-3">
        <div>
          <div className="text-xs text-muted-foreground">總 GPU 小時</div>
          <AnimatedNumber value={Math.round(total)} className="text-2xl font-semibold" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">使用者</div>
          <AnimatedNumber value={byUser.length} className="text-2xl font-semibold" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">主機</div>
          <AnimatedNumber value={byHost.length} className="text-2xl font-semibold" />
        </div>
      </div>
      <div className="grid gap-8 xl:grid-cols-2">
        <Section title="依使用者" className="mt-0">
          <div className="mb-3 rounded-lg border bg-card p-3">
            <RankBarChart data={byUser.slice(0, 20)} labelKey="user" valueKey="gpu_hours" format={hours} ariaLabel="各使用者 GPU 小時" />
          </div>
          <RankTable rows={byUser.map((r) => ({ key: r.user, gpu_hours: r.gpu_hours }))} keyLabel="使用者" total={total} />
        </Section>
        <Section title="依主機" className="mt-0">
          <div className="mb-3 rounded-lg border bg-card p-3">
            <RankBarChart
              data={byHost.slice(0, 20)}
              labelKey="host"
              valueKey="gpu_hours"
              format={hours}
              ariaLabel="各主機 GPU 小時"
              color="var(--chart-2)"
            />
          </div>
          <RankTable rows={byHost.map((r) => ({ key: r.host, gpu_hours: r.gpu_hours }))} keyLabel="主機" total={total} />
        </Section>
      </div>
      <Section title="明細（使用者 × 主機）">
        <TableWrap>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>使用者</TableHead>
                <TableHead>主機</TableHead>
                <TableHead className="text-right">GPU 小時</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.map((r) => (
                <TableRow key={`${r.user}:${r.host}`}>
                  <TableCell className="font-mono">{r.user}</TableCell>
                  <TableCell>{r.host}</TableCell>
                  <TableCell className="num text-right">{hours(r.gpu_hours)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableWrap>
      </Section>
    </>
  )
}

export default function GpuMonthlyPage() {
  const [params, setParams] = useSearchParams()
  const month = /^\d{4}-\d{2}$/.test(params.get('month') ?? '') ? params.get('month')! : lastMonth()
  const setMonth = (m: string) => {
    if (!/^\d{4}-\d{2}$/.test(m)) return
    const next = new URLSearchParams(params) // keep ?tab=monthly
    next.set('month', m)
    setParams(next, { replace: true })
  }
  const q = useQuery({
    queryKey: ['gpu-monthly', month],
    queryFn: () => api.get<GpuMonthly>(`/api/metrics/gpu-monthly?month=${month}`),
    placeholderData: keepPreviousData,
    staleTime: 300_000,
  })
  const current = new Date()
  const thisMonth = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`

  return (
    <>
      <PageHeader
        title="GPU 月報"
        description="同一使用者在同一張卡上的多個程序只計一次，每分鐘取樣。"
        actions={
          <Button variant="outline" size="sm" asChild>
            <a href={`/api/metrics/gpu-monthly.csv?month=${month}`} download>
              <Download /> 下載 CSV
            </a>
          </Button>
        }
      >
        <div className="flex items-center gap-2">
          <Label htmlFor="month" className="sr-only">
            月份
          </Label>
          <Button variant="outline" size="icon" aria-label="上個月" onClick={() => setMonth(shift(month, -1))}>
            <ChevronLeft />
          </Button>
          <Input id="month" type="month" value={month} max={thisMonth} onChange={(e) => setMonth(e.target.value)} className="h-8 w-40" />
          <Button variant="outline" size="icon" aria-label="下個月" disabled={month >= thisMonth} onClick={() => setMonth(shift(month, 1))}>
            <ChevronRight />
          </Button>
        </div>
      </PageHeader>
      <div className={cn('transition-opacity', q.isPlaceholderData && 'opacity-60')}>
        <QueryState query={q} skeleton={<SkeletonRows rows={10} />}>
          {(data) => <Report data={data} onThisMonth={data.month === lastMonth() ? () => setMonth(thisMonth) : undefined} />}
        </QueryState>
      </div>
    </>
  )
}
