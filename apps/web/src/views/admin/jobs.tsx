import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from '@/lib/router'

import { PageHeader, TableWrap } from '@/components/page'
import AnimatedTabs from '@/components/smoothui/animated-tabs'
import { EmptyState, QueryState, SkeletonRows } from '@/components/states'
import { JobStatusBadge } from '@/components/status'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { fmtDateTime, fmtRelative } from '@/lib/format'
import { JOB_KIND, JOB_LIVE } from '@/lib/labels'
import type { Job } from '@/lib/types'

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '進行中' },
  { id: 'awaiting', label: '待確認' },
  { id: 'failed', label: '失敗' },
]

export default function AdminJobs() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState('all')
  const q = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.get<Job[]>('/api/admin/jobs?limit=100'),
    refetchInterval: (query) => (query.state.data?.some((j) => JOB_LIVE.includes(j.status)) ? 3_000 : 15_000),
  })
  const rows = useMemo(() => {
    const all = q.data ?? []
    if (filter === 'active') return all.filter((j) => JOB_LIVE.includes(j.status))
    if (filter === 'awaiting') return all.filter((j) => j.status === 'awaiting')
    if (filter === 'failed') return all.filter((j) => j.status === 'failed' || j.status === 'check_failed')
    return all
  }, [q.data, filter])
  const awaiting = q.data?.filter((j) => j.status === 'awaiting').length ?? 0

  return (
    <>
      <PageHeader
        title="工作"
        description={awaiting > 0 ? `${awaiting} 個工作等待確認執行` : 'runner 執行的 ansible 工作，最近 100 筆。'}
      >
        <div className="max-w-full self-start overflow-x-auto overflow-y-hidden">
          <AnimatedTabs ariaLabel="工作篩選" variant="pill" tabs={FILTERS} activeTab={filter} onChange={setFilter} />
        </div>
      </PageHeader>
      <QueryState query={q} skeleton={<SkeletonRows rows={10} />}>
        {() =>
          rows.length === 0 ? (
            <EmptyState title="沒有符合的工作" />
          ) : (
            <TableWrap>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">#</TableHead>
                    <TableHead>內容</TableHead>
                    <TableHead>狀態</TableHead>
                    <TableHead>目標主機</TableHead>
                    <TableHead>發起人</TableHead>
                    <TableHead>建立</TableHead>
                    <TableHead>預定執行</TableHead>
                    <TableHead>完成</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((j) => (
                    <TableRow
                      key={j.id}
                      className="cursor-pointer"
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('a,button')) return
                        navigate(`/admin/jobs/${j.id}`)
                      }}
                    >
                      <TableCell className="num">
                        <Link to={`/admin/jobs/${j.id}`} className="font-medium text-primary hover:underline">
                          #{j.id}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-80 truncate" title={`${JOB_KIND[j.kind] ?? j.kind}：${j.summary}`}>
                        {j.summary}
                      </TableCell>
                      <TableCell>
                        <JobStatusBadge status={j.status} testId="job-status" />
                      </TableCell>
                      <TableCell className="max-w-64 truncate" title={j.target_hosts.join(', ')}>
                        {j.target_hosts.length > 3 ? `${j.target_hosts.slice(0, 3).join('、')} 等 ${j.target_hosts.length} 台` : j.target_hosts.join('、') || '全部'}
                      </TableCell>
                      <TableCell>{j.actor ?? 'system'}</TableCell>
                      <TableCell title={fmtDateTime(j.created_at)}>{fmtRelative(j.created_at)}</TableCell>
                      <TableCell>{fmtDateTime(j.run_at)}</TableCell>
                      <TableCell title={fmtDateTime(j.finished_at)}>{j.finished_at ? fmtRelative(j.finished_at) : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableWrap>
          )
        }
      </QueryState>
    </>
  )
}
