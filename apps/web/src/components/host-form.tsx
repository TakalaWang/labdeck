import { useId, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { Host, HostInput } from '@/lib/types'

type Values = {
  name: string
  address: string
  group: string
  ssh_no_retry: boolean
  room: string
  rack: string
  psu: string
  notes: string
  monitored: boolean
}

const fromHost = (h?: Host): Values => ({
  name: h?.name ?? '',
  address: h?.address ?? '',
  group: h?.group ?? '',
  ssh_no_retry: h?.ssh_no_retry ?? false,
  room: h?.room ?? '',
  rack: h?.rack ?? '',
  psu: h?.psu ?? '',
  notes: h?.notes ?? '',
  monitored: h?.monitored ?? false,
})

const orNull = (s: string) => (s.trim() === '' ? null : s.trim())

/** Create (no `host`) or edit (`host` given) form for a host record. */
export function HostForm({
  host,
  submitLabel,
  onSubmit,
}: {
  host?: Host
  submitLabel: string
  onSubmit: (input: HostInput) => Promise<unknown>
}) {
  const id = useId()
  const editing = !!host
  const [v, setV] = useState<Values>(() => fromHost(host))
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((p) => ({ ...p, [k]: val }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const input: HostInput = {
      address: v.address.trim(),
      group: v.group.trim(),
      ssh_no_retry: v.ssh_no_retry,
      room: orNull(v.room),
      rack: orNull(v.rack),
      psu: orNull(v.psu),
      notes: orNull(v.notes),
    }
    if (editing) input.monitored = v.monitored
    else input.name = v.name.trim()
    try {
      await onSubmit(input)
      if (!editing) setV(fromHost())
    } catch {
      // toast shown globally
    } finally {
      setBusy(false)
    }
  }

  const field = (
    k: 'name' | 'address' | 'group' | 'room' | 'rack' | 'psu',
    label: string,
    extra: React.ComponentProps<'input'> = {},
  ) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`${id}-${k}`}>{label}</Label>
      <Input id={`${id}-${k}`} value={v[k]} onChange={(e) => set(k, e.target.value)} autoComplete="off" spellCheck={false} {...extra} />
    </div>
  )

  return (
    <form onSubmit={(e) => void submit(e)} className="grid max-w-3xl gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {!editing && field('name', '名稱', { required: true, maxLength: 63, pattern: '[A-Za-z0-9][A-Za-z0-9._\\-]{0,62}', placeholder: 'gpu01' })}
        {field('address', '位址', { required: true, maxLength: 253, placeholder: '192.0.2.11 或 DNS 名稱' })}
        {field('group', '群組', { required: true, maxLength: 32, pattern: '[A-Za-z][A-Za-z0-9_]{0,31}', placeholder: 'gpu' })}
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id={`${id}-noretry`}
          checked={v.ssh_no_retry}
          onCheckedChange={(c) => set('ssh_no_retry', c === true)}
          aria-describedby={`${id}-noretry-hint`}
          className="mt-0.5"
        />
        <div className="grid gap-0.5">
          <Label htmlFor={`${id}-noretry`} className="font-normal">連線失敗不重試</Label>
          <p id={`${id}-noretry-hint`} className="text-xs text-muted-foreground">
            這台會封鎖頻繁開新 SSH 連線的來源 IP；勾選後 ansible 連線失敗即放棄，不重試
          </p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {field('room', '機房', { maxLength: 100 })}
        {field('rack', '機櫃', { maxLength: 100 })}
        {field('psu', 'PSU', { maxLength: 100 })}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-notes`}>備註</Label>
        <Textarea id={`${id}-notes`} rows={2} maxLength={1000} value={v.notes} onChange={(e) => set('notes', e.target.value)} />
      </div>
      {editing && (
        <div className="flex items-center gap-2">
          <Checkbox id={`${id}-mon`} checked={v.monitored} onCheckedChange={(c) => set('monitored', c === true)} />
          <Label htmlFor={`${id}-mon`} className="font-normal">列入 Prometheus 監控</Label>
        </div>
      )}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? '儲存中…' : submitLabel}
        </Button>
      </div>
    </form>
  )
}
