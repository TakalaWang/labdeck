import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from '@/lib/router'

import { RankBarChart, TimeSeriesChart, type Series } from '@/components/charts'
import { PageHeader, Section, TableWrap } from '@/components/page'
import { SortHead } from '@/components/sort-head'
import { EmptyState, QueryState, SkeletonRows } from '@/components/states'
import { Pill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useSort } from '@/hooks/use-sort'
import { api } from '@/lib/api'
import { fmtBytes, fmtBytesShort, fmtDateTime, fmtPct, fmtRelative } from '@/lib/format'
import { levelTone, TONE_COLOR } from '@/lib/labels'
import { toPoints } from '@/lib/series'
import type { DiskTrend, DiskUsage, Filesystem, FilesystemBoard } from '@/lib/types'

const PAGE = 200
const STALE_DAYS = 8

function Owners({ data }: { data: DiskUsage }) {
  const top = useMemo(() => [...data.owners].sort((a, b) => b.bytes - a.bytes).slice(0, 15), [data.owners])
  if (top.length === 0) return <EmptyState title="尚無掃描資料" />
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="rounded-lg border bg-card p-3">
        <RankBarChart data={top} labelKey="owner" valueKey="bytes" format={(v) => fmtBytes(v)} ariaLabel="各使用者磁碟用量（前 15 名）" />
      </div>
      <TableWrap>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>使用者</TableHead>
              <TableHead className="text-right">用量</TableHead>
              <TableHead className="text-right">目錄數</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {top.map((o) => (
              <TableRow key={o.owner}>
                <TableCell className="font-mono">{o.owner}</TableCell>
                <TableCell className="num text-right">{fmtBytes(o.bytes)}</TableCell>
                <TableCell className="num text-right">{o.paths}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableWrap>
    </div>
  )
}

function Rows({ data }: { data: DiskUsage }) {
  const [host, setHost] = useState('all')
  const [root, setRoot] = useState('all')
  const [owner, setOwner] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const hosts = useMemo(() => [...new Set(data.rows.map((r) => r.host))].sort(), [data.rows])
  const roots = useMemo(() => [...new Set(data.rows.map((r) => r.root))].sort(), [data.rows])
  const filtered = useMemo(() => {
    const needle = owner.trim().toLowerCase()
    return data.rows.filter(
      (r) =>
        (host === 'all' || r.host === host) &&
        (root === 'all' || r.root === root) &&
        (!needle || r.owner.toLowerCase().includes(needle) || r.path.toLowerCase().includes(needle)),
    )
  }, [data.rows, host, root, owner])
  const sort = useSort(filtered, 'bytes')
  const total = filtered.reduce((n, r) => n + r.bytes, 0)

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={host} onValueChange={setHost}>
          <SelectTrigger size="sm" className="w-36" aria-label="主機">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部主機</SelectItem>
            {hosts.map((h) => (
              <SelectItem key={h} value={h}>
                {h}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={root} onValueChange={setRoot}>
          <SelectTrigger size="sm" className="w-36" aria-label="根目錄">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部根目錄</SelectItem>
            {roots.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="篩選使用者或路徑"
            placeholder="使用者或路徑"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="h-8 pl-8"
          />
        </div>
        <span className="num text-sm text-muted-foreground">
          {filtered.length} 筆，共 {fmtBytes(total)}
        </span>
      </div>
      {filtered.length === 0 ? (
        <EmptyState title="沒有符合條件的目錄" />
      ) : (
        <TableWrap>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortHead active={sort.key === 'host'} dir={sort.dir} onClick={() => sort.toggle('host')}>
                  主機
                </SortHead>
                <SortHead active={sort.key === 'root'} dir={sort.dir} onClick={() => sort.toggle('root')}>
                  根目錄
                </SortHead>
                <SortHead active={sort.key === 'path'} dir={sort.dir} onClick={() => sort.toggle('path')}>
                  路徑
                </SortHead>
                <SortHead active={sort.key === 'owner'} dir={sort.dir} onClick={() => sort.toggle('owner')}>
                  擁有者
                </SortHead>
                <SortHead active={sort.key === 'bytes'} dir={sort.dir} onClick={() => sort.toggle('bytes')} align="right">
                  用量
                </SortHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sort.sorted.slice(0, limit).map((r) => (
                <TableRow key={`${r.host}:${r.path}`}>
                  <TableCell>
                    <Link to={`/hosts/${encodeURIComponent(r.host)}`} className="hover:underline">
                      {r.host}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.root}</TableCell>
                  <TableCell className="font-mono text-xs">{r.path}</TableCell>
                  <TableCell className="font-mono">{r.owner}</TableCell>
                  <TableCell className="num text-right">{fmtBytes(r.bytes)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableWrap>
      )}
      {filtered.length > limit && (
        <div className="mt-3 flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + PAGE * 5)}>
            再顯示 {Math.min(PAGE * 5, filtered.length - limit)} 筆（共 {filtered.length}）
          </Button>
        </div>
      )}
    </>
  )
}

function LastScan({ data }: { data: DiskUsage }) {
  const [now] = useState(() => Date.now())
  if (data.last_scan.length === 0) return <p className="text-sm text-muted-foreground">尚無掃描紀錄。</p>
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
      {data.last_scan.map((s) => {
        const stale = !s.at || now - new Date(s.at).getTime() > STALE_DAYS * 86400_000
        return (
          <li key={`${s.host}:${s.root}`} className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-sm">
            <span className="min-w-0 truncate">
              {s.host} <span className="font-mono text-xs text-muted-foreground">{s.root}</span>
            </span>
            {stale ? (
              <Pill tone="warn" title={fmtDateTime(s.at)}>
                {s.at ? fmtRelative(s.at) : '從未'}
              </Pill>
            ) : (
              <span className="text-xs text-muted-foreground" title={fmtDateTime(s.at)}>
                {fmtRelative(s.at)}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** One filesystem as a stacked bar: used | available (df's Use% = used / (used + available)). */
function FsBar({ host, fs }: { host: string; fs: Filesystem }) {
  const usable = fs.used_bytes + fs.avail_bytes
  const pct = usable > 0 ? (fs.used_bytes / usable) * 100 : null
  const text = `${host} ${fs.mountpoint}：已用 ${fmtBytes(fs.used_bytes)}，可用 ${fmtBytes(fs.avail_bytes)}（${fmtPct(pct)}），容量 ${fmtBytes(fs.size_bytes)}`
  return (
    <li className="flex flex-col gap-1" title={`${text}\n${fs.device}`}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 truncate font-mono">{fs.mountpoint}</span>
        <span className="num shrink-0 text-muted-foreground">
          <span className="text-foreground">{fmtBytes(fs.used_bytes)}</span> / {fmtBytes(usable)} · {fmtPct(pct)}
        </span>
      </div>
      <div role="img" aria-label={text} className="flex h-2.5 overflow-hidden rounded-full bg-muted">
        <span className="h-full" style={{ width: `${pct ?? 0}%`, background: TONE_COLOR[levelTone(pct)] }} />
        <span className="h-full flex-1 bg-muted-foreground/15" />
      </div>
    </li>
  )
}

const FS_FIRST = 9
const fullest = (fs: Filesystem[]) =>
  Math.max(-1, ...fs.map((f) => (f.used_bytes + f.avail_bytes > 0 ? f.used_bytes / (f.used_bytes + f.avail_bytes) : 0)))

/** Hosts with the fullest filesystem first; the first FS_FIRST until expanded. */
function Filesystems({ data }: { data: FilesystemBoard }) {
  const [all, setAll] = useState(false)
  const hosts = useMemo(() => [...data.hosts].sort((a, b) => fullest(b.filesystems) - fullest(a.filesystems)), [data.hosts])
  if (hosts.length === 0) return <EmptyState title="沒有監控中的主機" />
  return (
    <>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] items-start gap-3">
        {(all ? hosts : hosts.slice(0, FS_FIRST)).map((h) => (
          <li key={h.host} data-testid={`fs-${h.host}`} className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2">
              <Link to={`/hosts/${encodeURIComponent(h.host)}`} className="text-sm font-semibold hover:underline">
                {h.host}
              </Link>
              <Pill tone="muted">{h.group}</Pill>
            </div>
            {h.filesystems.length === 0 ? (
              <p className="text-xs text-muted-foreground">尚無資料（主機離線或尚未抓取）</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {h.filesystems.map((fs) => (
                  <FsBar key={fs.mountpoint} host={h.host} fs={fs} />
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {hosts.length > FS_FIRST && (
        <div className="mt-3 flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setAll((v) => !v)}>
            {all ? `只顯示最滿的 ${FS_FIRST} 台` : `顯示全部 ${hosts.length} 台`}
          </Button>
        </div>
      )}
    </>
  )
}

function Trend({ data }: { data: DiskTrend }) {
  const series = useMemo<Series[]>(() => data.owners.map((o) => ({ name: o.owner, points: toPoints(data, o.bytes) })), [data])
  const domain = useMemo<[number, number]>(() => [data.start, data.end], [data.start, data.end])
  if (series.every((x) => x.points.length === 0)) return <EmptyState title="尚無掃描資料" />
  return (
    <div className="rounded-lg border bg-card p-3">
      <TimeSeriesChart
        series={series}
        format={(v) => fmtBytes(v)}
        tickFormat={fmtBytesShort}
        sparse
        xDomain={domain}
        ariaLabel={`用量最多的 ${series.length} 位使用者，過去 ${data.days} 天的磁碟用量`}
        className="h-72"
      />
    </div>
  )
}

export default function Disk() {
  const q = useQuery({ queryKey: ['disk'], queryFn: () => api.get<DiskUsage>('/api/metrics/disk'), refetchInterval: 300_000 })
  const fs = useQuery({
    queryKey: ['disk-filesystems'],
    queryFn: () => api.get<FilesystemBoard>('/api/metrics/disk/filesystems'),
    refetchInterval: 300_000,
  })
  const trend = useQuery({
    queryKey: ['disk-trend', 30],
    queryFn: () => api.get<DiskTrend>('/api/metrics/disk/trend?days=30'),
    refetchInterval: 3_600_000,
  })
  return (
    <>
      <PageHeader title="磁碟用量" description="/home 每晚掃描，資料碟每週掃描；數字為掃描當下的目錄大小。" />
      <Section title="使用者用量趨勢" description="用量最多的 10 位使用者，過去 30 天每天一點（各主機加總）；沒有掃描的日子以直線連接。">
        <QueryState query={trend} skeleton={<SkeletonRows rows={4} />}>
          {(data) => <Trend data={data} />}
        </QueryState>
      </Section>
      <Section title="各主機檔案系統" description="實體檔案系統的已用與可用空間（即時，不含 tmpfs、網路磁碟；百分比同 df），最滿的排在前面。">
        <QueryState query={fs} skeleton={<SkeletonRows rows={4} />}>
          {(data) => <Filesystems data={data} />}
        </QueryState>
      </Section>
      <QueryState query={q} skeleton={<SkeletonRows rows={10} />}>
        {(data) => (
          <>
            <Section title="用量最多的使用者">
              <Owners data={data} />
            </Section>
            <Section title="所有目錄">
              <Rows data={data} />
            </Section>
            <Section title="最近掃描時間" description={`超過 ${STALE_DAYS} 天未更新者以黃色標示。`}>
              <LastScan data={data} />
            </Section>
          </>
        )}
      </QueryState>
    </>
  )
}
