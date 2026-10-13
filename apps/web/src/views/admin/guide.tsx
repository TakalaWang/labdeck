import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Lock } from 'lucide-react'
import { useDeferredValue, useId, useState } from 'react'
import { Link } from '@/lib/router'
import { toast } from 'sonner'

import { Markdown } from '@/components/markdown'
import { PageHeader } from '@/components/page'
import { Pill } from '@/components/status'
import { QueryState, SkeletonRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { fmtDateTime } from '@/lib/format'
import type { AdminGuide } from '@/lib/types'

const MAX = 50_000

/** Same fixed-set substitution as the backend (`{{ site_name }}` with optional spaces); unknown names stay as typed. */
function fill(text: string, values: Record<string, string>) {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (Object.hasOwn(values, k) ? values[k] : m))
}

function Editor({ data }: { data: AdminGuide }) {
  const id = useId()
  const qc = useQueryClient()
  const [text, setText] = useState(data.source)
  const [saved, setSaved] = useState(data.source)
  const preview = useDeferredValue(text)
  const dirty = text !== saved
  const m = useMutation({
    mutationFn: (source: string) => api.put<AdminGuide>('/api/admin/guide', { source }),
    onSuccess: (g) => {
      toast.success(g.is_default ? '已儲存（與預設內容相同，之後會跟著預設內容更新）' : '已儲存新成員指南')
      setText(g.source)
      setSaved(g.source)
      qc.setQueryData(['admin-guide'], g)
      void qc.invalidateQueries({ queryKey: ['guide'] })
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate(text)
      }}
      className="grid gap-4"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {data.is_default ? <Pill tone="muted">目前使用預設內容</Pill> : <span>最後更新：{fmtDateTime(data.updated_at)}（{data.updated_by}）</span>}
        {dirty && <Pill tone="warn">未儲存</Pill>}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid min-w-0 content-start gap-1.5">
          <Label htmlFor={`${id}-src`}>Markdown</Label>
          <Textarea
            id={`${id}-src`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX}
            spellCheck={false}
            className="min-h-[28rem] font-mono text-[13px] leading-relaxed lg:min-h-[70vh]"
            aria-describedby={`${id}-hint`}
          />
          <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">
            可用的替換字：
            {Object.entries(data.placeholders).map(([k, v]) => (
              <span key={k} className="mr-2 inline-block">
                <code className="font-mono">{`{{${k}}}`}</code> → {v}
              </span>
            ))}
            。以 <code className="font-mono">/</code> 開頭的連結為站內連結；不支援 HTML。{text.length.toLocaleString()} / {MAX.toLocaleString()} 字
          </p>
        </div>
        <div className="grid min-w-0 content-start gap-1.5">
          <span className="text-sm leading-none font-medium" id={`${id}-pv`}>
            預覽
          </span>
          <div
            aria-labelledby={`${id}-pv`}
            className="max-h-[70vh] min-h-[28rem] overflow-y-auto rounded-xl border bg-card px-4 py-5 sm:px-6"
            data-testid="guide-preview"
          >
            <Markdown source={fill(preview, data.placeholders)} />
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={m.isPending || !dirty || !text.trim()}>
          {m.isPending ? '儲存中…' : '儲存'}
        </Button>
        <Button type="button" variant="outline" disabled={!dirty} onClick={() => setText(saved)}>
          放棄變更
        </Button>
        <Button type="button" variant="ghost" disabled={text === data.default} onClick={() => setText(data.default)}>
          還原為預設內容
        </Button>
        <Button asChild variant="link" className="ml-auto">
          <Link to="/guide">
            <ExternalLink /> 查看指南
          </Link>
        </Button>
      </div>
    </form>
  )
}

/** Members-only part: shown under the guide only to active lab accounts (Wi-Fi, door codes…). Empty = none. */
function MembersEditor({ data }: { data: AdminGuide }) {
  const id = useId()
  const qc = useQueryClient()
  const [text, setText] = useState(data.members_source)
  const [saved, setSaved] = useState(data.members_source)
  const preview = useDeferredValue(text)
  const dirty = text !== saved
  const m = useMutation({
    mutationFn: (source: string) => api.put<AdminGuide>('/api/admin/guide/members', { source }),
    onSuccess: (g) => {
      toast.success(g.members_source ? '已儲存成員專區' : '已清空成員專區')
      setText(g.members_source)
      setSaved(g.members_source)
      qc.setQueryData(['admin-guide'], g)
      void qc.invalidateQueries({ queryKey: ['guide'] })
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate(text)
      }}
      className="grid gap-4 border-t pt-6"
      aria-labelledby={`${id}-title`}
    >
      <div className="grid gap-1">
        <h2 id={`${id}-title`} className="flex items-center gap-2 text-base font-semibold">
          <Lock className="size-4" aria-hidden="true" /> 僅限實驗室成員
          {dirty && <Pill tone="warn">未儲存</Pill>}
        </h2>
        <p className="text-sm text-muted-foreground">
          只有帳號啟用中的成員看得到，顯示在指南最下方；申請中、已停用或到期的人看不到。適合放 Wi-Fi 密碼、門禁等內部資訊。留空則不顯示。稽核紀錄只記字數，不記內容。
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid min-w-0 content-start gap-1.5">
          <Label htmlFor={`${id}-src`}>Markdown</Label>
          <Textarea
            id={`${id}-src`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX}
            spellCheck={false}
            className="min-h-60 font-mono text-[13px] leading-relaxed"
          />
        </div>
        <div className="grid min-w-0 content-start gap-1.5">
          <span className="text-sm leading-none font-medium" id={`${id}-pv`}>
            預覽
          </span>
          <div aria-labelledby={`${id}-pv`} className="min-h-60 overflow-y-auto rounded-xl border bg-card px-4 py-5 sm:px-6">
            {preview.trim() ? (
              <Markdown source={fill(preview, data.placeholders)} />
            ) : (
              <p className="text-sm text-muted-foreground">（空白：成員看不到這個區塊）</p>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={m.isPending || !dirty}>
          {m.isPending ? '儲存中…' : '儲存成員專區'}
        </Button>
        <Button type="button" variant="outline" disabled={!dirty} onClick={() => setText(saved)}>
          放棄變更
        </Button>
      </div>
    </form>
  )
}

export default function AdminGuidePage() {
  const q = useQuery({ queryKey: ['admin-guide'], queryFn: () => api.get<AdminGuide>('/api/admin/guide') })
  return (
    <>
      <PageHeader title="編輯新成員指南" description="上半部所有已登入的人（含尚未開通的申請者）都看得到；內部資訊請放最下方的「僅限實驗室成員」。儲存會記錄在稽核紀錄。" />
      <QueryState query={q} skeleton={<SkeletonRows rows={10} />}>
        {(g) => (
          <div className="grid gap-8">
            <Editor data={g} />
            <MembersEditor data={g} />
          </div>
        )}
      </QueryState>
    </>
  )
}
