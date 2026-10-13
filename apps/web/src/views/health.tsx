import { useQuery } from '@tanstack/react-query'
import { CloudOff } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useSearchParams } from '@/lib/router'

import { HealthCell } from '@/components/health'
import { PageHeader, TableWrap } from '@/components/page'
import AnimatedToggle from '@/components/smoothui/animated-toggle'
import { EmptyState, QueryState, SkeletonRows } from '@/components/states'
import { Pill } from '@/components/status'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { fmtDateTime } from '@/lib/format'
import type { HealthBoard, HealthCheck, HealthKey } from '@/lib/types'
import { cn } from '@/lib/utils'

const problem = (c: HealthCheck) => c.status === 'bad' || c.status === 'warn'

type Summary = { key: HealthKey; label: string; bad: number; warn: number; unknown: number; total: number }

function summarize(board: HealthBoard): Summary[] {
  const out = new Map<HealthKey, Summary>()
  for (const h of board.hosts) {
    for (const c of h.checks) {
      const s = out.get(c.key) ?? { key: c.key, label: c.label, bad: 0, warn: 0, unknown: 0, total: 0 }
      s.total++
      if (c.status === 'bad') s.bad++
      if (c.status === 'warn') s.warn++
      if (c.status === 'unknown') s.unknown++
      out.set(c.key, s)
    }
  }
  return [...out.values()]
}

function SummaryCard({ s, active, onClick }: { s: Summary; active: boolean; onClick: () => void }) {
  const n = s.bad + s.warn
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      data-testid={`health-summary-${s.key}`}
      className={cn(
        'flex min-w-0 flex-col items-start gap-0.5 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        s.bad > 0 && 'border-destructive/40',
        s.bad === 0 && s.warn > 0 && 'border-warn/50',
        active && 'ring-2 ring-primary',
      )}
    >
      <span className="w-full truncate text-xs text-muted-foreground">{s.label}</span>
      {/* 全部正常 only when every host answered: unknown is not ok */}
      <span className={cn('num text-lg font-semibold', s.bad ? 'text-destructive' : s.warn ? 'text-warn-ink' : s.unknown ? 'text-muted-foreground' : 'text-ok-ink')}>
        {n ? `${n} 台` : s.unknown ? `未知 ${s.unknown} 台` : '全部正常'}
      </span>
      <span className="text-xs text-muted-foreground">
        {[s.bad && `${s.bad} 異常`, s.warn && `${s.warn} 注意`, n > 0 && s.unknown && `${s.unknown} 未知`,
          !n && s.unknown && s.total > s.unknown && `${s.total - s.unknown} 台正常`].filter(Boolean).join(' · ') || '\u00a0'}
      </span>
    </button>
  )
}

export default function Health() {
  const [params, setParams] = useSearchParams()
  const problemsOnly = params.get('problems') === '1'
  const focus = params.get('check') as HealthKey | null
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params)
    if (v === null) next.delete(k)
    else next.set(k, v)
    setParams(next, { replace: true })
  }
  const q = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<HealthBoard>('/api/admin/health'),
    refetchInterval: 60_000,
  })
  const summary = useMemo(() => (q.data ? summarize(q.data) : []), [q.data])

  return (
    <>
      <PageHeader
        title="主機健康"
        description="每台主機的例行檢查：連線、資料收集、apt、待重開機、磁碟、SMART、GPU、driver 版本與 OS 支援期。滑鼠移到格子上看細節。"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <AnimatedToggle id="problems-only" size="sm" checked={problemsOnly} onChange={(v) => set('problems', v ? '1' : null)} />
            <Label htmlFor="problems-only">只看有問題的</Label>
          </div>
          {focus && (
            <button type="button" className="text-sm text-primary hover:underline" onClick={() => set('check', null)}>
              清除項目篩選
            </button>
          )}
          {q.data && <span className="text-xs text-muted-foreground">更新於 {fmtDateTime(q.data.updated_at)}</span>}
        </div>
      </PageHeader>

      <QueryState query={q} skeleton={<SkeletonRows rows={10} />}>
        {(board) => {
          const keys = summary.map((s) => s.key)
          const hosts = board.hosts.filter((h) => {
            const checks = focus ? h.checks.filter((c) => c.key === focus) : h.checks
            return !(problemsOnly || focus) || checks.some(problem)
          })
          return (
            <>
              {!board.metrics_ok && (
                <p role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn-ink">
                  <CloudOff className="size-4 shrink-0" aria-hidden="true" />
                  監控資料暫時無法取得：連線、磁碟與 SMART 顯示為未知，其餘依最後一次收集的資料判斷。
                </p>
              )}
              <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" aria-label="各項檢查的問題主機數">
                {summary.map((s) => (
                  <SummaryCard key={s.key} s={s} active={focus === s.key} onClick={() => set('check', focus === s.key ? null : s.key)} />
                ))}
              </div>
              {hosts.length === 0 ? (
                <EmptyState title={board.hosts.length ? '沒有需要處理的主機' : '尚未新增主機'} />
              ) : (
                <TableWrap>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="sticky left-0 z-10">主機</TableHead>
                        {summary.map((s) => (
                          <TableHead key={s.key} className={cn('text-center', focus === s.key && 'text-foreground')}>
                            {s.label}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {hosts.map((h) => {
                        const byKey = new Map(h.checks.map((c) => [c.key, c]))
                        return (
                          <TableRow key={h.host} data-testid={`health-row-${h.host}`}>
                            <TableCell className="sticky left-0 z-10 bg-card">
                              <span className="flex items-center gap-2">
                                <Link to={`/hosts/${encodeURIComponent(h.host)}#health`} className="font-medium hover:underline">
                                  {h.host}
                                </Link>
                                <Pill tone="muted">{h.group}</Pill>
                              </span>
                            </TableCell>
                            {keys.map((k) => {
                              const c = byKey.get(k)
                              return (
                                <TableCell key={k} className="text-center">
                                  {c ? <HealthCell check={c} /> : '—'}
                                </TableCell>
                              )
                            })}
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </TableWrap>
              )}
            </>
          )
        }}
      </QueryState>
    </>
  )
}
