import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Lock, Trash2, UserPlus } from 'lucide-react'
import { useId, useState } from 'react'

import { PersonPicker } from '@/components/assign-hosts'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useJobToast } from '@/hooks/use-job-toast'
import { api } from '@/lib/api'
import type { AssignResult, Desired, JobRef, Person } from '@/lib/types'

/** Clears the home-directory option when a dialog closes. */
function useHomeChoice() {
  const [home, setHome] = useState(false)
  const [typed, setTyped] = useState('')
  const reset = () => {
    setHome(false)
    setTyped('')
  }
  return { home, setHome, typed, setTyped, reset }
}

/**
 * 同時刪除家目錄 with its guard: the username typed exactly. Shared by 刪除 (one host) and 移除成員 (per host).
 */
export function HomeOption({
  id, username, home, onHome, typed, onTyped,
}: { id: string; username: string; home: boolean; onHome: (v: boolean) => void; typed: string; onTyped: (v: string) => void }) {
  return (
    <div className="grid gap-3">
      <div className="flex items-start gap-2">
        <Checkbox id={`${id}-home`} checked={home} onCheckedChange={(c) => onHome(c === true)} className="mt-0.5" />
        <Label htmlFor={`${id}-home`} className="grid gap-0.5 font-normal">
          <span className="font-medium">同時刪除家目錄</span>
          <span className="text-xs text-muted-foreground">檔案無法復原。只在家目錄是這個帳號自己的目錄時才刪除。</span>
        </Label>
      </div>
      {home && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-c`}>
            請輸入 <code className="rounded bg-muted px-1 font-mono">{username}</code> 以確認刪除家目錄
          </Label>
          <Input id={`${id}-c`} value={typed} onChange={(e) => onTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
      )}
    </div>
  )
}

type AccountDialogProps = { host: string; username: string; open: boolean; onOpenChange: (o: boolean) => void; onDone?: () => void }

/** 刪除主機帳號 (one host): a previewed users job. Removing the home directory needs the username typed in. */
function DeleteAccountDialog({ host, username, open, onOpenChange, onDone }: AccountDialogProps) {
  const id = useId()
  const jobToast = useJobToast()
  const h = useHomeChoice()
  const close = (o: boolean) => {
    onOpenChange(o)
    if (!o) h.reset()
  }
  const m = useMutation({
    mutationFn: () =>
      api.post<JobRef>(`/api/admin/hosts/${encodeURIComponent(host)}/accounts/${encodeURIComponent(username)}/delete`, {
        remove_home: h.home,
        confirm: h.typed.trim(),
      }),
    onSuccess: (r) => {
      jobToast(`刪除 ${host} 上的 ${username}（請到工作頁確認預覽）`, r.job_id)
      close(false)
      onDone?.()
    },
  })
  const ok = !h.home || h.typed.trim() === username
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            刪除 {host} 上的 <span className="font-mono">{username}</span>？
          </DialogTitle>
          <DialogDescription>
            只刪這台主機上的帳號（userdel），其他主機不變。會先產生預覽工作，到工作頁確認後才執行；帳號仍有程序在跑時會失敗。
          </DialogDescription>
        </DialogHeader>
        <HomeOption id={id} username={username} home={h.home} onHome={h.setHome} typed={h.typed} onTyped={h.setTyped} />
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            取消
          </Button>
          <Button variant="destructive" disabled={!ok || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? '處理中…' : h.home ? '刪除帳號與家目錄' : '刪除帳號'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 鎖定 (one host): login disabled, files kept; a previewed users job. Restored on the person page. */
function LockAccountDialog({ host, username, open, onOpenChange, onDone }: AccountDialogProps) {
  const jobToast = useJobToast()
  const m = useMutation({
    mutationFn: () => api.post<JobRef>(`/api/admin/hosts/${encodeURIComponent(host)}/accounts/${encodeURIComponent(username)}/lock`),
    onSuccess: (r) => {
      jobToast(`鎖定 ${host} 上的 ${username}（請到工作頁確認預覽）`, r.job_id)
      onOpenChange(false)
      onDone?.()
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            鎖定 {host} 上的 <span className="font-mono">{username}</span>？
          </DialogTitle>
          <DialogDescription>
            帳號無法再登入這台主機，家目錄與檔案都保留，其他主機不變。會先產生預覽工作，到工作頁確認後才執行；
            之後可在人員頁「停用／恢復主機帳號」恢復。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? '處理中…' : '鎖定帳號'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 移除 one account on one host (host page 使用者, person page 主機帳號): 鎖定 (a claimed account) or 刪除 (one that is
 * on the host), each a previewed job. Reserved accounts and the bot never get the menu.
 */
export function RemoveAccountMenu({
  host, username, claimed, exists, desired, onDone,
}: {
  host: string
  username: string
  /** managed and linked to a person: only those can be locked */
  claimed: boolean
  exists: boolean
  desired: Desired | null
  onDone?: () => void
}) {
  const [dialog, setDialog] = useState<'lock' | 'delete' | null>(null)
  const set = (o: boolean) => !o && setDialog(null)
  const lockWhy = !claimed ? '沒有人認領的帳號只能刪除' : desired === 'locked' ? '已停用' : null
  const deleteWhy = !exists ? '主機上沒有這個帳號' : null
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-muted-foreground" aria-label={`移除 ${username}`}>
            移除 <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem disabled={!!lockWhy} onSelect={() => setDialog('lock')} className="items-start">
            <Lock className="mt-0.5" />
            <span className="grid">
              <span>鎖定…</span>
              <span className="text-xs text-muted-foreground">{lockWhy ?? '停止登入、保留檔案，可恢復'}</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" disabled={!!deleteWhy} onSelect={() => setDialog('delete')} className="items-start">
            <Trash2 className="mt-0.5" />
            <span className="grid">
              <span>刪除…</span>
              <span className="text-xs text-muted-foreground">{deleteWhy ?? 'userdel，可選擇連家目錄一起刪'}</span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <LockAccountDialog host={host} username={username} open={dialog === 'lock'} onOpenChange={set} onDone={onDone} />
      <DeleteAccountDialog host={host} username={username} open={dialog === 'delete'} onOpenChange={set} onDone={onDone} />
    </>
  )
}

/** Host page: add an active member to this host — a scoped job, no preview (quick assign). */
export function AddUserToHost({ host, existing, onDone }: { host: string; existing: Set<number>; onDone?: () => void }) {
  const qc = useQueryClient()
  const jobToast = useJobToast()
  const [open, setOpen] = useState(false)
  const [pid, setPid] = useState<number | null>(null)
  const m = useMutation({
    mutationFn: (id: number) => api.post<AssignResult>(`/api/admin/people/${id}/assign`, { hosts: [host] }),
    onSuccess: (r) => {
      jobToast(`已指派 ${host}（不需預覽）`, r.jobs[0]?.job_id)
      void qc.invalidateQueries({ queryKey: ['people'] })
      setOpen(false)
      setPid(null)
      onDone?.()
    },
  })
  const filter = (p: Person) => p.status === 'active' && !p.removed_at && !existing.has(p.id)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <UserPlus /> 新增使用者
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增使用者到 {host}</DialogTitle>
          <DialogDescription>選擇人員後立即建立或開通他在這台主機的帳號（只動這個帳號，不需預覽）。</DialogDescription>
        </DialogHeader>
        <PersonPicker filter={filter} value={pid} onChange={setPid} label="搜尋人員" />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button disabled={pid === null || m.isPending} onClick={() => pid !== null && m.mutate(pid)}>
            {m.isPending ? '處理中…' : '指派'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
