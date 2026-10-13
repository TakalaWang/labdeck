import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { useSearchParams } from '@/lib/router'
import { toast } from 'sonner'

import { HostPicker } from '@/components/host-picker'
import { PageHeader, Section, TableWrap } from '@/components/page'
import { EmptyState, QueryState, SkeletonRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { fmtDateTime, localInputToIso } from '@/lib/format'
import type { Announcement, AnnouncementInput, Host } from '@/lib/types'

function AnnouncementForm() {
  const id = useId()
  const qc = useQueryClient()
  // ?date=YYYY-MM-DD (from the maintenance calendar): a maintenance window on that day, 09:00–18:00
  const [params] = useSearchParams()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date') : null
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [starts, setStarts] = useState(date ? `${date}T09:00` : '')
  const [ends, setEnds] = useState(date ? `${date}T18:00` : '')
  const [withHosts, setWithHosts] = useState(!!date)
  const [affected, setAffected] = useState<string[]>([])
  const hostList = useQuery({ queryKey: ['hosts'], queryFn: () => api.get<Host[]>('/api/hosts'), enabled: withHosts })

  const m = useMutation({
    mutationFn: (input: AnnouncementInput) => api.post<Announcement>('/api/admin/announcements', input),
    onSuccess: (a) => {
      toast.success(`已發布公告「${a.title}」`)
      setTitle('')
      setBody('')
      setStarts('')
      setEnds('')
      setWithHosts(false)
      setAffected([])
      void qc.invalidateQueries({ queryKey: ['admin-announcements'] })
      void qc.invalidateQueries({ queryKey: ['announcements'] })
      void qc.invalidateQueries({ queryKey: ['calendar'] })
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const input: AnnouncementInput = {
      title: title.trim(),
      body: body.trim(),
      starts_at: localInputToIso(starts),
      ends_at: localInputToIso(ends),
    }
    if (withHosts && affected.length > 0) input.hosts = affected
    m.mutate(input)
  }

  return (
    <form onSubmit={submit} className="grid max-w-3xl gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-t`}>標題</Label>
        <Input id={`${id}-t`} required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-b`}>內容</Label>
        <Textarea id={`${id}-b`} required rows={5} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-s`}>開始顯示</Label>
          <Input id={`${id}-s`} type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} />
          <p className="text-xs text-muted-foreground">空白 = 立即</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-e`}>結束顯示</Label>
          <Input id={`${id}-e`} type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} />
          <p className="text-xs text-muted-foreground">空白 = 不結束</p>
        </div>
      </div>
      <div className="rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <Checkbox id={`${id}-mh`} checked={withHosts} onCheckedChange={(c) => setWithHosts(c === true)} />
          <Label htmlFor={`${id}-mh`}>標示維護影響的主機（選填）</Label>
        </div>
        {withHosts && (
          <div className="mt-3">
            {hostList.data ? (
              <HostPicker
                legend="影響主機"
                description="在維護日曆上以「維護」標示；不會關機，也不會執行任何動作。"
                hosts={hostList.data.map((h) => ({ name: h.name, group: h.group }))}
                value={affected}
                onChange={setAffected}
              />
            ) : (
              <SkeletonRows rows={2} />
            )}
          </div>
        )}
      </div>
      <div>
        <Button type="submit" disabled={m.isPending}>
          {m.isPending ? '發布中…' : '發布（同時通知 Discord）'}
        </Button>
      </div>
    </form>
  )
}

function AnnouncementTable({ items }: { items: Announcement[] }) {
  if (items.length === 0) return <EmptyState title="沒有公告" />
  return (
    <TableWrap>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>標題</TableHead>
            <TableHead>顯示期間</TableHead>
            <TableHead>建立者</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((a) => (
            <TableRow key={a.id}>
              <TableCell className="max-w-72 truncate font-medium" title={a.title}>
                {a.title}
                {a.hosts.length > 0 && <div className="truncate text-xs font-normal text-muted-foreground">維護：{a.hosts.join('、')}</div>}
              </TableCell>
              <TableCell className="text-xs">
                {fmtDateTime(a.starts_at)} – {fmtDateTime(a.ends_at)}
              </TableCell>
              <TableCell>{a.created_by}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableWrap>
  )
}

export default function AdminAnnouncements() {
  const q = useQuery({ queryKey: ['admin-announcements'], queryFn: () => api.get<Announcement[]>('/api/admin/announcements') })
  return (
    <>
      <PageHeader title="公告管理" />
      <Section title="新增公告">
        <AnnouncementForm />
      </Section>
      <Section title="所有公告">
        <QueryState query={q} skeleton={<SkeletonRows rows={4} />}>
          {(items) => <AnnouncementTable items={items} />}
        </QueryState>
      </Section>
    </>
  )
}
