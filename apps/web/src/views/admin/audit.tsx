import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useSearchParams } from '@/lib/router'

import { PageHeader, TableWrap } from '@/components/page'
import { EmptyState, QueryState, SkeletonRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { fmtDateTime } from '@/lib/format'
import { AUDIT_ACTION } from '@/lib/labels'
import type { AuditPage } from '@/lib/types'
import { cn } from '@/lib/utils'

const fmtDetail = (d: AuditPage['rows'][number]['detail']) =>
  Object.entries(d ?? {})
    .map(([k, v]) => `${k}: ${v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')

export default function AdminAudit() {
  const [params, setParams] = useSearchParams()
  const page = Math.max(1, Number(params.get('page')) || 1)
  const q = useQuery({
    queryKey: ['audit', page],
    queryFn: () => api.get<AuditPage>(`/api/admin/audit?page=${page}`),
    placeholderData: keepPreviousData,
  })
  const go = (p: number) => {
    setParams(p === 1 ? {} : { page: String(p) })
    window.scrollTo({ top: 0 })
  }
  const pager = (
    <nav aria-label="分頁" className="flex items-center gap-2">
      <Button variant="outline" size="sm" disabled={page <= 1 || q.isFetching} onClick={() => go(page - 1)}>
        <ChevronLeft /> 較新
      </Button>
      <span className="num text-sm text-muted-foreground" aria-current="page">
        第 {page} 頁
      </span>
      <Button variant="outline" size="sm" disabled={!q.data?.has_more || q.isFetching} onClick={() => go(page + 1)}>
        較舊 <ChevronRight />
      </Button>
    </nav>
  )
  return (
    <>
      <PageHeader title="稽核紀錄" description="所有管理動作與帳號變更，每頁 100 筆，新到舊。" actions={pager} />
      <div className={cn('transition-opacity', q.isPlaceholderData && 'opacity-60')}>
        <QueryState query={q} skeleton={<SkeletonRows rows={12} />}>
          {(d) =>
            d.rows.length === 0 ? (
              <EmptyState title="沒有紀錄" />
            ) : (
              <TableWrap>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-40">時間</TableHead>
                      <TableHead>操作者</TableHead>
                      <TableHead>動作</TableHead>
                      <TableHead>對象</TableHead>
                      <TableHead>細節</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.rows.map((r, i) => (
                      <TableRow key={`${r.ts}-${i}`}>
                        <TableCell className="num text-xs">{fmtDateTime(r.ts)}</TableCell>
                        <TableCell>{r.actor ?? 'system'}</TableCell>
                        <TableCell title={r.action} data-action={r.action}>
                          {AUDIT_ACTION[r.action] ?? <span className="font-mono text-xs">{r.action}</span>}
                        </TableCell>
                        <TableCell>{r.target ?? '—'}</TableCell>
                        <TableCell className="max-w-[32rem] text-xs break-words whitespace-normal text-muted-foreground">{fmtDetail(r.detail)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableWrap>
            )
          }
        </QueryState>
      </div>
      <div className="mt-4 flex justify-end">{pager}</div>
    </>
  )
}
