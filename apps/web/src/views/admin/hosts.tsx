import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, CircleAlert, CircleCheck, DatabaseZap, FileUp } from 'lucide-react'
import { useId, useState } from 'react'
import { Link } from '@/lib/router'
import { toast } from 'sonner'

import { HostForm } from '@/components/host-form'
import { PageHeader, Section, TableWrap } from '@/components/page'
import { EmptyState, QueryState, SkeletonRows } from '@/components/states'
import { Pill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useJobToast } from '@/hooks/use-job-toast'
import { api } from '@/lib/api'
import { fmtDateTime, fmtRelative } from '@/lib/format'
import type { Host, HostImportResult, HostInput, JobRef } from '@/lib/types'

function ImportDialog() {
  const id = useId()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [csv, setCsv] = useState('')
  const [result, setResult] = useState<HostImportResult | null>(null)
  const m = useMutation({
    mutationFn: (text: string) => api.post<HostImportResult>('/api/admin/hosts/import', { csv: text }),
    onSuccess: (r) => {
      setResult(r)
      if (r.errors.length === 0) {
        toast.success(`已匯入 ${r.added.length} 台主機${r.skipped.length ? `，略過 ${r.skipped.length} 台` : ''}`)
        void qc.invalidateQueries({ queryKey: ['hosts'] })
      }
    },
  })
  const lines = csv.split('\n')

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setResult(null)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FileUp /> 匯入 CSV
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>貼上 CSV 匯入主機</DialogTitle>
          <DialogDescription>
            每行一台：<code className="font-mono">name,address,group</code>（標題列可省略）。任何一行有誤就全部不匯入；名稱已存在的主機會略過。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-csv`}>CSV 內容</Label>
          <Textarea
            id={`${id}-csv`}
            rows={8}
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value)
              setResult(null)
            }}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder={'name,address,group\ngpu01,192.0.2.11,gpu\npc01,192.0.2.21,desk'}
          />
        </div>
        {result && result.errors.length > 0 && (
          <div role="alert" className="rounded-lg border border-destructive/30 bg-crit-soft p-3 text-sm">
            <p className="mb-2 flex items-center gap-1.5 font-medium text-destructive">
              <CircleAlert className="size-4" aria-hidden="true" /> {result.errors.length} 行有誤，沒有匯入任何主機
            </p>
            <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
              {result.errors.map((e) => (
                <li key={e.line} className="grid grid-cols-[3.5rem_1fr] gap-2">
                  <span className="num text-muted-foreground">第 {e.line} 行</span>
                  <span>
                    <span className="text-destructive">{e.error}</span>
                    {lines[e.line - 1] !== undefined && (
                      <code className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{lines[e.line - 1]}</code>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {result && result.errors.length === 0 && (
          <div role="status" className="rounded-lg border border-ok/40 bg-ok-soft p-3 text-sm">
            <p className="flex items-center gap-1.5 font-medium text-ok-ink">
              <CircleCheck className="size-4" aria-hidden="true" /> 已新增 {result.added.length} 台
              {result.added.length > 0 && `：${result.added.join('、')}`}
            </p>
            {result.skipped.length > 0 && (
              <ul className="mt-2 text-muted-foreground">
                {result.skipped.map((s) => (
                  <li key={s.name}>
                    略過 {s.name}：{s.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            關閉
          </Button>
          <Button disabled={!csv.trim() || m.isPending} onClick={() => m.mutate(csv)}>
            {m.isPending ? '檢查中…' : '匯入'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RowActions({ name }: { name: string }) {
  const jobToast = useJobToast()
  const path = `/api/admin/hosts/${encodeURIComponent(name)}`
  const agents = useMutation({ mutationFn: () => api.post<JobRef>(`${path}/agents`), onSuccess: (r) => jobToast(`${name} 安裝/更新監控`, r.job_id) })
  const collect = useMutation({ mutationFn: () => api.post<JobRef>(`${path}/collect`), onSuccess: (r) => jobToast(`${name} 收集資料`, r.job_id) })
  return (
    <div className="flex gap-1.5">
      <Button size="sm" variant="outline" disabled={agents.isPending} onClick={() => agents.mutate()}>
        <Activity /> 安裝/更新監控
      </Button>
      <Button size="sm" variant="outline" disabled={collect.isPending} onClick={() => collect.mutate()}>
        <DatabaseZap /> 收集資料
      </Button>
    </div>
  )
}

export default function AdminHosts() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['hosts'], queryFn: () => api.get<Host[]>('/api/hosts'), refetchInterval: 30_000 })
  const add = useMutation({
    mutationFn: (input: HostInput) => api.post<Host>('/api/admin/hosts', input),
    onSuccess: (h) => {
      toast.success(`已新增主機 ${h.name}，下一步請在監控主機上 bootstrap`)
      void qc.invalidateQueries({ queryKey: ['hosts'] })
    },
  })

  return (
    <>
      <PageHeader title="主機管理" description={q.data ? `${q.data.length} 台` : undefined} actions={<ImportDialog />} />
      <p className="mb-4 max-w-prose text-sm text-muted-foreground">
        新增主機後：① 在監控主機上 bootstrap（指令見各主機頁）→ ② 安裝監控 → ③ 收集資料（或等每晚 03:00 自動收集）。編輯與刪除請進入各主機頁面。
      </p>
      <QueryState query={q} skeleton={<SkeletonRows rows={6} />}>
        {(hosts) =>
          hosts.length === 0 ? (
            <EmptyState title="尚未新增主機">使用下方表單新增，或用「匯入 CSV」一次加入多台。</EmptyState>
          ) : (
            <TableWrap>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>主機</TableHead>
                    <TableHead>位址</TableHead>
                    <TableHead>群組</TableHead>
                    <TableHead>監控</TableHead>
                    <TableHead>資料時間</TableHead>
                    <TableHead>
                      <span className="sr-only">動作</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {hosts.map((h) => (
                    <TableRow key={h.name} data-testid={`host-row-${h.name}`}>
                      <TableCell>
                        <Link to={`/hosts/${encodeURIComponent(h.name)}?tab=overview#admin`} className="font-medium hover:underline">
                          {h.name}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{h.address}</TableCell>
                      <TableCell>{h.group}</TableCell>
                      <TableCell>{h.monitored ? <Pill tone="ok">監控中</Pill> : <Pill tone="muted">未安裝</Pill>}</TableCell>
                      <TableCell title={fmtDateTime(h.facts_at)}>{h.facts_at ? fmtRelative(h.facts_at) : <span className="text-muted-foreground">尚未收集</span>}</TableCell>
                      <TableCell>
                        <RowActions name={h.name} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableWrap>
          )
        }
      </QueryState>
      <Section title="新增主機">
        <HostForm submitLabel="新增" onSubmit={(input) => add.mutateAsync(input)} />
      </Section>
    </>
  )
}
