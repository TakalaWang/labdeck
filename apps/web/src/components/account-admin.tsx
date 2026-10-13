import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, UserPlus } from 'lucide-react'
import { useId, useState } from 'react'

import { PersonPicker } from '@/components/assign-hosts'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useJobToast } from '@/hooks/use-job-toast'
import { api } from '@/lib/api'
import type { AssignResult, JobRef, Person } from '@/lib/types'

/**
 * 刪除主機帳號 (one host): a previewed users job. Removing the home directory needs the username typed in.
 */
export function DeleteAccountDialog({ host, username, onDone }: { host: string; username: string; onDone?: () => void }) {
  const id = useId()
  const jobToast = useJobToast()
  const [open, setOpen] = useState(false)
  const [home, setHome] = useState(false)
  const [typed, setTyped] = useState('')
  const m = useMutation({
    mutationFn: () =>
      api.post<JobRef>(`/api/admin/hosts/${encodeURIComponent(host)}/accounts/${encodeURIComponent(username)}/delete`, {
        remove_home: home,
        confirm: typed.trim(),
      }),
    onSuccess: (r) => {
      jobToast(`刪除 ${host} 上的 ${username}（請到工作頁確認預覽）`, r.job_id)
      setOpen(false)
      onDone?.()
    },
  })
  const ok = !home || typed.trim() === username
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) {
          setHome(false)
          setTyped('')
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label={`刪除 ${username}`} title="刪除這台主機上的帳號">
          <Trash2 className="size-4 text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            刪除 {host} 上的 <span className="font-mono">{username}</span>？
          </DialogTitle>
          <DialogDescription>
            只刪這台主機上的帳號（userdel），其他主機不變。會先產生預覽工作，到工作頁確認後才執行；帳號仍有程序在跑時會失敗。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex items-start gap-2">
            <Checkbox id={`${id}-home`} checked={home} onCheckedChange={(c) => setHome(c === true)} className="mt-0.5" />
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
              <Input id={`${id}-c`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button variant="destructive" disabled={!ok || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? '處理中…' : home ? '刪除帳號與家目錄' : '刪除帳號'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const filter = (p: Person) => p.status === 'active' && !existing.has(p.id)
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
