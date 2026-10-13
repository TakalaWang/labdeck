import { useMutation, useQuery } from '@tanstack/react-query'
import { RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from '@/lib/router'

import { PageHeader, TableWrap } from '@/components/page'
import { RemovePersonDialog } from '@/components/remove-person'
import { SortHead } from '@/components/sort-head'
import { EmptyState, QueryState, SkeletonRows } from '@/components/states'
import { Pill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useJobToast } from '@/hooks/use-job-toast'
import { useSort } from '@/hooks/use-sort'
import { api } from '@/lib/api'
import { daysUntil, fmtDate } from '@/lib/format'
import { ROLE_LABEL, personStatus } from '@/lib/labels'
import type { JobIdMaybe, Person } from '@/lib/types'
import { cn } from '@/lib/utils'
import { PromoteButton } from '@/views/admin/person'

type View = 'current' | 'removed'

function PeopleTable({ people }: { people: Person[] }) {
  const [q, setQ] = useState('')
  const [view, setView] = useState<View>('current')
  const removedCount = people.filter((p) => p.removed_at).length
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    return people.filter(
      (p) => !!p.removed_at === (view === 'removed') &&
        (!n || [p.username, p.name, p.email, p.sso_id].some((v) => (v ?? '').toLowerCase().includes(n))),
    )
  }, [people, q, view])
  const sort = useSort(rows, 'username', 'asc')
  const head = (k: keyof Person & string, label: string, align?: 'right') => (
    <SortHead active={sort.key === k} dir={sort.dir} onClick={() => sort.toggle(k)} align={align}>
      {label}
    </SortHead>
  )
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="人員篩選" className="inline-flex rounded-md bg-muted p-0.5">
          {([['current', '目前成員', people.length - removedCount], ['removed', '已移除', removedCount]] as const).map(([v, label, n]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cn(
                'h-7 rounded-[5px] px-3 text-sm font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                view === v ? 'bg-background text-foreground shadow-xs ring-1 ring-border' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label} <span className="num text-muted-foreground">{n}</span>
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input type="search" aria-label="搜尋人員" placeholder="帳號、姓名、Email 或 SSO ID" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-8" />
        </div>
        <span className="num text-sm text-muted-foreground">{rows.length} 人</span>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={view === 'removed' && !q ? '沒有已移除的人員' : '沒有符合的人員'}>
          {view === 'removed' && !q ? '畢業或離開的成員在人員頁按「移除成員」後會列在這裡，紀錄保留。' : undefined}
        </EmptyState>
      ) : (
        <TableWrap>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {head('username', '帳號')}
                {head('name', '姓名')}
                {head('email', 'Email')}
                {head('role', '角色')}
                {head('status', '狀態')}
                {head('uid', 'UID', 'right')}
                {head('hosts_count', '主機數', 'right')}
                {head('expires_at', '到期')}
                {view === 'removed' ? head('removed_at', '移除日期') : <TableHead className="w-20"><span className="sr-only">移除</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sort.sorted.map((p) => {
                const d = daysUntil(p.expires_at)
                return (
                  <TableRow key={p.id} className={cn(p.status === 'locked' && 'text-muted-foreground')}>
                    <TableCell>
                      <Link to={`/admin/people/${p.id}`} className="font-mono font-medium text-primary hover:underline">
                        {p.username}
                      </Link>
                    </TableCell>
                    <TableCell>{p.name || '—'}</TableCell>
                    <TableCell className="max-w-56 truncate">{p.email || '—'}</TableCell>
                    <TableCell>
                      {p.role === 'admin' ? (
                        <Pill tone="info">{ROLE_LABEL.admin}</Pill>
                      ) : (
                        <span className="flex items-center gap-2">
                          {ROLE_LABEL.member}
                          <PromoteButton p={p} />
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Pill tone={personStatus(p).tone}>{personStatus(p).label}</Pill>
                    </TableCell>
                    <TableCell className="num text-right">{p.uid ?? '—'}</TableCell>
                    <TableCell className="num text-right">{p.hosts_count}</TableCell>
                    <TableCell className={cn(d !== null && d <= 30 && p.status === 'active' && 'font-medium text-warn-ink')}>{fmtDate(p.expires_at)}</TableCell>
                    <TableCell className="text-right">{p.removed_at ? fmtDate(p.removed_at) : <RemovePersonDialog p={p} compact />}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </TableWrap>
      )}
    </>
  )
}

export default function AdminPeople() {
  const jobToast = useJobToast()
  const q = useQuery({ queryKey: ['people'], queryFn: () => api.get<Person[]>('/api/admin/people') })
  const sync = useMutation({ mutationFn: () => api.post<JobIdMaybe>('/api/admin/sync'), onSuccess: (r) => jobToast('同步全部帳號', r.job_id) })
  return (
    <>
      <PageHeader
        title="人員"
        description="實驗室成員與其在各主機上的帳號。畢業或離開的成員用「移除」：各主機帳號鎖定或刪除、清除登入身分，紀錄保留在「已移除」。"
        actions={
          <Button variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
            <RefreshCw className={cn(sync.isPending && 'animate-spin')} /> 同步全部帳號
          </Button>
        }
      />
      <QueryState query={q} skeleton={<SkeletonRows rows={10} />}>
        {(people) => <PeopleTable people={people} />}
      </QueryState>
    </>
  )
}
