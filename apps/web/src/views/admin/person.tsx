import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, ShieldCheck, Star, UserPlus } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { Link, useParams } from '@/lib/router'
import { toast } from 'sonner'

import { RemoveAccountMenu } from '@/components/account-admin'
import { AssignHostPicker } from '@/components/assign-hosts'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader, Section, TableWrap } from '@/components/page'
import { RemovePersonDialog } from '@/components/remove-person'
import { QueryState, SkeletonRows } from '@/components/states'
import { Pill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useJobToast } from '@/hooks/use-job-toast'
import { api } from '@/lib/api'
import { daysUntil, fmtDate, fmtDateTime, fmtRelative } from '@/lib/format'
import { DESIRED_LABEL, ROLE_LABEL, personStatus } from '@/lib/labels'
import { useAccess } from '@/lib/session'
import type { AssignResult, JobIdMaybe, Person, PersonDetail, PersonInput, PersonStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

function EditForm({ p, oauthName, isSelf }: { p: Person; oauthName: string; isSelf: boolean }) {
  const id = useId()
  const qc = useQueryClient()
  const [v, setV] = useState<PersonInput>({
    name: p.name,
    email: p.email,
    sso_id: p.sso_id,
    expires_at: p.expires_at,
    status: p.status,
  })
  const set = <K extends keyof PersonInput>(k: K, val: PersonInput[K]) => setV((s) => ({ ...s, [k]: val }))
  const m = useMutation({
    mutationFn: (body: PersonInput) => api.put<Person>(`/api/admin/people/${p.id}`, body),
    onSuccess: () => {
      toast.success('已儲存')
      void qc.invalidateQueries({ queryKey: ['person', String(p.id)] })
      void qc.invalidateQueries({ queryKey: ['people'] })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const clean = (s: string | null) => (s && s.trim() ? s.trim() : null)
    m.mutate({ ...v, name: clean(v.name), email: clean(v.email), sso_id: clean(v.sso_id), expires_at: v.expires_at || null })
  }
  const text = (k: 'name' | 'email' | 'sso_id', label: string, type = 'text') => (
    <div className="grid gap-1.5">
      <Label htmlFor={`${id}-${k}`}>{label}</Label>
      <Input id={`${id}-${k}`} type={type} value={v[k] ?? ''} onChange={(e) => set(k, e.target.value)} autoComplete="off" />
    </div>
  )
  return (
    <form onSubmit={submit} className="grid max-w-3xl gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {text('name', '姓名')}
        {text('sso_id', `${oauthName} ID`)}
        {text('email', 'Email', 'email')}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-exp`}>到期日</Label>
          <Input id={`${id}-exp`} type="date" value={v.expires_at ?? ''} onChange={(e) => set('expires_at', e.target.value || null)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-st`}>狀態</Label>
          <Select value={v.status} onValueChange={(s) => set('status', s as PersonStatus)} disabled={isSelf}>
            <SelectTrigger id={`${id}-st`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">啟用</SelectItem>
              <SelectItem value="locked">鎖定（停用所有主機帳號）</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {isSelf && <p className="text-xs text-muted-foreground">不能鎖定自己。</p>}
      <div>
        <Button type="submit" disabled={m.isPending}>
          {m.isPending ? '儲存中…' : '儲存'}
        </Button>
      </div>
    </form>
  )
}

/**
 * 設為管理員: a confirm dialog naming the person. There is no way back on the web (api.md 人員): only the server CLI
 * (labdeck demote-admin) removes admin rights, so the dialog says so.
 */
export function PromoteButton({ p }: { p: Person }) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () => api.post<Person>(`/api/admin/people/${p.id}/promote`),
    onSuccess: (r) => {
      toast.success(`已將 ${r.name || r.username} 設為管理員`)
      void qc.invalidateQueries({ queryKey: ['person', String(p.id)] })
      void qc.invalidateQueries({ queryKey: ['people'] })
    },
  })
  if (p.role === 'admin' || p.removed_at) return null
  const days = daysUntil(p.expires_at)
  const blocked = p.status !== 'active' ? '已鎖定' : days !== null && days < 0 ? '已到期' : null
  const who = p.name ? `${p.name}（${p.username}）` : p.username
  const button = (
    <Button size="sm" variant="outline" disabled={!!blocked} data-testid="promote">
      <ShieldCheck /> 設為管理員
    </Button>
  )
  if (blocked) {
    // a disabled button gets no pointer events: the reason sits on its wrapper
    return (
      <span title={`${blocked}的人員不能設為管理員`} className="inline-flex">
        {button}
      </span>
    )
  }
  return (
    <ConfirmDialog
      trigger={button}
      title={`將 ${who}${p.name ? '' : ' '}設為管理員？`}
      description={
        <div className="grid gap-2">
          <p>管理員可以指派主機、建立與刪除主機帳號、編輯所有人員與主機，並看到所有人的資料。</p>
          <p className="font-medium text-foreground">網頁上無法撤銷：移除管理員權限只能由伺服器管理者以 labdeck demote-admin 指令處理。</p>
        </div>
      }
      destructive={false}
      confirmLabel="設為管理員"
      onConfirm={() => m.mutateAsync()}
    />
  )
}

/**
 * 停用／恢復主機帳號: the person's existing accounts only — uncheck to lock one (nothing is deleted), check a locked one
 * to restore it; then 同步 (previewed). New hosts are added only by 「指派主機」 above.
 */
function Grants({ d }: { d: PersonDetail }) {
  const qc = useQueryClient()
  const jobToast = useJobToast()
  const rows = d.accounts.filter((a) => a.desired === 'present' || a.desired === 'locked')
  const [sel, setSel] = useState(() => new Set(rows.filter((a) => a.desired === 'present').map((a) => a.host)))
  const [errors, setErrors] = useState<{ host: string; error: string }[]>([])
  const dirty = rows.some((a) => (a.desired === 'present') !== sel.has(a.host))
  const save = useMutation({
    mutationFn: () => api.put<{ errors: { host: string; error: string }[] }>(`/api/admin/people/${d.person.id}/grants`, { hosts: [...sel] }),
    onSuccess: (r) => {
      setErrors(r.errors)
      if (r.errors.length === 0) toast.success('已更新，按「同步」並確認預覽後套用到主機')
      else toast.warning(`${r.errors.length} 台主機未更新`)
      void qc.invalidateQueries({ queryKey: ['person', String(d.person.id)] })
    },
  })
  const sync = useMutation({
    mutationFn: () => api.post<JobIdMaybe>(`/api/admin/people/${d.person.id}/sync`),
    onSuccess: (r) => jobToast(`同步 ${d.person.username}`, r.job_id),
  })
  const errFor = new Map(errors.map((e) => [e.host, e.error]))
  const group = new Map(d.hosts.map((h) => [h.name, h.group]))

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">還沒有任何主機帳號；用上方「指派主機」開通。</p>
  }
  return (
    <>
      <TableWrap>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">啟用</TableHead>
              <TableHead>主機</TableHead>
              <TableHead>群組</TableHead>
              <TableHead>主機上的帳號</TableHead>
              <TableHead>主要使用者</TableHead>
              <TableHead>備註</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => {
              const cid = `grant-${a.host}`
              return (
                <TableRow key={a.host} data-state={sel.has(a.host) ? 'selected' : undefined}>
                  <TableCell>
                    <Checkbox
                      id={cid}
                      aria-label={`${a.host} 的帳號啟用`}
                      checked={sel.has(a.host)}
                      onCheckedChange={(c) =>
                        setSel((s) => {
                          const n = new Set(s)
                          if (c === true) n.add(a.host)
                          else n.delete(a.host)
                          return n
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <label htmlFor={cid} className="font-medium">
                      {a.host}
                    </label>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{group.get(a.host) ?? '—'}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-2">
                      <span className="font-mono">{a.username}</span>
                      {a.desired === 'locked' ? (
                        <Pill tone="muted">停用</Pill>
                      ) : !a.exists ? (
                        <Pill tone="warn">待建立</Pill>
                      ) : a.locked ? (
                        <Pill tone="crit">鎖定</Pill>
                      ) : (
                        <Pill tone="ok">正常</Pill>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    {a.primary ? (
                      <span className="inline-flex items-center gap-1 text-xs">
                        <Star className="size-3.5 fill-warn text-warn" aria-hidden="true" /> 是
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs whitespace-normal text-destructive">{errFor.get(a.host)}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </TableWrap>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? '更新中…' : '更新'}
        </Button>
        <Button variant="outline" disabled={sync.isPending} onClick={() => sync.mutate()}>
          <RefreshCw className={cn(sync.isPending && 'animate-spin')} /> 同步
        </Button>
        <span className="text-xs text-muted-foreground">取消勾選 = 停用（鎖定）該主機帳號，不會刪除；重新勾選 = 恢復。更新後按「同步」並確認預覽才會套用。</span>
      </div>
    </>
  )
}

/** Quick assign: pick hosts, one scoped job each, applied without a preview (same as 待指派). */
function QuickAssign({ d }: { d: PersonDetail }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [hosts, setHosts] = useState<string[]>([])
  const m = useMutation({
    mutationFn: () => api.post<AssignResult>(`/api/admin/people/${d.person.id}/assign`, { hosts }),
    onSuccess: (r) => {
      toast.success(`已指派 ${r.jobs.map((j) => j.host).join('、')}，帳號建立中（${r.jobs.length} 個工作，不需預覽）`)
      setHosts([])
      setOpen(false)
      void qc.invalidateQueries({ queryKey: ['person', String(d.person.id)] })
      void qc.invalidateQueries({ queryKey: ['assign-hosts'] })
    },
  })
  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} disabled={d.person.status !== 'active'}>
        <UserPlus /> 指派主機…
      </Button>
    )
  }
  return (
    <div className="grid gap-3">
      <AssignHostPicker personId={d.person.id} needs={null} value={hosts} onChange={setHosts} />
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!hosts.length || m.isPending} onClick={() => m.mutate()}>
          <UserPlus /> {m.isPending ? '處理中…' : `指派 ${hosts.length} 台`}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          取消
        </Button>
      </div>
    </div>
  )
}

export default function AdminPerson() {
  const { id = '' } = useParams()
  const a = useAccess()
  const q = useQuery({ queryKey: ['person', id], queryFn: () => api.get<PersonDetail>(`/api/admin/people/${encodeURIComponent(id)}`) })
  return (
    <QueryState query={q} skeleton={<SkeletonRows rows={10} />}>
      {(d) => (
        <>
          <PageHeader
            title={d.person.username}
            description={
              <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>UID {d.person.uid ?? '未定'}</span>
                <Pill tone={personStatus(d.person).tone}>{personStatus(d.person).label}</Pill>
                <Pill tone={d.person.role === 'admin' ? 'info' : 'muted'}>{ROLE_LABEL[d.person.role]}</Pill>
                <span>建立於 {fmtDate(d.person.created_at)}</span>
              </span>
            }
            actions={
              <>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/admin/people">← 人員列表</Link>
                </Button>
                <PromoteButton p={d.person} />
                <RemovePersonDialog p={d.person} />
              </>
            }
          />
          {d.person.removed_at && (
            <p className="mb-6 rounded-lg border bg-muted/40 px-4 py-3 text-sm" data-testid="removed-banner">
              已於 {fmtDate(d.person.removed_at)} 移除：SSO 身分與通知連結已清除，無法以成員登入；紀錄保留供查詢。
              主機帳號的鎖定或刪除見下方「主機帳號」與工作頁。誤移除時把狀態改回「啟用」並重新填入 {a.oauthName} ID。
            </p>
          )}
          <Section title="基本資料">
            <EditForm key={d.person.id} p={d.person} oauthName={a.oauthName} isSelf={a.user?.id === d.person.id} />
          </Section>
          <Section
            title="指派主機"
            description="新增主機的唯一方式：立即建立或開通這個人在選定主機的帳號，每台一個只動這個帳號的工作，不需預覽（不寄信，請自行告知對方）。"
          >
            <QuickAssign key={d.person.id} d={d} />
          </Section>
          <Section title="停用／恢復主機帳號" description="只能停用或恢復已開通的主機帳號；新增主機請用上方「指派主機」。">
            <Grants key={JSON.stringify(d.accounts)} d={d} />
          </Section>
          <Section title="SSH 金鑰">
            {d.keys.length === 0 ? (
              <p className="text-sm text-muted-foreground">沒有 SSH 金鑰。</p>
            ) : (
              <TableWrap>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>類型</TableHead>
                      <TableHead>指紋</TableHead>
                      <TableHead>註解</TableHead>
                      <TableHead>新增時間</TableHead>
                      <TableHead>狀態</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.keys.map((k) => (
                      <TableRow key={k.id} className={cn(k.state === 'revoked' && 'text-muted-foreground')}>
                        <TableCell>{k.type}</TableCell>
                        <TableCell className="font-mono text-xs">{k.fingerprint}</TableCell>
                        <TableCell>{k.comment || '—'}</TableCell>
                        <TableCell>{fmtDateTime(k.added_at)}</TableCell>
                        <TableCell>{k.state === 'active' ? <Pill tone="ok">有效</Pill> : <Pill tone="muted">已撤銷</Pill>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableWrap>
            )}
          </Section>
          <Section title="主機帳號" description="每一列的「移除」：鎖定（停止登入、保留檔案）或刪除這台主機上的帳號，都會先產生預覽工作。">
            {d.accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">尚未開通任何主機。</p>
            ) : (
              <TableWrap>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>主機</TableHead>
                      <TableHead>帳號</TableHead>
                      <TableHead className="text-right">UID</TableHead>
                      <TableHead>期望</TableHead>
                      <TableHead>主機上的到期日</TableHead>
                      <TableHead>最後活動</TableHead>
                      <TableHead className="w-20">
                        <span className="sr-only">移除</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.accounts.map((ac) => (
                      <TableRow key={ac.host}>
                        <TableCell>
                          <Link to={`/hosts/${encodeURIComponent(ac.host)}`} className="hover:underline">
                            {ac.host}
                          </Link>
                        </TableCell>
                        <TableCell className="font-mono">{ac.username}</TableCell>
                        <TableCell className="num text-right">{ac.uid ?? '—'}</TableCell>
                        <TableCell>{DESIRED_LABEL[ac.desired]}</TableCell>
                        <TableCell>{fmtDate(ac.expires)}</TableCell>
                        <TableCell title={fmtDateTime(ac.last_active)}>{fmtRelative(ac.last_active)}</TableCell>
                        <TableCell className="text-right">
                          {ac.desired !== 'absent' && (
                            <RemoveAccountMenu
                              host={ac.host}
                              username={ac.username}
                              claimed
                              exists={ac.exists}
                              desired={ac.desired}
                              onDone={() => void q.refetch()}
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableWrap>
            )}
          </Section>
        </>
      )}
    </QueryState>
  )
}
