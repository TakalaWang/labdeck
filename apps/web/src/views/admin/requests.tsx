import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Inbox, UserCheck } from 'lucide-react'
import { useId, useState } from 'react'
import { Link } from '@/lib/router'
import { toast } from 'sonner'

import { AssignHostPicker, PersonPicker } from '@/components/assign-hosts'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { needsText } from '@/components/needs-fields'
import { PageHeader, Section } from '@/components/page'
import { EmptyState, QueryState, SkeletonRows } from '@/components/states'
import { JobStatusBadge, Pill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/format'
import { USERNAME_RE, requestStatus } from '@/lib/labels'
import { useAccess } from '@/lib/session'
import type { AccountRequest, AssignInput, AssignResult, Person } from '@/lib/types'
import { cn } from '@/lib/utils'

const noSso = (p: Person) => !p.sso_id && p.status === 'active'

/** Link or create the person (registrations), pick hosts, confirm: one scoped job per host, no preview. */
function AssignPanel({ r, onClose }: { r: AccountRequest; onClose: () => void }) {
  const id = useId()
  const a = useAccess()
  const qc = useQueryClient()
  const registration = r.kind === 'account'
  const [mode, setMode] = useState<'create' | 'link'>('create')
  const [username, setUsername] = useState(r.username)
  const [personId, setPersonId] = useState<number | null>(null)
  const [hosts, setHosts] = useState<string[]>(r.gpus === null ? r.hosts : []) // a request from before registrations named hosts
  const badName = !USERNAME_RE.test(username)
  const m = useMutation({
    mutationFn: (body: AssignInput) => api.post<AssignResult>(`/api/admin/requests/${r.id}/assign`, body),
    onSuccess: (res) => {
      toast.success(
        res.jobs.length ? `已指派 ${res.jobs.map((j) => j.host).join('、')}，帳號建立中（${res.jobs.length} 個工作，不需預覽）` : '已連結帳號',
      )
      void qc.invalidateQueries({ queryKey: ['admin-requests'] })
      void qc.invalidateQueries({ queryKey: ['people'] })
      void qc.invalidateQueries({ queryKey: ['assign-hosts'] })
      onClose()
    },
  })
  const pickerPerson = r.kind === 'hosts' ? r.person_id : mode === 'link' ? personId : null
  const ready = registration
    ? mode === 'create' ? !badName && hosts.length > 0 : personId !== null
    : hosts.length > 0
  const submit = () => {
    const body: AssignInput = { hosts }
    if (registration) {
      Object.assign(body, mode === 'create' ? { username } : { person_id: personId })
    }
    m.mutate(body)
  }
  const label = !registration ? '指派主機' : mode === 'create' ? '建立帳號並指派' : hosts.length ? '連結並指派' : '連結帳號'
  return (
    <div className="mt-4 grid gap-5 border-t pt-4" data-testid={`assign-panel-${r.id}`}>
      {registration && (
        <fieldset className="grid gap-3">
          <legend className="mb-2 text-sm font-medium">1. 帳號</legend>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as typeof mode)} className="grid gap-2 sm:grid-cols-2">
            {([
              ['create', '建立新帳號', '分配全實驗室 UID，帳號名稱預設為希望的名稱'],
              ['link', '連結既有帳號', `已有主機帳號的舊成員：把這個 ${a.oauthName} 身分連到他的人員`],
            ] as const).map(([v, title, hint]) => (
              <Label
                key={v}
                htmlFor={`${id}-${v}`}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal hover:bg-muted/50',
                  mode === v && 'border-primary bg-accent',
                )}
              >
                <RadioGroupItem id={`${id}-${v}`} value={v} className="mt-0.5" />
                <span>
                  <span className="block font-medium">{title}</span>
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
          <div className={cn('grid gap-4', mode === 'create' ? 'sm:max-w-80' : '')}>
            {mode === 'create' ? (
              <div className="grid content-start gap-1.5">
                <Label htmlFor={`${id}-u`}>帳號名稱</Label>
                <Input
                  id={`${id}-u`}
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase().trim())}
                  className="font-mono"
                  maxLength={32}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={badName}
                />
                <p className={cn('text-xs', badName ? 'text-destructive' : 'text-muted-foreground')}>
                  {badName ? '小寫英文開頭，只含小寫英數字、_、-，最多 32 字' : '不可與既有人員或主機上的帳號重複（送出時檢查）'}
                </p>
              </div>
            ) : (
              <div className="grid content-start gap-1.5">
                <span className="text-sm font-medium">要連結的人員（尚未連結 {a.oauthName} ID）</span>
                <PersonPicker filter={noSso} value={personId} onChange={setPersonId} label="搜尋要連結的人員" />
              </div>
            )}
          </div>
        </fieldset>
      )}
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">
          {registration ? '2. ' : ''}主機
          <span className="ml-2 font-normal text-muted-foreground">需求：{needsText(r)}</span>
        </legend>
        <AssignHostPicker personId={pickerPerson} needs={r} value={hosts} onChange={setHosts} />
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!ready || m.isPending} onClick={submit}>
          <UserCheck /> {m.isPending ? '處理中…' : label}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <span className="text-xs text-muted-foreground">
          {hosts.length
            ? '每台主機一個工作，只動這個帳號、不需預覽；系統不寄信，請自行告知對方帳號已開通。'
            : registration && mode === 'link'
              ? '未選主機：只連結帳號，不排工作。'
              : '請至少選一台主機。'}
        </span>
      </div>
    </div>
  )
}

function RequestCard({ r }: { r: AccountRequest }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const reject = useMutation({
    mutationFn: () => api.post<AccountRequest>(`/api/admin/requests/${r.id}/reject`, { reason: reason.trim() || null }),
    onSuccess: () => {
      toast.success(`已退回 ${r.name ?? r.username} 的${r.kind === 'hosts' ? '主機申請' : '登記'}`)
      setReason('')
      void qc.invalidateQueries({ queryKey: ['admin-requests'] })
    },
  })
  const s = requestStatus(r)
  const member = r.kind === 'hosts'
  return (
    <li className="rounded-lg border bg-card p-4" data-testid={`request-${r.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            {member && r.person_id ? (
              <Link to={`/admin/people/${r.person_id}`} className="font-mono text-base font-semibold text-primary hover:underline">
                {r.username}
              </Link>
            ) : (
              <span className="text-base font-semibold">{r.name ?? r.username}</span>
            )}
            <Pill tone={member ? 'info' : 'neutral'}>{member ? '既有成員申請主機' : '新成員登記'}</Pill>
            {r.status !== 'pending' && <Pill tone={s.tone}>{s.label}</Pill>}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {r.sso_id}
            {r.email ? ` · ${r.email}` : ''} · <span title={fmtDateTime(r.created_at)}>{fmtRelative(r.created_at)}送出</span>
            {r.updated_at !== r.created_at && <span title={fmtDateTime(r.updated_at)}>（{fmtRelative(r.updated_at)}修改）</span>}
          </p>
        </div>
        {r.status === 'pending' ? (
          <div className="flex gap-2">
            <ConfirmDialog
              trigger={<Button variant="outline" size="sm">退回</Button>}
              title={`退回 ${r.name ?? r.username} 的${member ? '主機申請' : '登記'}？`}
              description="對方會在網頁上看到「已退回」與原因，並收到退回通知信（有設定 Email 時）；可以修改後重新送出。"
              confirmLabel="退回"
              onConfirm={() => reject.mutateAsync()}
            >
              <div className="grid gap-1.5">
                <Label htmlFor={`reject-${r.id}`}>原因（選填，會給對方看）</Label>
                <Textarea
                  id={`reject-${r.id}`}
                  rows={3}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="例如：請先和指導教授確認用途後再登記"
                />
              </div>
            </ConfirmDialog>
            {!open && (
              <Button size="sm" onClick={() => setOpen(true)}>
                <UserCheck /> 指派…
              </Button>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {r.decided_by} 於 {fmtDateTime(r.decided_at)}
          </p>
        )}
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[max-content_1fr]">
        {!member && (
          <>
            <dt className="text-muted-foreground">希望的帳號</dt>
            <dd className="font-mono">{r.username}</dd>
          </>
        )}
        <dt className="text-muted-foreground">需求</dt>
        <dd>
          {needsText(r)}
          {r.until && <span className="text-muted-foreground"> · 用到 {fmtDate(r.until)}</span>}
        </dd>
        <dt className="text-muted-foreground">用途</dt>
        <dd className="whitespace-pre-wrap">{r.purpose}</dd>
        {r.reject_reason && (
          <>
            <dt className="text-muted-foreground">退回原因</dt>
            <dd className="whitespace-pre-wrap">{r.reject_reason}</dd>
          </>
        )}
        {r.hosts.length > 0 && (
          <>
            <dt className="text-muted-foreground">{r.status === 'approved' ? '指派的主機' : '申請的主機'}</dt>
            <dd className="flex flex-wrap gap-1">
              {r.hosts.map((h) => (
                <Link key={h} to={`/hosts/${encodeURIComponent(h)}`}>
                  <Pill tone="muted" className="hover:border-border">
                    {h}
                  </Pill>
                </Link>
              ))}
            </dd>
          </>
        )}
        {(r.jobs.length > 0 || r.job_id != null) && (
          <>
            <dt className="text-muted-foreground">工作</dt>
            <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {r.jobs.map((j) => (
                <span key={j.job_id} className="inline-flex items-center gap-1.5">
                  <Link to={`/admin/jobs/${j.job_id}`} className="text-primary hover:underline">
                    #{j.job_id}
                  </Link>
                  <span className="text-muted-foreground">{j.host}</span>
                  <JobStatusBadge status={j.status} />
                </span>
              ))}
              {r.job_id != null && r.jobs.length === 0 && (
                <Link to={`/admin/jobs/${r.job_id}`} className="text-primary hover:underline">
                  #{r.job_id}
                </Link>
              )}
            </dd>
          </>
        )}
      </dl>
      {open && <AssignPanel r={r} onClose={() => setOpen(false)} />}
    </li>
  )
}

export default function AdminRequests() {
  const q = useQuery({ queryKey: ['admin-requests'], queryFn: () => api.get<AccountRequest[]>('/api/admin/requests'), refetchInterval: 60_000 })
  return (
    <>
      <PageHeader
        title="待指派"
        description="新成員登記與既有成員的主機申請。建立或連結帳號、挑選主機後，每台主機排一個只動這個帳號的工作（不需預覽）。指派不寄信，請自行告知對方；登記的「預計使用到」只供參考，帳號到期日在人員頁設定。"
      />
      <QueryState query={q} skeleton={<SkeletonRows rows={5} />}>
        {(rows) => {
          const pending = rows.filter((r) => r.status === 'pending')
          const decided = rows.filter((r) => r.status !== 'pending')
          return (
            <>
              <Section title={`待指派（${pending.length}）`}>
                {pending.length === 0 ? (
                  <EmptyState title="目前沒有待指派的登記或申請" icon={<Inbox className="size-6" />} className="py-6" />
                ) : (
                  <ul className="flex flex-col gap-3">
                    {pending.map((r) => (
                      <RequestCard key={r.id} r={r} />
                    ))}
                  </ul>
                )}
              </Section>
              {decided.length > 0 && (
                <Section title="已處理">
                  <ul className="flex flex-col gap-3">
                    {decided.slice(0, 50).map((r) => (
                      <RequestCard key={r.id} r={r} />
                    ))}
                  </ul>
                </Section>
              )}
            </>
          )
        }}
      </QueryState>
    </>
  )
}
