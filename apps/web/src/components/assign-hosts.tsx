import { useQuery } from '@tanstack/react-query'
import { Search, Star } from 'lucide-react'
import { useId, useMemo, useState } from 'react'

import { QueryState, SkeletonCards } from '@/components/states'
import { Pill, StatusDot } from '@/components/status'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { api, qs } from '@/lib/api'
import { fmtBytes, fmtPct } from '@/lib/format'
import type { AssignHost, AssignHosts, Person } from '@/lib/types'
import { cn } from '@/lib/utils'

export type NeedsLike = { gpus: number | null; min_vram_gb: number | null }

/** Enough idle cards now (or cards at all, without live data) with enough memory each. */
export function fits(h: AssignHost, n: NeedsLike | null): boolean {
  if (!n || n.gpus === null) return false
  if (n.gpus === 0) return true
  const cards = h.gpus_free ?? h.gpu_count ?? 0
  return cards >= n.gpus && (!n.min_vram_gb || (h.gpu_vram_gb ?? 0) >= n.min_vram_gb)
}

function HostCard({ h, checked, onChange, match }: { h: AssignHost; checked: boolean; onChange: (on: boolean) => void; match: boolean }) {
  const id = useId()
  const disabled = h.granted || h.blocked !== null
  return (
    <label
      htmlFor={id}
      data-testid={`assign-host-${h.name}`}
      data-blocked={h.blocked !== null || undefined}
      title={h.blocked ? `不能指派：${h.blocked}。請先 bootstrap 這台主機或等它恢復連線。` : h.granted ? '已開通' : undefined}
      className={cn(
        'flex min-w-0 cursor-pointer gap-3 rounded-lg border bg-card p-3 text-sm transition-colors hover:bg-muted/40',
        checked && 'border-primary bg-accent/50 hover:bg-accent/60',
        disabled && 'cursor-not-allowed opacity-60 hover:bg-card',
      )}
    >
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(c) => onChange(c === true)} className="mt-0.5" aria-label={h.name} />
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          {h.monitored && <StatusDot state={h.up === true ? 'up' : h.up === false ? 'down' : 'unknown'} />}
          <span className="font-medium">{h.name}</span>
          <span className="text-xs text-muted-foreground">{h.group}</span>
          {h.granted && <Pill tone="muted">已開通</Pill>}
          {!h.granted && h.blocked === null && match && <Pill tone="ok">符合需求</Pill>}
        </span>
        {h.blocked !== null && !h.granted && (
          <span className="text-xs font-medium text-destructive">未 bootstrap／無法連線，指派會失敗</span>
        )}
        <span className="text-muted-foreground">
          {h.gpu_summary ?? (h.gpu_count === 0 ? '無 GPU' : 'GPU 未知')}
          {h.gpu_vram_gb ? ` · 每張 ${h.gpu_vram_gb} GB` : ''}
        </span>
        <span className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
          <span>
            <span className="text-muted-foreground">空閒卡 </span>
            <span className="num font-medium">{h.gpus_free === null ? '—' : `${h.gpus_free} / ${h.gpu_count ?? '?'}`}</span>
          </span>
          <span>
            <span className="text-muted-foreground">GPU 使用率 </span>
            <span className="num">{fmtPct(h.gpu_util_avg)}</span>
          </span>
          <span>
            <span className="text-muted-foreground">根目錄剩 </span>
            <span className="num">{fmtBytes(h.root_free_bytes, 0)}</span>
          </span>
          <span>
            <span className="text-muted-foreground">資料碟剩 </span>
            <span className="num">{fmtBytes(h.data_free_bytes, 0)}</span>
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="shrink-0">使用者 {h.users} 人</span>
          {h.primary_users.length > 0 && (
            <span className="inline-flex min-w-0 items-center gap-0.5 truncate" title={h.primary_users.map((u) => u.username).join('、')}>
              · <Star className="size-3 shrink-0 fill-warn text-warn" aria-label="主要使用者" />
              <span className="truncate font-mono">{h.primary_users.map((u) => u.username).join('、')}</span>
            </span>
          )}
        </span>
      </span>
    </label>
  )
}

/**
 * Host picker for assignments: hardware, idle cards, users and free disk per host (GET /api/admin/assign-hosts).
 * Hosts that fit `needs` come first; ones the person already has can't be picked.
 */
export function AssignHostPicker({
  personId,
  needs,
  value,
  onChange,
}: {
  personId: number | null
  needs: NeedsLike | null
  value: string[]
  onChange: (hosts: string[]) => void
}) {
  const [q, setQ] = useState('')
  const query = useQuery({
    queryKey: ['assign-hosts', personId],
    queryFn: () => api.get<AssignHosts>(`/api/admin/assign-hosts${qs({ person_id: personId })}`),
    staleTime: 30_000,
  })
  const selected = new Set(value)
  return (
    <QueryState query={query} skeleton={<SkeletonCards count={4} />}>
      {(d) => {
        const needle = q.trim().toLowerCase()
        const list = d.hosts
          .filter((h) => !needle || h.name.toLowerCase().includes(needle) || h.group.toLowerCase().includes(needle)
            || (h.gpu_summary ?? '').toLowerCase().includes(needle))
          .map((h) => ({ h, match: fits(h, needs) }))
          // fitting hosts first, hosts that can't be assigned (never collected / down) last
          .sort((a, b) => Number(a.h.blocked !== null) - Number(b.h.blocked !== null)
            || Number(b.match && !b.h.granted) - Number(a.match && !a.h.granted))
        const toggle = (name: string, on: boolean) => {
          const next = new Set(selected)
          if (on) next.add(name)
          else next.delete(name)
          onChange(d.hosts.filter((h) => next.has(h.name)).map((h) => h.name))
        }
        return (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="relative w-full max-w-xs">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input aria-label="篩選主機" placeholder="篩選主機、群組或 GPU 型號" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-8" />
              </div>
              <span className="text-sm text-muted-foreground">已選 {value.length} 台</span>
              {!d.metrics_ok && <span className="text-xs text-warn-ink">監控資料暫時無法取得：空閒卡與磁碟為「—」</span>}
            </div>
            <div className="grid max-h-[32rem] gap-2 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3" role="group" aria-label="指派的主機">
              {list.map(({ h, match }) => (
                <HostCard key={h.name} h={h} match={match} checked={selected.has(h.name)} onChange={(on) => toggle(h.name, on)} />
              ))}
              {list.length === 0 && <p className="text-sm text-muted-foreground">沒有符合的主機。</p>}
            </div>
          </div>
        )
      }}
    </QueryState>
  )
}

/** Pick one person, searchable by username or name (e.g. people without an SSO ID to link a registration to). */
export function PersonPicker({
  filter,
  value,
  onChange,
  label = '搜尋人員',
}: {
  filter?: (p: Person) => boolean
  value: number | null
  onChange: (id: number | null) => void
  label?: string
}) {
  const id = useId()
  const [q, setQ] = useState('')
  const people = useQuery({ queryKey: ['people'], queryFn: () => api.get<Person[]>('/api/admin/people') })
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (people.data ?? [])
      .filter((p) => (filter ? filter(p) : true))
      .filter((p) => !needle || p.username.includes(needle) || (p.name ?? '').toLowerCase().includes(needle))
  }, [people.data, q, filter])
  const shown = list.slice(0, 8)
  return (
    <div className="grid gap-2">
      <div className="relative max-w-xs">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input id={id} aria-label={label} placeholder="帳號或姓名" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-8" />
      </div>
      {people.isPending ? (
        <p className="text-sm text-muted-foreground">載入中…</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">沒有符合的人員。</p>
      ) : (
        <ul className="grid gap-1 sm:grid-cols-2" role="listbox" aria-label={label}>
          {shown.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                aria-selected={value === p.id}
                onClick={() => onChange(value === p.id ? null : p.id)}
                className={cn(
                  'flex w-full min-w-0 items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/50',
                  value === p.id && 'border-primary bg-accent',
                )}
              >
                <span className="min-w-0 truncate">
                  <span className="font-mono font-medium">{p.username}</span>
                  {p.name && <span className="ml-2 text-muted-foreground">{p.name}</span>}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  目前 {p.hosts_count} 台主機{p.uid != null ? ` · UID ${p.uid}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.length > shown.length && <p className="text-xs text-muted-foreground">還有 {list.length - shown.length} 位，請輸入更多字篩選。</p>}
    </div>
  )
}
