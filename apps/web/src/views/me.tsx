import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Hourglass, KeyRound, ShieldAlert, TriangleAlert } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { Link } from '@/lib/router'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyBlock, CopyButton } from '@/components/copy-button'
import { NeedsFields, emptyNeeds, needsOf, needsText, type NeedsDraft } from '@/components/needs-fields'
import { NotifySettingsSection } from '@/components/notify-settings'
import { PageHeader, Section, TableWrap } from '@/components/page'
import { EmptyState, QueryState, SkeletonRows } from '@/components/states'
import { Pill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { daysUntil, fmtBytes, fmtCores, fmtDate, fmtDateTime, fmtNum, fmtRelative } from '@/lib/format'
import { ROLE_LABEL, requestStatus } from '@/lib/labels'
import type { AccountRequest, HostRequestPage, Me as MeT, MyAccount, MyUsage, Needs, SshKey } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * The temp password: shown (also after a reload) until its owner presses 「我已記下」, which deletes it for good.
 * The API only returns it once a job creating the account succeeded.
 */
function TempPassword({ value }: { value: string }) {
  const qc = useQueryClient()
  const ack = useMutation({
    mutationFn: () => api.post<Record<string, never>>('/api/me/temp-password/ack'),
    onSuccess: () => {
      toast.success('臨時密碼已從系統刪除')
      void qc.invalidateQueries({ queryKey: ['me'] })
    },
  })
  return (
    <section aria-labelledby="temp-pw-title" className="mb-6 rounded-xl border-2 border-warn bg-warn-soft p-4 sm:p-5" data-testid="temp-password-box">
      <h2 id="temp-pw-title" className="flex items-center gap-2 font-semibold text-warn-ink">
        <ShieldAlert className="size-4.5" aria-hidden="true" /> 帳號已開通：請記下臨時密碼
      </h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code
          data-testid="temp-password"
          className="rounded-md border bg-background px-3 py-1.5 font-mono text-base tracking-wider select-all"
        >
          {value}
        </code>
        <CopyButton text={value} label="複製臨時密碼" />
      </div>
      <p className="mt-3 max-w-prose text-sm text-foreground/90">
        此臨時密碼適用於所有新建的主機帳號；改密碼後各主機各自獨立。
        <strong>第一次請用終端機 ssh 互動登入並改密碼（見下方「連線」）；改好之前 VS Code Remote-SSH、scp 等非互動連線會失敗。</strong>
      </p>
      <p className="mt-1 max-w-prose text-sm text-foreground/90">按「我已記下」後系統會刪除這個密碼，之後無法再查看。</p>
      <Button size="sm" variant="outline" className="mt-3" disabled={ack.isPending} onClick={() => ack.mutate()}>
        {ack.isPending ? '處理中…' : '我已記下'}
      </Button>
    </section>
  )
}

/** Accounts being created (no password to show yet), or their jobs failed. */
function SetupNotice({ state }: { state: 'pending' | 'failed' }) {
  return state === 'pending' ? (
    <div role="status" data-testid="account-setup" data-state="pending" className="mb-6 flex items-start gap-2 rounded-lg border bg-accent/40 px-4 py-3 text-sm">
      <Hourglass className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      <span>帳號建立中，完成後會在這裡顯示臨時密碼。通常幾分鐘內完成，請稍後重新整理。</span>
    </div>
  ) : (
    <div role="alert" data-testid="account-setup" data-state="failed" className="mb-6 flex items-start gap-2 rounded-lg border border-destructive/30 bg-crit-soft px-4 py-3 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <span>開通失敗，助教已收到通知，會處理後重新建立。各主機的狀態見下方「主機帳號」。</span>
    </div>
  )
}

function accountState(a: MyAccount) {
  if (a.desired === 'locked') return <Pill tone="muted">已停用</Pill>
  if (a.desired === 'absent') return <Pill tone="muted">已刪除</Pill>
  if (!a.exists) {
    if (a.job_status === 'failed' || a.job_status === 'check_failed') return <Pill tone="crit">開通失敗</Pill>
    if (a.job_status === 'ok') return <Pill tone="ok">已建立</Pill>
    return <Pill tone="warn">建立中</Pill>
  }
  if (a.locked) return <Pill tone="crit">已鎖定</Pill>
  return <Pill tone="ok">可使用</Pill>
}

/** A ~/.ssh/config block for the open accounts, so `ssh gpu01` works (key login once a key is added). */
function SshConfigHint({ accounts }: { accounts: MyAccount[] }) {
  const open = accounts.filter((a) => a.address && a.desired === 'present')
  if (!open.length) return null
  const text = open
    .map((a) => `Host ${a.host}\n    HostName ${a.address}\n    User ${a.username}\n    IdentityFile ~/.ssh/id_ed25519`)
    .join('\n\n')
  return (
    <details className="mt-3 max-w-3xl text-sm">
      <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">
        想直接打 <code className="font-mono">ssh {open[0].host}</code>？把這段加進自己電腦的 <code className="font-mono">~/.ssh/config</code>
      </summary>
      <div className="mt-2">
        <CopyBlock text={text} label="複製 ~/.ssh/config 設定" />
        <p className="mt-1 text-xs text-muted-foreground">第一次登入仍要用終端機輸入臨時密碼並改密碼；上傳 SSH 金鑰後即可免密碼登入。</p>
      </div>
    </details>
  )
}

function Expiry({ date }: { date: string | null }) {
  const d = daysUntil(date)
  if (!date) return <span className="text-muted-foreground">不限</span>
  return (
    <span className={cn(d !== null && d <= 30 && 'font-medium text-warn-ink', d !== null && d < 0 && 'text-destructive')}>
      {fmtDate(date)}
      {d !== null && d <= 30 && <span className="ml-1 text-xs">（{d >= 0 ? `剩 ${d} 天` : '已過期'}）</span>}
    </span>
  )
}

function Keys({ keys }: { keys: SshKey[] }) {
  const id = useId()
  const qc = useQueryClient()
  const [pubkey, setPubkey] = useState('')
  const add = useMutation({
    mutationFn: (k: string) => api.post<{ key: SshKey; job_id: number | null }>('/api/me/keys', { pubkey: k }),
    onSuccess: (r) => {
      toast.success(r.job_id ? '已新增 SSH 金鑰，正在部署到你的主機帳號' : '已新增 SSH 金鑰')
      setPubkey('')
      void qc.invalidateQueries({ queryKey: ['me'] })
    },
  })
  const revoke = useMutation({
    mutationFn: (keyId: number) => api.post<{ job_id: number | null }>(`/api/me/keys/${keyId}/revoke`),
    onSuccess: () => {
      toast.success('已撤銷 SSH 金鑰，正在從主機帳號移除')
      void qc.invalidateQueries({ queryKey: ['me'] })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const k = pubkey.trim()
    if (k) add.mutate(k)
  }

  return (
    <>
      {keys.length === 0 ? (
        <EmptyState title="尚未新增 SSH 金鑰" icon={<KeyRound className="size-6" />} className="py-6">
          在下方貼上你的公鑰，會自動部署到你所有可使用的主機帳號。
        </EmptyState>
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
                <TableHead className="w-20">
                  <span className="sr-only">動作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k.id} className={cn(k.state === 'revoked' && 'text-muted-foreground')}>
                  <TableCell>{k.type}</TableCell>
                  <TableCell className="font-mono text-xs">{k.fingerprint}</TableCell>
                  <TableCell className="max-w-48 truncate">{k.comment || '—'}</TableCell>
                  <TableCell title={fmtDateTime(k.added_at)}>{fmtDate(k.added_at)}</TableCell>
                  <TableCell>{k.state === 'active' ? <Pill tone="ok">有效</Pill> : <Pill tone="muted">已撤銷</Pill>}</TableCell>
                  <TableCell>
                    {k.state === 'active' && (
                      <ConfirmDialog
                        trigger={
                          <Button variant="destructive" size="sm">
                            撤銷
                          </Button>
                        }
                        title="撤銷這把 SSH 金鑰？"
                        description={
                          <>
                            <span className="font-mono text-xs break-all">{k.fingerprint}</span>
                            <br />會從你所有主機帳號的 authorized_keys 移除。
                          </>
                        }
                        confirmLabel="撤銷"
                        onConfirm={() => revoke.mutateAsync(k.id)}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableWrap>
      )}
      <form onSubmit={submit} className="mt-4 grid max-w-3xl gap-2">
        <Label htmlFor={`${id}-pk`}>新增 SSH 公鑰</Label>
        <Textarea
          id={`${id}-pk`}
          rows={3}
          required
          value={pubkey}
          onChange={(e) => setPubkey(e.target.value)}
          placeholder="ssh-ed25519 AAAA… you@laptop"
          className="font-mono text-xs"
          spellCheck={false}
          aria-describedby={`${id}-pk-hint`}
        />
        <p id={`${id}-pk-hint`} className="text-xs text-muted-foreground">
          單行，ssh-ed25519 / ecdsa-sha2-nistp256 / ssh-rsa（≥ 3072 bits）。請貼公鑰（<code>.pub</code> 檔）內容，不要貼私鑰。
        </p>
        <div>
          <Button type="submit" disabled={add.isPending || !pubkey.trim()}>
            {add.isPending ? '新增中…' : '新增'}
          </Button>
        </div>
      </form>
    </>
  )
}

/** 申請使用其他主機: needs only, one pending request at a time; an admin picks the hosts on 待指派. */
function HostRequest() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['me', 'host-requests'], queryFn: () => api.get<HostRequestPage>('/api/me/host-requests') })
  const [needs, setNeeds] = useState<NeedsDraft>(emptyNeeds)
  const m = useMutation({
    mutationFn: (body: Needs) => api.post<AccountRequest>('/api/me/host-requests', body),
    onSuccess: () => {
      toast.success('已送出申請。助教指派後會通知你，也可以隨時回到我的帳號查看')
      setNeeds(emptyNeeds)
      void qc.invalidateQueries({ queryKey: ['me', 'host-requests'] })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    m.mutate(needsOf(needs))
  }
  return (
    <QueryState query={q} skeleton={<SkeletonRows rows={3} />}>
      {(d) => (
        <div className="grid gap-4">
          {d.requests.length > 0 && (
            <TableWrap>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>申請時間</TableHead>
                    <TableHead>需求</TableHead>
                    <TableHead>狀態</TableHead>
                    <TableHead>指派的主機</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.requests.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{fmtDateTime(r.created_at)}</TableCell>
                      <TableCell className="max-w-72 truncate" title={r.purpose}>
                        {needsText(r)}
                        {r.until && <span className="text-muted-foreground"> · 到 {fmtDate(r.until)}</span>}
                      </TableCell>
                      <TableCell className="max-w-64 whitespace-normal">
                        <Pill tone={requestStatus(r).tone}>{requestStatus(r).label}</Pill>
                        {r.reject_reason && <span className="ml-2 text-xs text-muted-foreground">原因：{r.reject_reason}</span>}
                      </TableCell>
                      <TableCell>{r.hosts.join('、') || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableWrap>
          )}
          {!d.can_request ? (
            <p data-testid="host-request-pending" className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
              你的申請正在等待助教指派。助教指派後會通知你，也可以隨時回到我的帳號查看。
            </p>
          ) : (
            <form onSubmit={submit} className="grid max-w-3xl gap-4" aria-label="申請使用其他主機">
              <NeedsFields value={needs} onChange={setNeeds} />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={m.isPending}>
                  {m.isPending ? '送出中…' : '送出申請'}
                </Button>
                <span className="text-xs text-muted-foreground">助教依需求挑選主機；帳號名稱與 SSH 金鑰沿用現有的。</span>
              </div>
            </form>
          )}
        </div>
      )}
    </QueryState>
  )
}

function Usage({ username }: { username: string }) {
  const q = useQuery({ queryKey: ['me', 'usage'], queryFn: () => api.get<MyUsage>('/api/me/usage'), refetchInterval: 15_000 })
  return (
    <QueryState query={q} skeleton={<SkeletonRows rows={3} />}>
      {(u) => (
        <div className="grid gap-6 xl:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-medium">CPU / 記憶體</h3>
            {u.cpu_mem.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                目前沒有執行中的程序。
              </p>
            ) : (
              <TableWrap>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>主機</TableHead>
                      <TableHead className="text-right">CPU</TableHead>
                      <TableHead className="text-right">記憶體</TableHead>
                      <TableHead className="text-right">程序</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {u.cpu_mem.map((r) => (
                      <TableRow key={r.host}>
                        <TableCell>
                          <Link to={`/hosts/${encodeURIComponent(r.host)}?tab=users`} className="hover:underline">
                            {r.host}
                          </Link>
                        </TableCell>
                        <TableCell className="num text-right">{fmtCores(r.cpu_cores)}</TableCell>
                        <TableCell className="num text-right">{fmtBytes(r.mem_bytes)}</TableCell>
                        <TableCell className="num text-right">{fmtNum(r.processes)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableWrap>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              <Link to={`/usage?tab=cpu&q=${encodeURIComponent(username)}`} className="text-primary hover:underline">
                與主機上其他使用者比較
              </Link>
            </p>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">正在執行的 GPU 程序</h3>
            {u.gpu_processes.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                目前沒有使用 GPU。<Link to="/usage?tab=gpu&idle=1" className="ml-1 text-primary hover:underline">找閒置的卡</Link>
              </p>
            ) : (
              <TableWrap>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>主機</TableHead>
                      <TableHead className="text-right">GPU</TableHead>
                      <TableHead className="text-right">PID</TableHead>
                      <TableHead>程式</TableHead>
                      <TableHead className="text-right">記憶體</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {u.gpu_processes.map((p) => (
                      <TableRow key={`${p.host}:${p.gpu}:${p.pid}`}>
                        <TableCell>{p.host}</TableCell>
                        <TableCell className="num text-right">#{p.gpu}</TableCell>
                        <TableCell className="num text-right">{p.pid}</TableCell>
                        <TableCell className="font-mono text-xs">{p.comm}</TableCell>
                        <TableCell className="num text-right">{fmtBytes(p.mem_bytes)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableWrap>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">磁碟用量</h3>
            {u.disk.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">尚無掃描資料。</p>
            ) : (
              <TableWrap>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>主機</TableHead>
                      <TableHead>路徑</TableHead>
                      <TableHead className="text-right">用量</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...u.disk]
                      .sort((a, b) => b.bytes - a.bytes)
                      .map((d) => (
                        <TableRow key={`${d.host}:${d.path}`}>
                          <TableCell>{d.host}</TableCell>
                          <TableCell className="font-mono text-xs">{d.path}</TableCell>
                          <TableCell className="num text-right">{fmtBytes(d.bytes)}</TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </TableWrap>
            )}
          </div>
        </div>
      )}
    </QueryState>
  )
}

export default function Me() {
  // GET /api/me changes nothing: the temp password stays until 「我已記下」; poll while accounts are being created
  const q = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<MeT>('/api/me'),
    refetchInterval: (query) => (query.state.data?.account_setup === 'pending' ? 10_000 : false),
  })

  return (
    <QueryState query={q} skeleton={<SkeletonRows rows={8} />}>
      {(me) => (
        <>
          <PageHeader
            title="我的帳號"
            actions={
              <Button asChild size="sm" variant="outline">
                <Link to="/guide">
                  <BookOpen /> 新成員指南
                </Link>
              </Button>
            }
            description={
              <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono">{me.person.username}</span>
                <Pill tone="muted">{ROLE_LABEL[me.person.role]}</Pill>
                <span>
                  實驗室帳號到期：<Expiry date={me.person.expires_at} />
                </span>
              </span>
            }
          />
          {me.temp_password ? <TempPassword value={me.temp_password} /> : me.account_setup && <SetupNotice state={me.account_setup} />}

          <Section title="主機帳號" description="所有主機使用同一個帳號名稱與 UID。">
            {me.accounts.length === 0 ? (
              <EmptyState title="尚未開通任何主機" className="py-6">
                請聯絡網管開通需要的主機。
              </EmptyState>
            ) : (
              <TableWrap>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>主機</TableHead>
                      <TableHead>帳號</TableHead>
                      <TableHead className="text-right">UID</TableHead>
                      <TableHead>狀態</TableHead>
                      <TableHead>連線</TableHead>
                      <TableHead>主機上的到期日</TableHead>
                      <TableHead>最後活動</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {me.accounts.map((a) => (
                      <TableRow key={a.host}>
                        <TableCell>
                          <Link to={`/hosts/${encodeURIComponent(a.host)}`} className="font-medium hover:underline">
                            {a.host}
                          </Link>
                        </TableCell>
                        <TableCell className="font-mono">{a.username}</TableCell>
                        <TableCell className="num text-right">{a.uid ?? '—'}</TableCell>
                        <TableCell>{accountState(a)}</TableCell>
                        <TableCell>
                          {a.address && a.desired === 'present' ? (
                            <span className="inline-flex items-center gap-1">
                              <code className="font-mono text-xs whitespace-nowrap" data-testid={`ssh-${a.host}`}>
                                ssh {a.username}@{a.address}
                              </code>
                              <CopyButton text={`ssh ${a.username}@${a.address}`} label={`複製 ${a.host} 的 ssh 指令`} />
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Expiry date={a.expires} />
                        </TableCell>
                        <TableCell title={fmtDateTime(a.last_active)}>{fmtRelative(a.last_active)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableWrap>
            )}
            <SshConfigHint accounts={me.accounts} />
          </Section>

          <Section id="host-request" title="申請使用其他主機" description="填寫需求，助教會挑選合適的主機並自動開通。">
            <HostRequest />
          </Section>

          <Section title="SSH 金鑰">
            <Keys keys={me.keys} />
          </Section>

          <NotifySettingsSection />

          <Section title="我的用量">
            <Usage username={me.person.username} />
          </Section>
        </>
      )}
    </QueryState>
  )
}
