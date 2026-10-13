import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from '@/lib/router'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Section, TableWrap } from '@/components/page'
import { EmptyState, QueryState, SkeletonRows } from '@/components/states'
import { Pill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, errorMessage } from '@/lib/api'
import { fmtDateTime, fmtRelative } from '@/lib/format'
import type { AdoptBulkResult, AdoptConflict, AdoptGroup, AdoptSuggestions as AdoptSuggestionsT } from '@/lib/types'

function Conflicts({ items }: { items: AdoptConflict[] }) {
  if (items.length === 0) return null
  return (
    <Section
      title={`無法批次認領（${items.length}）`}
      description="同名但 UID 不同（不一定是同一人），或 UID 也被別的帳號使用；請到「UID 衝突」逐台確認後單筆認領。"
    >
      <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {items.map((c) => (
          <li key={c.username} className="rounded-lg border border-warn/40 bg-warn-soft/60 p-3 text-sm" data-testid={`adopt-conflict-${c.username}`}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <Link to={`/admin/people?tab=accounts&view=uid&q=${encodeURIComponent(c.username)}`} className="font-mono font-medium hover:underline">
                {c.username}
              </Link>
              <span className="text-xs text-warn-ink">{c.reason}</span>
            </div>
            <ul className="flex flex-wrap gap-1">
              {c.entries.map((e) => (
                <li key={e.host}>
                  <Pill tone="neutral" className="font-mono">
                    {e.host} · {e.uid ?? '—'}
                  </Pill>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** 建議認領: groups of unmanaged same-name, same-uid accounts, adopted in bulk (one person per name). */
export function AdoptSuggestions({ q }: { q: string }) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['adopt-suggestions'],
    queryFn: () => api.get<AdoptSuggestionsT>('/api/admin/accounts/suggestions'),
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState<AdoptBulkResult['errors']>([])
  const needle = q.trim().toLowerCase()
  const groups = useMemo(
    () =>
      (query.data?.groups ?? []).filter(
        (g) => !needle || g.username.includes(needle) || g.hosts.some((h) => h.toLowerCase().includes(needle)),
      ),
    [query.data, needle],
  )
  const conflicts = (query.data?.conflicts ?? []).filter(
    (c) => !needle || c.username.includes(needle) || c.entries.some((e) => e.host.toLowerCase().includes(needle)),
  )
  const chosen = groups.filter((g) => selected.has(g.username))
  const accounts = chosen.reduce((n, g) => n + g.hosts.length, 0)
  const linked = chosen.filter((g) => g.existing_person).length
  const all = groups.length > 0 && chosen.length === groups.length

  const toggle = (g: AdoptGroup, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(g.username)
      else next.delete(g.username)
      return next
    })

  const adopt = async () => {
    let r: AdoptBulkResult
    try {
      r = await api.post<AdoptBulkResult>('/api/admin/accounts/adopt-bulk', {
        items: chosen.map((g) => ({
          username: g.username,
          hosts: g.hosts,
          ...(g.existing_person ? { person_id: g.existing_person.id } : {}),
        })),
      })
    } catch (e) {
      toast.error(errorMessage(e))
      throw e
    }
    const n = r.adopted.reduce((s, a) => s + a.hosts.length, 0)
    if (r.adopted.length) toast.success(`已認領 ${n} 個主機帳號（${r.adopted.length} 位人員）`)
    if (r.errors.length) toast.error(`${r.errors.length} 位未認領，原因列在表格上方`)
    setFailed(r.errors)
    setSelected(new Set())
    void qc.invalidateQueries({ queryKey: ['adopt-suggestions'] })
    void qc.invalidateQueries({ queryKey: ['admin-accounts'] })
    void qc.invalidateQueries({ queryKey: ['people'] })
  }

  return (
    <QueryState query={query} skeleton={<SkeletonRows rows={8} />}>
      {() => (
        <>
          <p className="mb-4 flex gap-2 rounded-lg border bg-accent/40 px-3 py-2 text-sm">
            <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <span>
              以下帳號在所有主機上名稱與 UID 都相同，很可能是同一人，可勾選後批次認領（每個名稱建立或連結同名的既有人員）。
              UID 不一致的列在下方，需逐台處理。
            </span>
          </p>

          {failed.length > 0 && (
            <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-crit-soft px-3 py-2 text-sm">
              <p className="mb-1 font-medium text-destructive">以下帳號未認領：</p>
              <ul className="grid gap-0.5">
                {failed.map((e) => (
                  <li key={e.username}>
                    <span className="font-mono">{e.username}</span>：{e.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {groups.length === 0 ? (
            <EmptyState title="沒有可批次認領的帳號" className="mb-6">
              未認領的帳號都已處理，或都有 UID 衝突。
            </EmptyState>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={all ? true : chosen.length ? 'indeterminate' : false}
                    onCheckedChange={(c) => setSelected(new Set(c === true ? groups.map((g) => g.username) : []))}
                    aria-label="全選"
                  />
                  全選（{groups.length} 組）
                </label>
                <span className="num text-sm text-muted-foreground" data-testid="adopt-selection">
                  已選 {chosen.length} 位、{accounts} 個主機帳號
                </span>
                <ConfirmDialog
                  destructive={false}
                  title="批次認領"
                  confirmLabel={`認領 ${accounts} 個帳號`}
                  description={
                    <div className="grid gap-2">
                      <p>
                        將認領 <b className="num">{accounts}</b> 個主機帳號，對應 <b className="num">{chosen.length}</b> 位人員
                        （新建 {chosen.length - linked} 位{linked ? `、連結同名的既有人員 ${linked} 位` : ''}）。
                      </p>
                      <p>伺服器會逐位重新檢查 UID；不符合的會略過並列出原因，其他照常認領。認領後帳號才會由 portal 管理（到期、鎖定、SSH 金鑰）。</p>
                      <p className="max-h-32 overflow-y-auto font-mono text-xs break-words">{chosen.map((g) => g.username).join('、')}</p>
                    </div>
                  }
                  onConfirm={adopt}
                  trigger={
                    <Button size="sm" disabled={chosen.length === 0}>
                      認領所選
                    </Button>
                  }
                />
              </div>
              <TableWrap className="mb-8">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">
                        <span className="sr-only">選取</span>
                      </TableHead>
                      <TableHead>帳號</TableHead>
                      <TableHead className="text-right">UID</TableHead>
                      <TableHead>主機</TableHead>
                      <TableHead>最後活動</TableHead>
                      <TableHead>人員</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groups.map((g) => (
                      <TableRow key={g.username} data-testid={`adopt-group-${g.username}`} data-state={selected.has(g.username) ? 'selected' : undefined}>
                        <TableCell>
                          <Checkbox
                            checked={selected.has(g.username)}
                            onCheckedChange={(c) => toggle(g, c === true)}
                            aria-label={`選取 ${g.username}`}
                          />
                        </TableCell>
                        <TableCell className="font-mono">{g.username}</TableCell>
                        <TableCell className="num text-right">{g.uid}</TableCell>
                        <TableCell className="max-w-md whitespace-normal">
                          <ul className="flex flex-wrap gap-1">
                            {g.hosts.map((h) => (
                              <li key={h}>
                                <Pill tone="neutral">{h}</Pill>
                              </li>
                            ))}
                          </ul>
                        </TableCell>
                        <TableCell title={fmtDateTime(g.last_active)}>{fmtRelative(g.last_active)}</TableCell>
                        <TableCell>
                          {g.existing_person ? (
                            <span className="text-sm">
                              連結{' '}
                              <Link to={`/admin/people/${g.existing_person.id}`} className="text-primary hover:underline">
                                {g.existing_person.username}
                              </Link>
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground">新建人員</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableWrap>
            </>
          )}
          <Conflicts items={conflicts} />
        </>
      )}
    </QueryState>
  )
}
