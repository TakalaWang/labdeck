import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, RotateCcw, TriangleAlert, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link, useNavigate, useParams } from '@/lib/router'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Facts, PageHeader, Section } from '@/components/page'
import { QueryState, SkeletonRows } from '@/components/states'
import { JobStatusBadge } from '@/components/status'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { fmtDateTime } from '@/lib/format'
import { JOB_KIND, JOB_LIVE } from '@/lib/labels'
import type { JobDetail } from '@/lib/types'

/** Monospace log block; sticks to the bottom while new output arrives if already scrolled there. */
function LogBlock({ text, label, live }: { text: string; label: string; live: boolean }) {
  const ref = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && live && stick.current) el.scrollTop = el.scrollHeight
  }, [text, live])
  return (
    <pre
      ref={ref}
      tabIndex={0}
      aria-label={label}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
      className="max-h-[32rem] overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed whitespace-pre focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {text}
    </pre>
  )
}

export default function AdminJob() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery({
    queryKey: ['job', id],
    queryFn: () => api.get<JobDetail>(`/api/admin/jobs/${encodeURIComponent(id)}`),
    refetchInterval: (query) => (query.state.data && JOB_LIVE.includes(query.state.data.status) ? 3_000 : false),
  })
  const onDone = (j: JobDetail) => {
    qc.setQueryData(['job', id], j)
    void qc.invalidateQueries({ queryKey: ['jobs'] })
  }
  // e.g. 409 on a stale users preview: the backend cancelled the job, so show its current state
  const onFailed = () => {
    void qc.invalidateQueries({ queryKey: ['job', id] })
    void qc.invalidateQueries({ queryKey: ['jobs'] })
  }
  const confirm = useMutation({
    mutationFn: () => api.post<JobDetail>(`/api/admin/jobs/${encodeURIComponent(id)}/confirm`),
    onSuccess: (j) => {
      toast.success(`工作 #${j.id} 已確認，稍後開始執行`)
      onDone(j)
    },
    onError: onFailed,
  })
  const cancel = useMutation({
    mutationFn: () => api.post<JobDetail>(`/api/admin/jobs/${encodeURIComponent(id)}/cancel`),
    onSuccess: (j) => {
      toast.success(`工作 #${j.id} 已取消`)
      onDone(j)
    },
    onError: onFailed,
  })

  // 重新執行: the server queues the same job again from the current DB (rules checked again) and answers the new one
  const rerun = useMutation({
    mutationFn: () => api.post<JobDetail>(`/api/admin/jobs/${encodeURIComponent(id)}/rerun`),
    onSuccess: (j) => {
      toast.success(`已重新排入：工作 #${j.id}`)
      void qc.invalidateQueries({ queryKey: ['jobs'] })
      navigate(`/admin/jobs/${j.id}`)
    },
  })

  return (
    <QueryState query={q} skeleton={<SkeletonRows rows={10} />}>
      {(j) => {
        const live = JOB_LIVE.includes(j.status)
        const failed = j.status === 'failed' || j.status === 'check_failed'
        const rerunnable = failed && ['collect', 'agents', 'users'].includes(j.kind)
        const cancellable = j.status === 'queued' || j.status === 'awaiting' || j.status === 'confirmed'
        return (
          <>
            <PageHeader
              docTitle={`工作 #${j.id}`}
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  工作 #{j.id} · {j.summary}
                  <JobStatusBadge status={j.status} testId="job-status" className="text-sm" />
                </span>
              }
              description={`${JOB_KIND[j.kind] ?? j.kind}${live ? ' · 每 3 秒自動更新' : ''}`}
              actions={
                <>
                  {rerunnable && (
                    <ConfirmDialog
                      trigger={
                        <Button variant={j.status === 'check_failed' ? 'default' : 'outline'} disabled={rerun.isPending}>
                          <RotateCcw /> 重新執行
                        </Button>
                      }
                      title={`重新執行工作 #${j.id}？`}
                      description={
                        j.scoped
                          ? '會以目前的資料重新指派同一個人、同一台主機（重新檢查人員仍啟用、仍開通這台），排入新的工作。'
                          : j.kind === 'users'
                            ? '會以目前的資料重建這些帳號的變更並排入新的工作；需要預覽的工作會重新預覽，確認後才套用。'
                            : '會以相同參數排入新的工作。'
                      }
                      confirmLabel="重新執行"
                      destructive={false}
                      onConfirm={() => rerun.mutateAsync()}
                    />
                  )}
                  {cancellable && (
                    <ConfirmDialog
                      trigger={
                        <Button variant="outline" disabled={cancel.isPending}>
                          <X /> 取消
                        </Button>
                      }
                      title={`取消工作 #${j.id}？`}
                      description="已經開始執行的工作無法取消。"
                      confirmLabel="取消工作"
                      onConfirm={() => cancel.mutateAsync()}
                    />
                  )}
                  {j.status === 'awaiting' && (
                    <ConfirmDialog
                      trigger={
                        <Button disabled={confirm.isPending}>
                          <Play /> 確認執行
                        </Button>
                      }
                      title={`確認執行工作 #${j.id}？`}
                      description="請先檢查下方預檢輸出（--check --diff）是否符合預期。確認後 runner 會對目標主機實際套用變更。"
                      confirmLabel="確認執行"
                      destructive={false}
                      onConfirm={() => confirm.mutateAsync()}
                    />
                  )}
                </>
              }
            />
            {j.status === 'awaiting' && (
              <div role="status" className="mb-5 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn-ink">
                此工作已完成預檢，正在等待網管確認後才會實際執行。
              </div>
            )}
            {failed && j.failure && (
              <div role="alert" data-testid="job-failure" className="mb-5 flex items-start gap-2 rounded-lg border border-destructive/30 bg-crit-soft px-4 py-3 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
                <span>
                  <span className="font-medium text-destructive">{j.failure}</span>
                  {rerunnable && <span className="text-muted-foreground"> 修正後可按「重新執行」。</span>}
                </span>
              </div>
            )}
            <Facts
              className="rounded-lg border bg-card p-4"
              items={[
                ['目標主機', j.target_hosts.length ? j.target_hosts.map((h, i) => (
                  <span key={h}>
                    {i > 0 && '、'}
                    <Link to={`/hosts/${encodeURIComponent(h)}`} className="hover:underline">
                      {h}
                    </Link>
                  </span>
                )) : '全部'],
                ['發起人', j.actor ?? 'system'],
                ['建立', fmtDateTime(j.created_at)],
                ['預定執行', fmtDateTime(j.run_at)],
                ['完成', fmtDateTime(j.finished_at)],
                ['自動確認', !j.auto_confirm ? '否（先預覽，網管確認後執行）' : j.scoped ? '是（管理員指派：只動這個帳號）' : '是（只含金鑰變更）'],
              ]}
            />
            {j.check_output && (
              <Section title="預檢輸出" description="ansible-playbook --check --diff">
                <LogBlock label="預檢輸出" text={j.check_output} live={false} />
              </Section>
            )}
            <Section title="執行輸出">
              {j.output ? (
                <LogBlock label="執行輸出" text={j.output} live={live} />
              ) : (
                <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  {live ? '等待輸出…' : j.status === 'awaiting' ? '確認執行後才會有輸出。' : j.status === 'check_failed' ? '預檢失敗，沒有執行。' : '沒有輸出。'}
                </p>
              )}
            </Section>
            {j.args && Object.keys(j.args).length > 0 && (
              <details className="group mt-8">
                <summary className="cursor-pointer text-sm font-semibold select-none">工作參數（JSON）</summary>
                <div className="mt-3">
                  <LogBlock label="工作參數" text={JSON.stringify(j.args, null, 2)} live={false} />
                </div>
              </details>
            )}
          </>
        )
      }}
    </QueryState>
  )
}
