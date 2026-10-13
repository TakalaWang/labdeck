import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, MessageCircle } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from '@/lib/router'
import { toast } from 'sonner'

import { Section, TableWrap } from '@/components/page'
import { Pill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { useAccess } from '@/lib/session'
import type { NotifyChannel, NotifySettings } from '@/lib/types'

const KEY = ['me', 'notifications']
const LINK_RESULT: Record<string, [ok: boolean, message: string]> = {
  linked: [true, '已連結 Discord'],
  taken: [false, '這個 Discord 帳號已連結到其他成員'],
  error: [false, '無法連結 Discord，請再試一次'],
}

function ChannelRow({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-lg border p-3 sm:p-4">
      <span className="mt-0.5 text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
      <div className="grid min-w-0 flex-1 gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {children}
      </div>
    </div>
  )
}

function Discord({ s }: { s: NotifySettings['discord'] }) {
  const qc = useQueryClient()
  const unlink = useMutation({
    mutationFn: () => api.post<NotifySettings>('/api/me/discord/unlink'),
    onSuccess: (r) => {
      qc.setQueryData(KEY, r)
      toast.success('已解除 Discord 連結')
    },
  })
  return (
    <ChannelRow icon={<MessageCircle className="size-4" />} title="Discord">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {s.linked ? (
          <>
            <span data-testid="discord-linked">
              已連結 <strong className="font-medium">{s.name ?? 'Discord 帳號'}</strong>
            </span>
            <Button size="sm" variant="outline" disabled={unlink.isPending} onClick={() => unlink.mutate()}>
              解除連結
            </Button>
          </>
        ) : (
          <Button asChild size="sm">
            {/* a full-page redirect to Discord (OAuth2, scope identify) */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full-page redirect through the OAuth route handler */}
            <a href="/auth/discord/start">連結 Discord</a>
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">在實驗室的 Discord 頻道以 @提及 通知你（不是私訊）；只會讀取你的 Discord 使用者 ID 與名稱。</p>
    </ChannelRow>
  )
}

function Email({ s }: { s: NotifySettings['email'] }) {
  const id = useId()
  const qc = useQueryClient()
  const { oauthName } = useAccess()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const done = (r: NotifySettings) => qc.setQueryData(KEY, r)
  const send = useMutation({
    mutationFn: (v: string) => api.post<NotifySettings>('/api/me/email', { email: v }),
    onSuccess: (r) => {
      done(r)
      setEmail('')
      toast.success(r.email.pending ? `已寄出驗證碼到 ${r.email.pending}` : '已改用這個 Email')
    },
  })
  const verify = useMutation({
    mutationFn: (v: string) => api.post<NotifySettings>('/api/me/email/verify', { code: v }),
    onSuccess: (r) => {
      done(r)
      setCode('')
      toast.success('Email 已驗證')
    },
  })
  const fromSso = !!s.address && s.address === s.sso_address
  return (
    <ChannelRow icon={<Mail className="size-4" />} title="Email">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        {s.address ? (
          <>
            寄到 <span className="font-mono text-xs break-all" data-testid="notify-email">{s.address}</span>
            <Pill tone="muted">{fromSso ? `來自 ${oauthName}` : '已驗證'}</Pill>
          </>
        ) : (
          <span className="text-muted-foreground">尚未設定 Email</span>
        )}
      </p>
      {s.pending && (
        <form
          className="grid gap-1.5"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            if (code.trim()) verify.mutate(code.trim())
          }}
        >
          <Label htmlFor={`${id}-code`}>輸入寄到 {s.pending} 的 6 位數驗證碼（15 分鐘內有效）</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={`${id}-code`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-32 font-mono tracking-widest"
            />
            <Button type="submit" size="sm" disabled={verify.isPending || !code.trim()}>
              驗證
            </Button>
          </div>
        </form>
      )}
      <form
        className="grid gap-1.5"
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          if (email.trim()) send.mutate(email.trim())
        }}
      >
        <Label htmlFor={`${id}-email`}>改用其他 Email</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={`${id}-email`}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={s.sso_address ?? 'you@example.org'}
            className="w-full max-w-72"
          />
          <Button type="submit" size="sm" variant="outline" disabled={send.isPending || !email.trim()}>
            寄送驗證碼
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">驗證完成前仍寄到原本的地址；填回 {oauthName} 的 Email 不需驗證。</p>
      </form>
    </ChannelRow>
  )
}

export function NotifySettingsSection() {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<NotifySettings>('/api/me/notifications') })
  const save = useMutation({
    mutationFn: (prefs: NotifySettings['prefs']) => api.put<NotifySettings>('/api/me/notifications', prefs),
    onSuccess: (r) => {
      qc.setQueryData(KEY, r)
      toast.success('已更新通知設定')
    },
  })

  const result = params.get('discord') // set by /auth/discord/callback
  useEffect(() => {
    if (!result) return
    const [good, message] = LINK_RESULT[result] ?? LINK_RESULT.error
    // a fixed id: React may run this effect more than once before the ?discord= parameter is gone
    if (good) toast.success(message, { id: 'discord-link' })
    else toast.error(message, { id: 'discord-link' })
    const next = new URLSearchParams(params)
    next.delete('discord')
    setParams(next, { replace: true })
  }, [result, params, setParams])

  const s = q.data
  if (!s || (!s.discord.available && !s.email.available)) return null // feature not configured on this site

  const channels = (['discord', 'email'] as NotifyChannel[]).filter((c) => s[c].available)
  const usable = { discord: s.discord.linked, email: !!s.email.address }
  const toggle = (c: NotifyChannel, key: string, on: boolean) => {
    const cur = s.prefs[c]
    save.mutate({ ...s.prefs, [c]: on ? [...cur, key] : cur.filter((k) => k !== key) })
  }

  return (
    <Section title="通知" id="notify" description="選擇要收到哪些個人通知；預設全部關閉。指派主機不另外通知：助教指派後會通知你，也可以隨時回到我的帳號查看。登記或申請被退回時，會寄信到登記時的 Email。">
      <div className="grid gap-3 lg:grid-cols-2">
        {s.discord.available && <Discord s={s.discord} />}
        {s.email.available && <Email s={s.email} />}
      </div>
      <TableWrap className="mt-4 max-w-2xl">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>通知項目</TableHead>
              {channels.map((c) => (
                <TableHead key={c} className="w-24 text-center">
                  {c === 'discord' ? 'Discord' : 'Email'}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.events.map((e) => (
              <TableRow key={e.key}>
                <TableCell className="whitespace-normal">{e.label}</TableCell>
                {channels.map((c) => (
                  <TableCell key={c} className="text-center">
                    <Checkbox
                      className="mx-auto"
                      aria-label={`${e.label}（${c === 'discord' ? 'Discord' : 'Email'}）`}
                      checked={s.prefs[c].includes(e.key)}
                      disabled={!usable[c] || save.isPending}
                      title={usable[c] ? undefined : c === 'discord' ? '請先連結 Discord' : '請先設定 Email'}
                      onCheckedChange={(v) => toggle(c, e.key, v === true)}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableWrap>
    </Section>
  )
}
