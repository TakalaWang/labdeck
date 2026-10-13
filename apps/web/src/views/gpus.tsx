import { useQuery } from '@tanstack/react-query'
import { CircleDashed, Search, ServerOff, TriangleAlert } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import { Link, useSearchParams } from '@/lib/router'

import { RankBarChart } from '@/components/charts'
import { PageHeader, Section } from '@/components/page'
import { Sparkline } from '@/components/sparkline'
import AnimatedToggle from '@/components/smoothui/animated-toggle'
import { EmptyState, ErrorState, SkeletonCards } from '@/components/states'
import { Meter, Pill, StatusDot } from '@/components/status'
import { MoreGpusLink } from '@/components/more-gpus-link'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { fmtBytes, fmtDateTime, fmtRelative } from '@/lib/format'
import type { Gpu, GpuBoard, GpuHistory, GpuHost, Values } from '@/lib/types'
import { cn } from '@/lib/utils'

const shortModel = (n: string) => n.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '')

function users(g: Gpu) {
  const m = new Map<string, { mem: number; procs: string[] }>()
  for (const p of g.processes) {
    const u = m.get(p.user) ?? { mem: 0, procs: [] }
    u.mem += p.mem_bytes
    u.procs.push(`${p.comm} (pid ${p.pid}, ${fmtBytes(p.mem_bytes)})`)
    m.set(p.user, u)
  }
  return [...m.entries()].sort((a, b) => b[1].mem - a[1].mem)
}

// Memoized: TanStack Query's structural sharing keeps unchanged GPU objects
// referentially equal across polls, so only cards whose data changed re-render.
const GpuCard = memo(function GpuCard({ host, gpu, spark }: { host: string; gpu: Gpu; spark: Values | undefined }) {
  const memPct = gpu.mem_total_bytes ? ((gpu.mem_used_bytes ?? 0) * 100) / gpu.mem_total_bytes : null
  const us = users(gpu)
  const idx = gpu.index ?? '?'
  return (
    <li
      data-testid={`gpu-${host}-${gpu.index ?? gpu.uuid}`}
      data-idle={gpu.idle || undefined}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 [contain:layout_paint]',
        gpu.idle && 'border-ok/50 bg-ok-soft',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm">
          <span className="num mr-1.5 font-semibold">#{idx}</span>
          <span className="text-muted-foreground" title={gpu.name}>
            {shortModel(gpu.name)}
          </span>
        </span>
        {gpu.idle && <Pill tone="ok">閒置</Pill>}
      </div>
      <div className="grid grid-cols-[2.5rem_1fr] items-center gap-x-2 gap-y-1.5 text-xs">
        <span className="text-muted-foreground">使用率</span>
        <Meter label={`${host} GPU ${idx} 使用率`} value={gpu.util_pct} tone={gpu.idle ? 'ok' : 'info'} />
        <span className="text-muted-foreground">記憶體</span>
        <Meter
          label={`${host} GPU ${idx} 記憶體`}
          value={memPct}
          tone={gpu.idle ? 'ok' : memPct != null && memPct >= 90 ? 'warn' : 'info'}
          valueText={memPct == null ? '—' : `${Math.round(memPct)}%`}
        />
        <span className="text-muted-foreground">1 小時</span>
        <Sparkline values={spark} label={`${host} GPU ${idx} 使用率`} period="過去 1 小時" color={gpu.idle ? 'var(--ok)' : 'var(--chart-1)'} className="h-5 w-full" />
      </div>
      <div className="num flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {fmtBytes(gpu.mem_used_bytes, 1)} / {fmtBytes(gpu.mem_total_bytes, 0)}
        </span>
        <span>
          <span className={cn(gpu.temp_c != null && gpu.temp_c >= 85 && 'font-medium text-destructive')}>
            {gpu.temp_c != null ? `${Math.round(gpu.temp_c)}°C` : '—'}
          </span>
          {' · '}
          {gpu.power_w != null ? `${Math.round(gpu.power_w)} W` : '—'}
        </span>
      </div>
      <div className="flex min-h-5 flex-wrap gap-1">
        {us.length === 0 ? (
          <span className="text-xs text-muted-foreground">{gpu.idle ? '沒有程序' : '沒有可辨識的程序'}</span>
        ) : (
          us.map(([u, info]) => (
            <Pill key={u} tone="info" title={info.procs.join('\n')}>
              {u}
              <span className="num font-normal opacity-75">{fmtBytes(info.mem, 0)}</span>
            </Pill>
          ))
        )}
      </div>
    </li>
  )
})

const TOP_USERS = 10

/** 每人目前佔用 GPU 張數: distinct cards with a process of the user, plus the GPU memory those processes hold. */
function UserShare({ board }: { board: GpuBoard }) {
  const rows = useMemo(() => {
    const m = new Map<string, { cards: number; mem: number }>()
    for (const h of board.hosts)
      for (const g of h.gpus) {
        const seen = new Set<string>()
        for (const p of g.processes) {
          const u = m.get(p.user) ?? { cards: 0, mem: 0 }
          if (!seen.has(p.user)) u.cards++
          seen.add(p.user)
          u.mem += p.mem_bytes
          m.set(p.user, u)
        }
      }
    return [...m.entries()]
      .map(([user, v]) => ({ user, cards: v.cards, mem: v.mem }))
      .sort((a, b) => b.cards - a.cards || b.mem - a.mem || a.user.localeCompare(b.user))
  }, [board])
  const top = rows.slice(0, TOP_USERS)
  return (
    <Section
      title="每人目前佔用 GPU 張數"
      description={rows.length > TOP_USERS ? `前 ${TOP_USERS} 名（共 ${rows.length} 人）；右側為 GPU 記憶體用量。` : '右側為 GPU 記憶體用量。'}
      className="mb-6"
    >
      {top.length === 0 ? (
        <p className="rounded-lg border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">目前沒有人在使用 GPU。</p>
      ) : (
        <div className="rounded-lg border bg-card p-3" data-testid="gpu-user-share">
          <RankBarChart
            data={top}
            labelKey="user"
            valueKey="cards"
            format={(v) => `${v} 張`}
            valueLabel={(r) => `${r.cards} 張 · ${fmtBytes(Number(r.mem), 0)}`}
            ariaLabel="每人目前佔用 GPU 張數"
          />
        </div>
      )}
    </Section>
  )
}

const NO_DATA = 'flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm text-muted-foreground'

function HostBlock({ h, gpus, history }: { h: GpuHost; gpus: Gpu[]; history: Record<string, Values> | undefined }) {
  const idle = h.gpus.filter((g) => g.idle).length
  return (
    <section aria-labelledby={`gh-${h.host}`} className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusDot state={h.up === null ? 'unknown' : h.up ? 'up' : 'down'} />
        <h2 id={`gh-${h.host}`} className="text-sm font-semibold">
          <Link to={`/hosts/${encodeURIComponent(h.host)}`} className="hover:underline">
            {h.host}
          </Link>
        </h2>
        <Pill tone="muted">{h.group}</Pill>
        {h.up && h.nvidia_ok && (
          <span className="num text-xs text-muted-foreground">
            閒置 {idle} / {h.gpus.length}
          </span>
        )}
      </div>
      {h.up === null ? (
        <p className={NO_DATA}>
          <CircleDashed className="size-4 shrink-0" aria-hidden="true" /> 尚無資料：監控尚未回報這台主機的狀態。
        </p>
      ) : !h.up ? (
        <p className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-crit-soft px-3 py-2 text-sm text-destructive">
          <ServerOff className="size-4 shrink-0" aria-hidden="true" /> 主機離線，無法取得 GPU 狀態。
        </p>
      ) : h.nvidia_ok === null ? (
        <p className={NO_DATA}>
          <CircleDashed className="size-4 shrink-0" aria-hidden="true" /> 尚無資料：GPU 監控尚未回報。
        </p>
      ) : !h.nvidia_ok ? (
        <p className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn-ink">
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" /> nvidia-smi 異常（驅動或 GPU 可能掉卡），資料可能不完整。
        </p>
      ) : null}
      {gpus.length > 0 && (
        <ul className={cn('mt-2 grid grid-cols-[repeat(auto-fill,minmax(13.5rem,1fr))] gap-2', h.up !== true && 'opacity-50')}>
          {gpus.map((g) => (
            <GpuCard key={g.uuid || g.index} host={h.host} gpu={g} spark={history?.[g.uuid]} />
          ))}
        </ul>
      )}
    </section>
  )
}

export default function Gpus() {
  const [params] = useSearchParams()
  const [idleOnly, setIdleOnly] = useState(() => params.get('idle') === '1')
  const [q, setQ] = useState('')
  const query = useQuery({
    queryKey: ['gpus'],
    queryFn: () => api.get<GpuBoard>('/api/metrics/gpus'),
    refetchInterval: 15_000,
  })
  const board = query.data
  // Sparklines: one batched range query for every GPU, refreshed once a minute (the step is 60 s).
  const history = useQuery({
    queryKey: ['gpu-history', '1h'],
    queryFn: () => api.get<GpuHistory>('/api/metrics/history/gpus?range=1h'),
    refetchInterval: 60_000,
  }).data

  const view = useMemo(() => {
    if (!board) return []
    const needle = q.trim().toLowerCase()
    return board.hosts
      .map((h) => {
        let gpus = h.gpus
        if (idleOnly) gpus = gpus.filter((g) => g.idle)
        if (needle && !h.host.toLowerCase().includes(needle)) {
          gpus = gpus.filter(
            (g) => g.name.toLowerCase().includes(needle) || g.processes.some((p) => p.user.toLowerCase().includes(needle)),
          )
          return gpus.length ? { h, gpus } : null
        }
        if (idleOnly && gpus.length === 0) return null
        return { h, gpus }
      })
      .filter((x): x is { h: GpuHost; gpus: Gpu[] } => x !== null)
  }, [board, idleOnly, q])

  const total = board?.hosts.reduce((n, h) => n + h.gpus.length, 0) ?? 0
  const idle = board?.hosts.reduce((n, h) => n + h.gpus.filter((g) => g.idle).length, 0) ?? 0

  return (
    <>
      <PageHeader
        title="GPU 即時看板"
        actions={<MoreGpusLink />}
        description={
          board ? (
            <>
              閒置 <span className="num font-medium text-ok-ink">{idle}</span> / {total} 張 · 更新於{' '}
              <time dateTime={board.updated_at} title={fmtDateTime(board.updated_at)}>
                {fmtRelative(board.updated_at)}
              </time>
              ，每 15 秒自動更新
            </>
          ) : (
            '每 15 秒自動更新'
          )
        }
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              aria-label="搜尋主機、型號或使用者"
              placeholder="搜尋主機、型號或使用者"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-8 pl-8"
            />
          </div>
          <div className="flex items-center gap-2">
            <AnimatedToggle id="idle-only" size="sm" checked={idleOnly} onChange={setIdleOnly} />
            <Label htmlFor="idle-only">只看閒置</Label>
          </div>
        </div>
      </PageHeader>

      {query.isError && board && <ErrorState error={query.error} className="mb-4" />}
      {board && <UserShare board={board} />}
      {!board ? (
        query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <SkeletonCards count={8} />
        )
      ) : view.length === 0 ? (
        <EmptyState title={idleOnly && !q.trim() ? '目前沒有閒置的 GPU' : board.hosts.length === 0 ? '沒有監控中的 GPU 主機' : '沒有符合條件的 GPU'}>
          {board.hosts.length === 0
            ? '管理員為 GPU 主機安裝監控後，這裡會列出每張卡的使用狀況。'
            : q.trim()
              ? `沒有符合「${q.trim()}」的主機、型號或使用者，試著清除搜尋字詞${idleOnly ? '或關閉「只看閒置」' : ''}。`
              : '所有 GPU 都在使用中，稍後再看看，或關閉「只看閒置」。'}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-6">
          {view.map(({ h, gpus }) => (
            <HostBlock key={h.host} h={h} gpus={gpus} history={history?.hosts[h.host]} />
          ))}
        </div>
      )}
    </>
  )
}
