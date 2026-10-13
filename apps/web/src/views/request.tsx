import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Hourglass, Megaphone, Pencil } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { Link } from '@/lib/router'
import { toast } from 'sonner'

import { NeedsFields, draftOf, emptyNeeds, needsOf, needsText, type NeedsDraft } from '@/components/needs-fields'
import { Facts, PageHeader, Section } from '@/components/page'
import { QueryState, SkeletonRows } from '@/components/states'
import { Pill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { fmtDate, fmtDateTime } from '@/lib/format'
import { USERNAME_RE } from '@/lib/labels'
import { useAccess } from '@/lib/session'
import type { AccountRequest, RegisterInput, RegisterPage } from '@/lib/types'

/** 登記: 姓名, 希望的帳號名稱 and needs. New (POST) or an edit of the pending one (PUT). */
function RegisterForm({ current, from, onDone }: { current: AccountRequest | null; from?: AccountRequest; onDone: () => void }) {
  const id = useId()
  const qc = useQueryClient()
  // editing the pending one, or a new registration prefilled from the last (sent back) one
  const base = current ?? from ?? null
  const [name, setName] = useState(base?.name ?? '')
  const [username, setUsername] = useState(base?.username ?? '')
  const [needs, setNeeds] = useState<NeedsDraft>(() => {
    if (!base) return emptyNeeds
    const d = draftOf(base)
    return !current && base.until && base.until < new Date().toISOString().slice(0, 10) ? { ...d, until: '' } : d // a past date can't be resent
  })
  const editing = current !== null
  const m = useMutation({
    mutationFn: (body: RegisterInput) => (editing ? api.put<AccountRequest>('/api/register', body) : api.post<AccountRequest>('/api/register', body)),
    onSuccess: () => {
      toast.success(editing ? '已更新登記內容' : '已送出登記。助教指派後會通知你，也可以隨時回到我的帳號查看')
      void qc.invalidateQueries({ queryKey: ['register'] })
      onDone()
    },
  })
  const badName = username !== '' && !USERNAME_RE.test(username)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    m.mutate({ name: name.trim(), username, ...needsOf(needs) })
  }
  return (
    <form onSubmit={submit} className="grid max-w-3xl gap-5" aria-label="登記表單" data-testid="register-form">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-1.5">
          <Label htmlFor={`${id}-n`}>姓名</Label>
          <Input id={`${id}-n`} required maxLength={100} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid content-start gap-1.5">
          <Label htmlFor={`${id}-u`}>希望的帳號名稱</Label>
          <Input
            id={`${id}-u`}
            required
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase().trim())}
            className="font-mono"
            aria-invalid={badName}
            aria-describedby={`${id}-u-hint`}
          />
          <p id={`${id}-u-hint`} className={badName ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
            小寫英文開頭，只含小寫英數字、_、-，最多 32 字。這會是你在所有主機上的 Linux 帳號，助教可能依實際情況調整。
          </p>
        </div>
      </div>
      <NeedsFields value={needs} onChange={setNeeds} />
      <p className="text-sm text-muted-foreground">
        不需要選主機：助教會依你的需求與各主機目前的負載指派。助教指派後會通知你，也可以隨時回到「我的帳號」查看。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={m.isPending || badName}>
          {m.isPending ? '送出中…' : editing ? '儲存修改' : '送出登記'}
        </Button>
        {editing && (
          <Button type="button" variant="ghost" onClick={onDone}>
            取消
          </Button>
        )}
      </div>
    </form>
  )
}

/** After submitting: what was sent, editable until a TA assigns it; the guide and announcements stay readable. */
function Waiting({ r, onEdit }: { r: AccountRequest; onEdit: () => void }) {
  return (
    <div className="grid max-w-3xl gap-6" data-testid="registration-waiting">
      <div className="flex items-start gap-3 rounded-xl border bg-card p-4 sm:p-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <Hourglass className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold">已收到你的登記，等待助教指派</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            助教會為你建立帳號並挑選合適的主機。助教指派後會通知你，也可以隨時回到「我的帳號」查看；臨時密碼會顯示在那裡，
            直到你按「我已記下」。等待期間可以先讀新成員指南。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button asChild size="sm">
              <Link to="/guide">
                <BookOpen /> 新成員指南
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/announcements">
                <Megaphone /> 公告
              </Link>
            </Button>
          </div>
        </div>
      </div>
      <Section
        title="登記內容"
        description="指派前都可以修改。"
        actions={
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil /> 修改
          </Button>
        }
      >
        <div className="rounded-lg border bg-card p-4">
          <Facts
            items={[
              ['姓名', r.name ?? '—'],
              ['希望的帳號名稱', <span key="u" className="font-mono">{r.username}</span>],
              ['需求', needsText(r)],
              ['預計使用到', fmtDate(r.until)],
              ['用途', <span key="p" className="whitespace-pre-wrap">{r.purpose}</span>],
              ['送出時間', fmtDateTime(r.created_at)],
              ...(r.updated_at !== r.created_at ? ([['最後修改', fmtDateTime(r.updated_at)]] as [string, string][]) : []),
            ]}
          />
        </div>
      </Section>
    </div>
  )
}

export default function RegisterView() {
  const a = useAccess()
  const [editing, setEditing] = useState(false)
  const q = useQuery({ queryKey: ['register'], queryFn: () => api.get<RegisterPage>('/api/register') })
  return (
    <>
      <PageHeader title="登記使用實驗室主機" description={`以 ${a.oauthName} 身分登記需求；助教會為你建立帳號並指派主機。`} />
      <QueryState query={q} skeleton={<SkeletonRows rows={6} />}>
        {(d) => {
          const r = d.registration
          if (a.user) {
            return (
              <p className="max-w-3xl rounded-lg border bg-muted/40 px-4 py-3 text-sm">
                你已經是實驗室成員（帳號 <span className="font-mono">{a.user.username}</span>），需要更多主機請到
                <Link to="/me#host-request" className="mx-1 font-medium text-primary hover:underline">
                  我的帳號
                </Link>
                申請使用其他主機。
              </p>
            )
          }
          if (r?.status === 'pending') {
            return editing ? <RegisterForm current={r} onDone={() => setEditing(false)} /> : <Waiting r={r} onEdit={() => setEditing(true)} />
          }
          if (!d.can_register) return <p className="text-sm text-muted-foreground">目前無法登記，請聯絡管理員。</p>
          return (
            <div className="grid gap-4">
              {r?.status === 'rejected' && (
                <p className="max-w-3xl rounded-lg border border-destructive/30 bg-crit-soft px-4 py-3 text-sm" data-testid="registration-rejected">
                  <Pill tone="crit" className="mr-2">
                    已退回
                  </Pill>
                  你的登記已被退回（{fmtDate(r.decided_at)}）{r.reject_reason ? `：${r.reject_reason}` : ''}。
                  可修改後重新送出：下方已填入上次的內容。
                </p>
              )}
              <RegisterForm current={null} from={r?.status === 'rejected' ? r : undefined} onDone={() => setEditing(false)} />
            </div>
          )
        }}
      </QueryState>
    </>
  )
}
