import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, CircleDashed, DatabaseZap, Gauge, Gpu, HardDrive, Star, Trash2, TriangleAlert, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from '@/lib/router'
import { toast } from 'sonner'

import { AddUserToHost, DeleteAccountDialog } from '@/components/account-admin'
import { TimeSeriesChart, type Series } from '@/components/charts'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyBlock } from '@/components/copy-button'
import { HealthList } from '@/components/health'
import { HostForm } from '@/components/host-form'
import { Facts, PageHeader, Section, TableWrap } from '@/components/page'
import { RouteTabs, type TabDef } from '@/components/route-tabs'
import AnimatedTabs from '@/components/smoothui/animated-tabs'
import { EmptyState, ErrorState, QueryState, SkeletonRows } from '@/components/states'
import { Meter, Pill, StatusDot } from '@/components/status'
import { LoadNotice, UserLoadTable } from '@/components/user-load'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useJobToast } from '@/hooks/use-job-toast'
import { api, ApiError } from '@/lib/api'
import { fmtBytes, fmtBytesShort, fmtDateTime, fmtNum, fmtPct, fmtRate, fmtRelative } from '@/lib/format'
import { ACCOUNT_IDLE_DAYS } from '@/lib/labels'
import { useAccess } from '@/lib/session'
import type {
  HealthBoard,
  HostAccount,
  HostDetail as HostDetailT,
  HostGpuHours,
  HostInput,
  HostLoad,
  HostMetrics,
  JobRef,
  Range,
  SeriesMap,
} from '@/lib/types'
import { cn } from '@/lib/utils'

const RANGES: { id: Range; label: string }[] = [
  { id: '1h', label: '1 小時' },
  { id: '6h', label: '6 小時' },
  { id: '24h', label: '24 小時' },
  { id: '7d', label: '7 天' },
  { id: '30d', label: '30 天' },
]

const pct = (v: number) => `${Math.round(v)}%`

const fromMap = (m: SeriesMap, name: (k: string) => string): Series[] =>
  Object.entries(m)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([k, points]) => ({ name: name(k), points }))

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card p-3 sm:p-4">
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      {children}
    </div>
  )
}

type ChartKey = 'cpu' | 'mem' | 'net' | 'disk' | 'gpu' | 'gpuMem'

/** History charts of one host; `show` picks the charts of the current tab. */
function MetricsPanel({ name, monitored, show, id = 'metrics' }: { name: string; monitored: boolean; show: ChartKey[]; id?: string }) {
  const [range, setRange] = useState<Range>('6h')
  const q = useQuery({
    queryKey: ['metrics', name, range],
    queryFn: () => api.get<HostMetrics>(`/api/metrics/hosts/${encodeURIComponent(name)}?range=${range}`),
    enabled: monitored,
    refetchInterval: range === '1h' ? 30_000 : 60_000,
    placeholderData: (prev) => prev,
  })

  const charts = useMemo(() => {
    const m = q.data
    if (!m) return null
    const net: Series[] = [
      ...fromMap(m.net_rx_bps, (k) => `${k} 接收`),
      ...fromMap(m.net_tx_bps, (k) => `${k} 傳送`),
    ]
    return {
      cpu: [{ name: 'CPU', points: m.cpu_pct }],
      mem: [{ name: '記憶體', points: m.mem_pct }],
      net,
      disk: fromMap(m.disk_pct, (k) => k),
      gpu: fromMap(m.gpu_util_pct, (k) => `GPU ${k}`),
      gpuMem: fromMap(m.gpu_mem_pct, (k) => `GPU ${k}`),
    }
  }, [q.data])

  return (
    <Section
      id={id}
      title="歷史圖表"
      actions={
        <AnimatedTabs
          ariaLabel="時間範圍"
          variant="segment"
          tabs={RANGES}
          activeTab={range}
          onChange={(id) => setRange(id as Range)}
          className="max-w-full overflow-x-auto overflow-y-hidden"
        />
      }
    >
      {!monitored ? (
        <EmptyState title="此主機尚未安裝監控" icon={<Activity className="size-6" />}>
          管理員安裝監控後，這裡會顯示歷史資料。
        </EmptyState>
      ) : q.isError && !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !charts ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <SkeletonRows rows={5} />
          <SkeletonRows rows={5} />
        </div>
      ) : (
        <div className={cn('grid gap-3 lg:grid-cols-2 transition-opacity', q.isFetching && q.isPlaceholderData && 'opacity-60')}>
          {show.includes('cpu') && (
            <ChartCard title="CPU 使用率">
              <TimeSeriesChart series={charts.cpu} format={pct} yMax={100} ariaLabel="CPU 使用率" />
            </ChartCard>
          )}
          {show.includes('mem') && (
            <ChartCard title="記憶體使用率">
              <TimeSeriesChart series={charts.mem} format={pct} yMax={100} ariaLabel="記憶體使用率" />
            </ChartCard>
          )}
          {show.includes('net') && (
            <ChartCard title="網路流量">
              <TimeSeriesChart series={charts.net} format={(v) => fmtRate(v)} tickFormat={(v) => `${fmtBytesShort(v)}/s`} ariaLabel="網路流量（bytes/s）" />
            </ChartCard>
          )}
          {show.includes('disk') && (
            <ChartCard title="磁碟使用率（各掛載點）">
              <TimeSeriesChart series={charts.disk} format={pct} yMax={100} ariaLabel="磁碟使用率" />
            </ChartCard>
          )}
          {show.includes('gpu') && charts.gpu.length > 0 && (
            <ChartCard title="GPU 使用率（各卡）">
              <TimeSeriesChart series={charts.gpu} format={pct} yMax={100} ariaLabel="GPU 使用率" />
            </ChartCard>
          )}
          {show.includes('gpuMem') && charts.gpuMem.length > 0 && (
            <ChartCard title="GPU 記憶體使用率（各卡）">
              <TimeSeriesChart series={charts.gpuMem} format={pct} yMax={100} ariaLabel="GPU 記憶體使用率" />
            </ChartCard>
          )}
        </div>
      )}
    </Section>
  )
}

/** Who is using this host right now (per-user CPU, RAM and GPUs). */
function UsersPanel({ name }: { name: string }) {
  const q = useQuery({
    queryKey: ['host-users', name],
    queryFn: () => api.get<HostLoad>(`/api/metrics/hosts/${encodeURIComponent(name)}/users`),
    refetchInterval: 30_000,
  })
  return (
    <Section
      id="users"
      title="使用者用量"
      description="目前各使用者的 CPU、記憶體與 GPU，每 30 秒更新；超過主機一半 CPU 或記憶體者以黃色標示。"
      actions={
        <Link to="/usage?tab=cpu" className="text-sm text-primary hover:underline">
          所有主機
        </Link>
      }
    >
      <QueryState query={q} skeleton={<SkeletonRows rows={4} />}>
        {(h) =>
          h.users.length === 0 ? (
            <LoadNotice h={h} />
          ) : (
            <TableWrap>
              <UserLoadTable host={h} users={h.users} />
            </TableWrap>
          )
        }
      </QueryState>
    </Section>
  )
}

/**
 * 活躍／閒置（同「主機帳號」的閒置天數）／鎖定, plus (admins only) the portal's own states of accounts not (yet) on the
 * host or to be deleted there.
 */
function accountState(a: HostAccount, isAdmin = true) {
  if (!isAdmin) {
    if (a.locked || a.desired === 'locked') return <Pill tone="muted">鎖定</Pill>
    const quiet = !a.last_active || Date.now() - new Date(a.last_active).getTime() > ACCOUNT_IDLE_DAYS * 86_400_000
    return quiet ? <Pill tone="muted">閒置</Pill> : <Pill tone="ok">活躍</Pill>
  }
  if (a.desired === 'absent') return <Pill tone={a.exists ? 'warn' : 'muted'}>{a.exists ? '待刪除' : '已刪除'}</Pill>
  if (!a.exists) return <Pill tone={a.desired === 'present' ? 'warn' : 'muted'}>{a.desired === 'present' ? '待建立' : '不存在'}</Pill>
  if (a.locked || a.desired === 'locked') return <Pill tone={a.desired === 'present' ? 'crit' : 'muted'}>鎖定</Pill>
  const idle = !a.last_active || Date.now() - new Date(a.last_active).getTime() > ACCOUNT_IDLE_DAYS * 86_400_000
  return idle ? <Pill tone="muted">閒置</Pill> : <Pill tone="ok">活躍</Pill>
}

function PrimaryStar({ host, a }: { host: string; a: HostAccount }) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: (primary: boolean) =>
      api.put(`/api/admin/hosts/${encodeURIComponent(host)}/accounts/${encodeURIComponent(a.username)}/primary`, { primary }),
    onSuccess: (_, primary) => {
      toast.success(primary ? `已將 ${a.username} 設為主要使用者` : `已取消 ${a.username} 的主要使用者`)
      void qc.invalidateQueries({ queryKey: ['host', host] })
      void qc.invalidateQueries({ queryKey: ['hosts'] })
    },
  })
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      aria-pressed={a.primary}
      aria-label={a.primary ? `取消 ${a.username} 的主要使用者` : `將 ${a.username} 設為主要使用者`}
      title={a.primary ? '取消主要使用者' : '設為主要使用者'}
      disabled={m.isPending}
      onClick={() => m.mutate(!a.primary)}
    >
      <Star className={cn('size-4', a.primary ? 'fill-warn text-warn' : 'text-muted-foreground')} />
    </Button>
  )
}

/** 使用者: primary users first, then every other account by last activity. */
function AccountsSection({ host, isAdmin }: { host: HostDetailT; isAdmin: boolean }) {
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: ['host', host.name] })
  const assigned = new Set(host.accounts.filter((a) => a.managed && a.desired === 'present' && a.person).map((a) => a.person!.id))
  // members see the accounts that are on the host, not the portal's internal states (待建立、待刪除、未認領)
  const accounts = isAdmin ? host.accounts : host.accounts.filter((a) => a.exists)
  const gpu = useQuery({
    queryKey: ['host-gpu-hours', host.name],
    queryFn: () => api.get<HostGpuHours>(`/api/metrics/hosts/${encodeURIComponent(host.name)}/gpu-hours`),
    enabled: host.monitored,
    staleTime: 10 * 60_000,
  })
  const hours = new Map(gpu.data?.users.map((u) => [u.user, u.gpu_hours]))
  const primary = accounts.filter((a) => a.primary)
  const others = accounts
    .filter((a) => !a.primary)
    .sort((x, y) => (y.last_active ?? '').localeCompare(x.last_active ?? '') || x.username.localeCompare(y.username))
  const gpuText = (u: string) => (gpu.data ? (hours.has(u) ? `${fmtNum(hours.get(u), 1)} h` : '—') : '—')
  return (
    <Section
      id="accounts"
      title={`使用者（${accounts.length}）`}
      description={`狀態：${ACCOUNT_IDLE_DAYS} 天以上沒有登入或活動為「閒置」。${isAdmin ? '按星號設定主要使用者。' : ''}`}
      actions={isAdmin ? <AddUserToHost host={host.name} existing={assigned} onDone={refresh} /> : undefined}
    >
      {accounts.length === 0 ? (
        <EmptyState title="沒有帳號資料" className="py-6">
          收集資料後會列出 UID 1000–65533 的帳號。
        </EmptyState>
      ) : (
        <div className="grid gap-4">
          <div>
            <h3 className="mb-2 text-sm font-medium">主要使用者</h3>
            {primary.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
                尚未設定主要使用者{isAdmin ? '，在下方帳號列表按星號設定。' : '。'}
              </p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid="primary-users">
                {primary.map((a) => (
                  <li key={a.username} className="flex items-start justify-between gap-2 rounded-lg border bg-card p-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono font-medium">{a.username}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        <span>{a.person?.name || '—'}</span>
                        {a.person?.discord_name && <span> · Discord @{a.person.discord_name}</span>}
                      </p>
                      <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {accountState(a, isAdmin)}
                        <span title={fmtDateTime(a.last_active)}>最後登入 {fmtRelative(a.last_active)}</span>
                        {host.monitored && <span>· GPU {gpuText(a.username)}</span>}
                      </p>
                    </div>
                    {isAdmin && <PrimaryStar host={host.name} a={a} />}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {others.length > 0 && (
            <TableWrap>
              <Table>
                <TableHeader>
                  <TableRow>
                    {isAdmin && (
                      <TableHead className="w-10">
                        <span className="sr-only">主要使用者</span>
                      </TableHead>
                    )}
                    {isAdmin && <TableHead>姓名</TableHead>}
                    <TableHead>帳號</TableHead>
                    <TableHead>最後登入</TableHead>
                    {host.monitored && <TableHead className="text-right">近 30 天 GPU 用量</TableHead>}
                    <TableHead>狀態</TableHead>
                    {isAdmin && (
                      <TableHead className="w-10">
                        <span className="sr-only">刪除</span>
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {others.map((ac) => (
                    <TableRow key={ac.username} className={cn(!ac.exists && 'text-muted-foreground')}>
                      {isAdmin && <TableCell>{ac.managed && <PrimaryStar host={host.name} a={ac} />}</TableCell>}
                      {isAdmin && (
                        <TableCell>
                          {ac.person ? (
                            <Link to={`/admin/people/${ac.person.id}`} className="text-primary hover:underline">
                              {ac.person.name || ac.person.username}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">{ac.reserved ? '保留帳號' : '未認領'}</span>
                          )}
                        </TableCell>
                      )}
                      <TableCell className="font-mono">{ac.username}</TableCell>
                      <TableCell title={fmtDateTime(ac.last_active)}>{fmtRelative(ac.last_active)}</TableCell>
                      {host.monitored && <TableCell className="num text-right">{gpuText(ac.username)}</TableCell>}
                      <TableCell>{accountState(ac, isAdmin)}</TableCell>
                      {isAdmin && (
                        <TableCell>
                          {ac.exists && ac.desired !== 'absent' && !ac.reserved && <DeleteAccountDialog host={host.name} username={ac.username} onDone={refresh} />}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableWrap>
          )}
        </div>
      )}
    </Section>
  )
}

function AdminPanel({ host }: { host: HostDetailT }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const jobToast = useJobToast()
  const name = host.name
  const path = `/api/admin/hosts/${encodeURIComponent(name)}`
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['host', name] })
    void qc.invalidateQueries({ queryKey: ['hosts'] })
  }

  const save = useMutation({
    mutationFn: (input: HostInput) => api.put(path, input),
    onSuccess: () => {
      toast.success('已儲存主機設定')
      refresh()
    },
  })
  const agents = useMutation({
    mutationFn: () => api.post<JobRef>(`${path}/agents`),
    onSuccess: (r) => jobToast('安裝/更新監控', r.job_id),
  })
  const collect = useMutation({
    mutationFn: () => api.post<JobRef>(`${path}/collect`),
    onSuccess: (r) => jobToast('收集資料', r.job_id),
  })
  const del = useMutation({
    mutationFn: () => api.del(path, { confirm: name }),
    onSuccess: () => {
      toast.success(`已刪除主機 ${name}`)
      void qc.invalidateQueries({ queryKey: ['hosts'] })
      navigate('/admin/hosts?tab=hosts')
    },
  })
  // Same rule as the backend: every managed account revoked (desired locked) and locked or gone on the host, or deleted.
  const blocking = host.accounts.filter(
    (a) => a.managed && !(a.desired === 'locked' && (!a.exists || a.locked)) && !(a.desired === 'absent' && !a.exists),
  )
  const blockedHint = `撤銷並同步後才能刪除：${blocking.map((a) => a.username).join('、')} 仍未在主機上停用`

  return (
    <Section id="admin" title="管理" description="僅管理員可見。" className="rounded-xl border border-dashed p-4 sm:p-5">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={agents.isPending} onClick={() => agents.mutate()}>
          <Activity /> 安裝/更新監控
        </Button>
        <Button variant="outline" disabled={collect.isPending} onClick={() => collect.mutate()}>
          <DatabaseZap /> 收集資料
        </Button>
      </div>

      {host.bootstrap_command && (
        <div className="mt-5">
          <h3 className="mb-1 text-sm font-medium">Bootstrap 指令</h3>
          <p className="mb-2 text-sm text-muted-foreground">
            新主機需先 bootstrap（建立 bot 帳號、寫入 known_hosts），才能安裝監控與收集資料。請由網管在<strong>監控主機</strong>的 repo
            目錄內執行，並自行替換角括號內的值。
          </p>
          <CopyBlock text={host.bootstrap_command} label="複製 bootstrap 指令" />
        </div>
      )}

      <div className="mt-6 scroll-mt-20" id="host-edit">
        <h3 className="mb-3 text-sm font-medium">編輯主機</h3>
        <HostForm host={host} submitLabel="儲存" onSubmit={(input) => save.mutateAsync(input)} />
      </div>

      <div className="mt-6 flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm">
          <h3 className="font-medium">刪除主機</h3>
          <p className="text-muted-foreground" data-testid="host-delete-hint">
            {blocking.length > 0
              ? `此主機有 ${blocking.length} 個受管帳號尚未停用（${blocking.map((a) => a.username).join('、')}），需先在人員頁撤銷開通並同步，等主機上已鎖定後才能刪除。`
              : '只刪除 portal 內的紀錄（登入紀錄與稽核保留），不會動到主機本身。'}
          </p>
        </div>
        {/* a disabled button gets no pointer events: the tooltip sits on its wrapper */}
        <span title={blocking.length > 0 ? blockedHint : undefined} className="inline-flex">
          <ConfirmDialog
            trigger={
              <Button variant="destructive" disabled={blocking.length > 0}>
                <Trash2 /> 刪除
              </Button>
            }
            title={`刪除主機 ${name}？`}
            description="此動作無法復原。主機會從清冊與 Prometheus 抓取目標中移除。"
            expected={name}
            confirmLabel="刪除"
            onConfirm={() => del.mutateAsync()}
          />
        </span>
      </div>
    </Section>
  )
}

/** The /health checks of one host (admins; the same query as the 主機健康 page). */
function HealthSection({ name, className }: { name: string; className?: string }) {
  const q = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<HealthBoard>('/api/admin/health'),
    refetchInterval: 60_000,
  })
  const checks = q.data?.hosts.find((h) => h.host === name)?.checks
  return (
    <Section
      id="health"
      className={className}
      title="健康"
      description={
        <>
          例行檢查；全部主機的對照見{' '}
          <Link to="/admin/hosts?tab=health" className="text-primary hover:underline">
            主機管理 → 健康
          </Link>
          。
        </>
      }
    >
      <div className="rounded-lg border bg-card p-4">
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <SkeletonRows rows={4} />
        ) : !checks ? (
          <p className="text-sm text-muted-foreground">沒有這台主機的檢查結果。</p>
        ) : (
          <HealthList checks={checks} />
        )}
      </div>
    </Section>
  )
}

const TABS: TabDef[] = [
  { id: 'overview', label: '概況', icon: Gauge },
  { id: 'gpu', label: 'GPU', icon: Gpu },
  { id: 'users', label: '使用者', icon: Users },
  { id: 'disk', label: '磁碟', icon: HardDrive },
]

/** The live numbers of a monitored host. */
function StatusStrip({ s }: { s: NonNullable<HostDetailT['status']> }) {
  return (
    <div className="mb-6 grid gap-x-6 gap-y-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5">
      {s.up === false && (
        <p className="flex items-center gap-2 text-sm font-medium text-destructive sm:col-span-2 lg:col-span-5">
          <TriangleAlert className="size-4" aria-hidden="true" /> 主機目前離線（node_exporter 無回應）
        </p>
      )}
      {s.up === null && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground sm:col-span-2 lg:col-span-5">
          <CircleDashed className="size-4" aria-hidden="true" /> 尚無資料：監控尚未回報這台主機的狀態。
        </p>
      )}
      {(
        [
          ['CPU', s.cpu_pct],
          ['記憶體', s.mem_pct],
          ['根目錄', s.root_pct],
          ['GPU 平均', s.gpu_util_avg],
        ] as const
      ).map(([label, v]) => (
        <div key={label}>
          <div className="mb-1 text-xs text-muted-foreground">{label}</div>
          <Meter label={label} value={v} tone={label === 'GPU 平均' ? 'info' : undefined} />
        </div>
      ))}
      <div>
        <div className="mb-1 text-xs text-muted-foreground">網路</div>
        <div className="num text-xs">
          ↓ {fmtRate(s.net_rx_bps)} · ↑ {fmtRate(s.net_tx_bps)}
        </div>
      </div>
    </div>
  )
}

function Overview({ h, isAdmin }: { h: HostDetailT; isAdmin: boolean }) {
  const gpuMismatch = h.gpu_pci_count != null && h.gpu_count != null && h.gpu_pci_count !== h.gpu_count
  // admins see every field (blank ones as —); members only what is filled in
  const place = [h.room, h.rack, h.psu && `PSU ${h.psu}`].filter(Boolean).join(' / ')
  const optional: [string, React.ReactNode][] = isAdmin
    ? [
        ['位置', `${h.room || '—'} / ${h.rack || '—'} · PSU ${h.psu || '—'}`],
        ['備註', <span key="notes" className="whitespace-pre-wrap">{h.notes || '—'}</span>],
      ]
    : [
        ...(place ? ([['位置', place]] as [string, React.ReactNode][]) : []),
        ...(h.notes ? ([['備註', <span key="notes" className="whitespace-pre-wrap">{h.notes}</span>]] as [string, React.ReactNode][]) : []),
      ]
  return (
    <>
      {h.status && <StatusStrip s={h.status} />}
      <div className={cn('grid gap-8', isAdmin && 'xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]')}>
        <Section title="規格" className={cn(!isAdmin && 'max-w-3xl')}>
          <Facts
            className="rounded-lg border bg-card p-4"
            items={[
              ['OS', [h.os, h.kernel].filter(Boolean).join(' · ') || '—'],
              ['CPU', h.cpu_model ? `${h.cpu_model}${h.cpu_count ? `（${h.cpu_count} threads）` : ''}` : '—'],
              ['記憶體', h.mem_gb != null ? `${fmtNum(h.mem_gb, 1)} GB` : '—'],
              ['NVIDIA', `Driver ${h.nvidia_driver ?? '—'} · CUDA ${h.cuda ?? '—'}`],
              [
                'GPU',
                <span key="gpu" className={cn(gpuMismatch && 'text-warn-ink')}>
                  {h.gpu_summary || (h.facts_at ? '無' : '尚未收集')}
                  {gpuMismatch && `（lspci 看到 ${h.gpu_pci_count} 張，nvidia-smi 看到 ${h.gpu_count} 張）`}
                </span>,
              ],
              ...optional,
              ['資料時間', h.facts_at ? `${fmtDateTime(h.facts_at)}（${fmtRelative(h.facts_at)}）` : '尚未收集'],
            ]}
          />
        </Section>
        {isAdmin && <HealthSection name={h.name} className="mt-0" />}
      </div>
      <MetricsPanel name={h.name} monitored={h.monitored} show={['cpu', 'mem', 'net']} />
      {isAdmin && <AdminPanel host={h} />}
    </>
  )
}

function GpuTab({ h }: { h: HostDetailT }) {
  const gpus = h.facts?.gpus ?? []
  return (
    <>
      <Section
        title="GPU"
        description={h.gpu_pci_count != null && h.gpu_pci_count !== gpus.length ? `lspci 看到 ${h.gpu_pci_count} 張` : undefined}
        actions={
          <Link to="/usage?tab=gpu" className="text-sm text-primary hover:underline">
            GPU 即時看板
          </Link>
        }
      >
        {gpus.length === 0 ? (
          <EmptyState title={h.facts_at ? '這台主機沒有 GPU' : '尚未收集硬體資料'} className="py-6" />
        ) : (
          <TableWrap>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 text-right">#</TableHead>
                  <TableHead>型號</TableHead>
                  <TableHead className="text-right">記憶體</TableHead>
                  <TableHead>UUID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gpus.map((g) => (
                  <TableRow key={g.uuid || g.index}>
                    <TableCell className="num text-right">{g.index}</TableCell>
                    <TableCell>{g.name}</TableCell>
                    <TableCell className="num text-right">{g.memory_mb != null ? fmtBytes(g.memory_mb * 1024 * 1024, 0) : '—'}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{g.uuid}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableWrap>
        )}
      </Section>
      {gpus.length > 0 && <MetricsPanel name={h.name} monitored={h.monitored} show={['gpu', 'gpuMem']} />}
    </>
  )
}

function DiskTab({ h }: { h: HostDetailT }) {
  const f = h.facts ?? {}
  return (
    <>
      <Section
        title="掛載點"
        actions={
          <Link to="/usage?tab=disk" className="text-sm text-primary hover:underline">
            各使用者磁碟用量
          </Link>
        }
      >
        {!f.mounts?.length ? (
          <EmptyState title="尚未收集掛載點資料" className="py-6" />
        ) : (
          <TableWrap>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>掛載點</TableHead>
                  <TableHead className="text-right">容量</TableHead>
                  <TableHead className="text-right">已用</TableHead>
                  <TableHead className="w-44">使用率</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {f.mounts.map((m) => {
                  const p = m.size_bytes ? ((m.used_bytes ?? 0) * 100) / m.size_bytes : null
                  return (
                    <TableRow key={m.mountpoint}>
                      <TableCell className="font-mono">{m.mountpoint}</TableCell>
                      <TableCell className="num text-right">{fmtBytes(m.size_bytes)}</TableCell>
                      <TableCell className="num text-right">{fmtBytes(m.used_bytes)}</TableCell>
                      <TableCell>
                        <Meter label={`${m.mountpoint} 使用率`} value={p} valueText={fmtPct(p)} />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TableWrap>
        )}
      </Section>
      {f.disks && f.disks.length > 0 && (
        <Section title="硬碟">
          <TableWrap>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>裝置</TableHead>
                  <TableHead className="text-right">容量</TableHead>
                  <TableHead>型號</TableHead>
                  <TableHead>序號</TableHead>
                  <TableHead>類型</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {f.disks.map((d) => (
                  <TableRow key={d.name}>
                    <TableCell className="font-mono">{d.name}</TableCell>
                    <TableCell className="num text-right">{fmtBytes(d.size_bytes)}</TableCell>
                    <TableCell>{d.model || '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{d.serial || '—'}</TableCell>
                    <TableCell>{d.rota == null ? '—' : d.rota ? 'HDD' : 'SSD'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableWrap>
        </Section>
      )}
      <MetricsPanel name={h.name} monitored={h.monitored} show={['disk']} />
    </>
  )
}

/** ?tab= picks the tab; links from before the tabs (#users, #accounts) still open 使用者. */
function useHostTab(): string {
  const [params] = useSearchParams()
  const { hash } = useLocation()
  const want = params.get('tab')
  if (TABS.some((t) => t.id === want)) return want!
  return /^#(users|accounts)$/.test(hash) ? 'users' : 'overview'
}

export default function HostDetail() {
  const { name = '' } = useParams()
  const a = useAccess()
  const tab = useHostTab()
  const q = useQuery({
    queryKey: ['host', name],
    queryFn: () => api.get<HostDetailT>(`/api/hosts/${encodeURIComponent(name)}`),
    refetchInterval: 30_000,
  })
  const { hash } = useLocation()
  const loaded = !!q.data
  useEffect(() => {
    // #admin, #host-edit, #health links: the target exists only once the host has loaded
    if (loaded && hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView()
  }, [loaded, hash, tab])

  if (q.isError && q.error instanceof ApiError && q.error.status === 404) {
    return (
      <EmptyState title={`找不到主機 ${name}`}>
        <Link to="/hosts" className="text-primary hover:underline">
          回主機列表
        </Link>
      </EmptyState>
    )
  }

  return (
    <QueryState query={q} skeleton={<SkeletonRows rows={10} />}>
      {(h) => {
        const s = h.status
        return (
          <>
            <PageHeader
              docTitle={`${TABS.find((t) => t.id === tab)?.label} · ${h.name}`}
              title={
                <span className="inline-flex items-center gap-2">
                  <StatusDot state={!s || s.up === null ? 'unknown' : s.up ? 'up' : 'down'} className="size-2.5" />
                  {h.name}
                </span>
              }
              description={
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                  {h.address !== h.name && <span className="font-mono">{h.address}</span>}
                  <Pill tone="muted">{h.group}</Pill>
                  <Pill tone={h.monitored ? 'ok' : 'muted'}>{h.monitored ? '監控中' : '未監控'}</Pill>
                  {h.gpu_summary && <span className="text-muted-foreground">{h.gpu_summary}</span>}
                </span>
              }
            >
              <RouteTabs tabs={TABS} active={tab} label={`${h.name} 分頁`} />
            </PageHeader>
            {tab === 'gpu' ? (
              <GpuTab h={h} />
            ) : tab === 'users' ? (
              <>
                {h.monitored && <UsersPanel name={h.name} />}
                <AccountsSection host={h} isAdmin={a.isAdmin} />
              </>
            ) : tab === 'disk' ? (
              <DiskTab h={h} />
            ) : (
              <Overview h={h} isAdmin={a.isAdmin} />
            )}
          </>
        )
      }}
    </QueryState>
  )
}
