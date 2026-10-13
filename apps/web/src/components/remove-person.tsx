import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UserMinus } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'

import { HomeOption } from '@/components/account-admin'
import { Pill } from '@/components/status'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { useNavigate } from '@/lib/router'
import { useAccess } from '@/lib/session'
import type { MyAccount, Person, PersonDetail, RemoveHostChoice, RemovePersonResult } from '@/lib/types'
import { cn } from '@/lib/utils'

type Choice = { action: 'lock' | 'delete'; home: boolean; typed: string }
const LOCK: Choice = { action: 'lock', home: false, typed: '' }

/** The accounts 移除成員 decides on (same rule as the API): managed ones that are not already deleted. */
const removable = (accounts: MyAccount[]) => accounts.filter((a) => !(a.desired === 'absent' && !a.exists))

function accountPill(a: MyAccount) {
  if (a.desired === 'absent') return <Pill tone="warn">待刪除</Pill>
  if (!a.exists) return <Pill tone="muted">主機上尚未建立</Pill>
  if (a.locked || a.desired === 'locked') return <Pill tone="muted">已停用</Pill>
  return <Pill tone="ok">使用中</Pill>
}

/** 鎖定／刪除 as a two-option segmented control. */
function ActionToggle({ value, onChange, canDelete, label }: {
  value: Choice['action']
  onChange: (v: Choice['action']) => void
  canDelete: boolean
  label: string
}) {
  const opt = (v: Choice['action'], text: string, disabled = false) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === v}
      disabled={disabled}
      onClick={() => onChange(v)}
      className={cn(
        'h-7 rounded-[5px] px-3 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        value === v
          ? v === 'delete' ? 'bg-background text-destructive shadow-xs ring-1 ring-destructive/40' : 'bg-background text-foreground shadow-xs ring-1 ring-border'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {text}
    </button>
  )
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-md bg-muted p-0.5">
      {opt('lock', '鎖定')}
      {opt('delete', '刪除', !canDelete)}
    </div>
  )
}

function HostRow({ a, c, onChange }: { a: MyAccount; c: Choice; onChange: (c: Choice) => void }) {
  const id = useId()
  return (
    <li className="grid gap-3 py-3 first:pt-0 last:pb-0" data-testid={`remove-host-${a.host}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{a.host}</span>
            <span className="font-mono text-muted-foreground">{a.username}</span>
            {accountPill(a)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {c.action === 'lock'
              ? '停止登入，家目錄與檔案保留，可恢復'
              : a.exists ? '從主機刪除帳號（userdel）' : '主機上尚未看到這個帳號，只能鎖定'}
          </p>
        </div>
        <ActionToggle
          label={`${a.host} 的處理方式`}
          value={c.action}
          canDelete={a.exists}
          onChange={(action) => onChange({ action, home: false, typed: '' })}
        />
      </div>
      {c.action === 'delete' && (
        <div className="rounded-lg bg-muted/50 p-3">
          <HomeOption
            id={id}
            username={a.username}
            home={c.home}
            onHome={(home) => onChange({ ...c, home, typed: '' })}
            typed={c.typed}
            onTyped={(typed) => onChange({ ...c, typed })}
          />
        </div>
      )}
    </li>
  )
}

function RemoveForm({ p, d, onClose }: { p: Person; d: PersonDetail; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const accounts = removable(d.accounts)
  const [chosen, setChoices] = useState<Record<string, Choice>>({})
  const choices = Object.fromEntries(accounts.map((a) => [a.host, chosen[a.host] ?? LOCK]))
  const m = useMutation({
    mutationFn: (hosts: RemoveHostChoice[]) => api.post<RemovePersonResult>(`/api/admin/people/${p.id}/remove`, { hosts }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['person', String(p.id)] })
      void qc.invalidateQueries({ queryKey: ['people'] })
      if (r.jobs.length === 0) toast.success(`已移除 ${p.username}`)
      else {
        toast.success(`已移除 ${p.username}，建立 ${r.jobs.length} 個預覽工作，請到工作頁確認`, {
          action: {
            label: '查看',
            onClick: () => navigate(r.jobs.length === 1 ? `/admin/jobs/${r.jobs[0].job_id}` : '/admin/ops?tab=jobs'),
          },
        })
      }
      onClose()
    },
  })
  const bad = accounts.filter((a) => {
    const c = choices[a.host]
    return c.action === 'delete' && c.home && c.typed.trim() !== a.username
  })
  const deletes = accounts.filter((a) => choices[a.host].action === 'delete').length
  const submit = () =>
    m.mutate(accounts.map((a) => {
      const c = choices[a.host]
      return { host: a.host, action: c.action, remove_home: c.action === 'delete' && c.home, confirm: c.typed.trim() }
    }))
  return (
    <>
      <ul className="grid list-disc gap-1 pl-5 text-sm text-muted-foreground marker:text-border">
        <li>人員狀態改為「已移除」，清除 SSO 身分與 Discord／Email 通知連結，對方無法再以成員登入。</li>
        <li>等待中的登記與主機申請一併關閉；人員紀錄保留，可在人員列表「已移除」查到。</li>
        <li>主機帳號依下方選擇，每台排一個預覽工作，到工作頁確認後才會執行。</li>
      </ul>
      {accounts.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">沒有主機帳號，只會移除人員。</p>
      ) : (
        <section aria-label="主機帳號" className="grid gap-2">
          <h3 className="text-sm font-medium">主機帳號（{accounts.length}）</h3>
          <ul className="max-h-[45vh] divide-y overflow-y-auto rounded-lg border px-3 py-3">
            {accounts.map((a) => (
              <HostRow key={a.host} a={a} c={choices[a.host]} onChange={(c) => setChoices((s) => ({ ...s, [a.host]: c }))} />
            ))}
          </ul>
        </section>
      )}
      <DialogFooter className="items-center">
        {bad.length > 0 && (
          <p className="mr-auto text-xs text-muted-foreground">刪除家目錄需輸入帳號名稱確認：{bad.map((a) => a.host).join('、')}</p>
        )}
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button variant="destructive" disabled={bad.length > 0 || m.isPending} onClick={submit}>
          {m.isPending ? '處理中…' : deletes ? `移除成員（刪除 ${deletes} 台）` : '移除成員'}
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * 移除成員 (offboarding), on the person page and as a row action in 人員: per host account 鎖定 (default) or 刪除
 * (+ home, typed guard), then the person is removed. Never oneself; the API also refuses the last active admin.
 */
export function RemovePersonDialog({ p, compact = false }: { p: Person; compact?: boolean }) {
  const a = useAccess()
  const [open, setOpen] = useState(false)
  const d = useQuery({
    queryKey: ['person', String(p.id)],
    queryFn: () => api.get<PersonDetail>(`/api/admin/people/${p.id}`),
    enabled: open,
  })
  if (p.removed_at) return null
  const self = a.user?.id === p.id
  const who = p.name ? `${p.name}（${p.username}）` : p.username
  const button = (
    <Button
      size="sm"
      variant={compact ? 'ghost' : 'outline'}
      disabled={self}
      className={cn(compact ? 'h-7 px-2 text-muted-foreground' : 'text-destructive hover:text-destructive')}
      aria-label={`移除成員 ${p.username}`}
      data-testid="remove-person"
    >
      <UserMinus /> {compact ? '移除' : '移除成員'}
    </Button>
  )
  if (self) {
    return (
      <span title="不能移除自己" className="inline-flex">
        {button}
      </span>
    )
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{button}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>移除成員 {who}？</DialogTitle>
          <DialogDescription>畢業或離開實驗室的成員。每台主機預設「鎖定」（可恢復）；確定不再需要的才選「刪除」。</DialogDescription>
        </DialogHeader>
        {d.data ? (
          <RemoveForm p={p} d={d.data} onClose={() => setOpen(false)} />
        ) : d.isError ? (
          <p className="text-sm text-destructive">無法載入主機帳號，請稍後再試。</p>
        ) : (
          <p className="text-sm text-muted-foreground">載入主機帳號…</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
