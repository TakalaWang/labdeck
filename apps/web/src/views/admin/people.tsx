import { useMutation, useQuery } from '@tanstack/react-query'
import { RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from '@/lib/router'

import { PageHeader, TableWrap } from '@/components/page'
import { SortHead } from '@/components/sort-head'
import { EmptyState, QueryState, SkeletonRows } from '@/components/states'
import { Pill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table'
import { useJobToast } from '@/hooks/use-job-toast'
import { useSort } from '@/hooks/use-sort'
import { api } from '@/lib/api'
import { daysUntil, fmtDate } from '@/lib/format'
import { PERSON_STATUS_LABEL, ROLE_LABEL } from '@/lib/labels'
import type { JobIdMaybe, Person } from '@/lib/types'
import { cn } from '@/lib/utils'
import { PromoteButton } from '@/views/admin/person'

function PeopleTable({ people }: { people: Person[] }) {
  const [q, setQ] = useState('')
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    return people.filter(
      (p) => !n || [p.username, p.name, p.email, p.sso_id].some((v) => (v ?? '').toLowerCase().includes(n)),
    )
  }, [people, q])
  const sort = useSort(rows, 'username', 'asc')
  const head = (k: keyof Person & string, label: string, align?: 'right') => (
    <SortHead active={sort.key === k} dir={sort.dir} onClick={() => sort.toggle(k)} align={align}>
      {label}
    </SortHead>
  )
  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input type="search" aria-label="搜尋人員" placeholder="帳號、姓名、Email 或 SSO ID" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-8" />
        </div>
        <span className="num text-sm text-muted-foreground">{rows.length} 人</span>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="沒有符合的人員" />
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
                      <Pill tone={p.status === 'active' ? 'ok' : 'muted'}>{PERSON_STATUS_LABEL[p.status]}</Pill>
                    </TableCell>
                    <TableCell className="num text-right">{p.uid ?? '—'}</TableCell>
                    <TableCell className="num text-right">{p.hosts_count}</TableCell>
                    <TableCell className={cn(d !== null && d <= 30 && p.status === 'active' && 'font-medium text-warn-ink')}>{fmtDate(p.expires_at)}</TableCell>
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
        description="實驗室成員與其在各主機上的帳號。"
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
