import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Link, useSearchParams } from '@/lib/router'
import { toast } from 'sonner'

import { PageHeader, TableWrap } from '@/components/page'
import AnimatedTabs from '@/components/smoothui/animated-tabs'
import { EmptyState, QueryState, SkeletonRows } from '@/components/states'
import { Pill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, qs } from '@/lib/api'
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/format'
import { ACCOUNT_IDLE_DAYS, ACCOUNT_TABS, DESIRED_LABEL, type AccountsPageTab } from '@/lib/labels'
import { AdoptSuggestions } from '@/views/admin/adopt-suggestions'
import type { AdminAccountRow, AdminAccounts as AdminAccountsT, Person, UidConflict } from '@/lib/types'
import { cn } from '@/lib/utils'

const NEW = '__new__'

function AdoptDialog({ row }: { row: AdminAccountRow }) {
  const id = useId()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<string>(NEW)
  const people = useQuery({ queryKey: ['people'], queryFn: () => api.get<Person[]>('/api/admin/people'), enabled: open })
  const [defaulted, setDefaulted] = useState(false)
  if (open && people.data && !defaulted) {
    setDefaulted(true)
    const same = people.data.find((p) => p.username === row.username)
    if (same) setChoice(String(same.id))
  }
  const m = useMutation({
    mutationFn: () =>
      api.post<{ person_id: number }>('/api/admin/accounts/adopt', {
        host: row.host,
        username: row.username,
        ...(choice === NEW ? {} : { person_id: Number(choice) }),
      }),
    onSuccess: () => {
      toast.success(`已認領 ${row.host} 上的 ${row.username}`)
      setOpen(false)
      void qc.invalidateQueries({ queryKey: ['admin-accounts'] })
      void qc.invalidateQueries({ queryKey: ['people'] })
    },
  })
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setDefaulted(false)
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          認領
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            認領 <span className="font-mono">{row.username}</span>@{row.host}
          </DialogTitle>
          <DialogDescription>同名帳號在不同主機上不一定是同一人，請逐台確認。UID {row.uid ?? '—'}。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-p`}>連結到</Label>
          <Select value={choice} onValueChange={setChoice}>
            <SelectTrigger id={`${id}-p`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW}>建立新人員「{row.username}」</SelectItem>
              {(people.data ?? []).map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.username}
                  {p.name ? `（${p.name}）` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {people.isPending && <p className="text-xs text-muted-foreground">載入人員清單…</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button disabled={m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? '處理中…' : '認領'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function hostState(a: AdminAccountRow) {
  if (!a.exists) return <Pill tone={a.desired === 'present' ? 'warn' : 'muted'}>不存在</Pill>
  if (a.locked) return <Pill tone={a.desired === 'present' ? 'crit' : 'muted'}>鎖定</Pill>
  return <Pill tone={a.desired === 'locked' ? 'crit' : 'ok'}>正常</Pill>
}

function Conflicts({ items }: { items: UidConflict[] }) {
  if (items.length === 0) return null
  return (
    <div className="mb-6 grid gap-3 md:grid-cols-2">
      {items.map((c) => (
        <div key={`${c.kind}:${c.key}`} className="rounded-lg border border-warn/40 bg-warn-soft/60 p-3">
          <p className="mb-2 text-sm font-medium">
            {c.kind === 'same_name' ? (
              <>
                同名不同 UID：<span className="font-mono">{c.key}</span>
              </>
            ) : (
              <>
                同 UID 不同名：<span className="font-mono">{c.key}</span>
              </>
            )}
          </p>
          <ul className="grid gap-1 text-sm">
            {c.entries.map((e) => (
              <li key={`${e.host}:${e.username}`} className="flex justify-between gap-2">
                <Link to={`/hosts/${encodeURIComponent(e.host)}`} className="hover:underline">
                  {e.host}
                </Link>
                <span className="font-mono">
                  {e.username} · {e.uid ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

export default function AdminAccounts() {
  const [params, setParams] = useSearchParams()
  // ?view= (not ?tab=, which is the 人員與帳號 section's)
  const tab = (ACCOUNT_TABS.some((t) => t.id === params.get('view')) ? params.get('view') : 'all') as AccountsPageTab
  const days = Number(params.get('days')) || ACCOUNT_IDLE_DAYS
  const [q, setQ] = useState(params.get('q') ?? '')
  const [debounced, setDebounced] = useState(q)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300)
    return () => clearTimeout(t)
  }, [q])

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }

  const query = useQuery({
    queryKey: ['admin-accounts', tab, tab === 'idle' ? days : null, debounced],
    queryFn: () =>
      api.get<AdminAccountsT>(`/api/admin/accounts${qs({ tab, days: tab === 'idle' ? days : undefined, q: debounced.trim() })}`),
    placeholderData: keepPreviousData,
    enabled: tab !== 'suggest',
  })

  return (
    <>
      <PageHeader title="主機帳號" description="各主機上實際存在的帳號（UID 1000–65533），與 portal 期望狀態比對。">
        <div className="max-w-full self-start overflow-x-auto overflow-y-hidden">
          <AnimatedTabs
            ariaLabel="帳號分類"
            variant="pill"
            tabs={ACCOUNT_TABS}
            activeTab={tab}
            onChange={(id) => update({ view: id === 'all' ? null : id })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input type="search" aria-label="搜尋帳號或主機" placeholder="帳號或主機" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-8" />
          </div>
          {tab === 'idle' && (
            <label className="flex items-center gap-2 text-sm">
              超過
              <Input
                type="number"
                min={1}
                max={3650}
                value={days}
                onChange={(e) => update({ days: e.target.value || null })}
                className="h-8 w-20"
                aria-label="閒置天數"
              />
              天未活動
            </label>
          )}
          {query.data && tab !== 'suggest' && <span className="num text-sm text-muted-foreground">{query.data.rows.length} 筆</span>}
        </div>
      </PageHeader>

      {tab === 'suggest' ? (
        <AdoptSuggestions q={debounced} />
      ) : (
        <div className={cn('transition-opacity', query.isPlaceholderData && 'opacity-60')}>
          <QueryState query={query} skeleton={<SkeletonRows rows={10} />}>
            {(d) => (
              <>
                {d.tab === 'uid' && <Conflicts items={d.conflicts} />}
                {d.rows.length === 0 ? (
                  <EmptyState title="沒有符合的帳號" />
                ) : (
                  <TableWrap>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>帳號</TableHead>
                          <TableHead>主機</TableHead>
                          <TableHead className="text-right">UID</TableHead>
                          <TableHead className="text-right">預期 UID</TableHead>
                          <TableHead>主機狀態</TableHead>
                          <TableHead>到期</TableHead>
                          <TableHead>最後活動</TableHead>
                          <TableHead>人員</TableHead>
                          <TableHead>期望</TableHead>
                          <TableHead>差異</TableHead>
                          <TableHead>
                            <span className="sr-only">動作</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {d.rows.map((a) => {
                          const uidBad = a.managed && a.exists && a.expected_uid != null && a.uid !== a.expected_uid
                          return (
                            <TableRow key={`${a.host}:${a.username}`} className={cn(!a.exists && 'text-muted-foreground')}>
                              <TableCell className="font-mono">{a.username}</TableCell>
                              <TableCell>
                                <Link to={`/hosts/${encodeURIComponent(a.host)}`} className="hover:underline">
                                  {a.host}
                                </Link>
                              </TableCell>
                              <TableCell className={cn('num text-right', uidBad && 'font-semibold text-destructive')}>{a.uid ?? '—'}</TableCell>
                              <TableCell className="num text-right">{a.expected_uid ?? '—'}</TableCell>
                              <TableCell>{hostState(a)}</TableCell>
                              <TableCell>{fmtDate(a.expires)}</TableCell>
                              <TableCell title={fmtDateTime(a.last_active)}>{fmtRelative(a.last_active)}</TableCell>
                              <TableCell>
                                {a.person ? (
                                  <Link to={`/admin/people/${a.person.id}`} className="text-primary hover:underline">
                                    {a.person.username}
                                  </Link>
                                ) : (
                                  '—'
                                )}
                              </TableCell>
                              <TableCell>{a.managed ? DESIRED_LABEL[a.desired ?? 'present'] : ''}</TableCell>
                              <TableCell className="max-w-64 whitespace-normal">
                                {a.drift.length > 0 && (
                                  <ul className="flex flex-wrap gap-1">
                                    {a.drift.map((x) => (
                                      <li key={x}>
                                        <Pill tone="warn">{x}</Pill>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </TableCell>
                              <TableCell>
                                {a.reserved ? (
                                  <span className="text-xs text-muted-foreground" title="root、bot 與 RESERVED_USERS 的帳號不由 portal 管理">
                                    保留帳號
                                  </span>
                                ) : (
                                  !a.managed && a.exists && <AdoptDialog row={a} />
                                )}
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </TableWrap>
                )}
              </>
            )}
          </QueryState>
        </div>
      )}
    </>
  )
}
