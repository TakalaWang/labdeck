import { useQuery } from '@tanstack/react-query'
import { Lock, Pencil } from 'lucide-react'
import { useEffect } from 'react'
import { Link, useLocation } from '@/lib/router'

import { Markdown } from '@/components/markdown'
import { PageHeader } from '@/components/page'
import { QueryState, SkeletonRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { fmtDateTime } from '@/lib/format'
import { useAccess } from '@/lib/session'
import type { Guide } from '@/lib/types'

/** After the Markdown renders, jump to the heading in the URL hash (a shared `#section` link). */
function useScrollToHash(ready: boolean) {
  const { hash } = useLocation()
  useEffect(() => {
    if (!ready || !hash) return
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView()
  }, [ready, hash])
}

export default function GuidePage() {
  const a = useAccess()
  const q = useQuery({ queryKey: ['guide'], queryFn: () => api.get<Guide>('/api/guide') })
  useScrollToHash(q.isSuccess)
  return (
    <div className="max-w-3xl min-w-0">
      <PageHeader
        title="新成員指南"
        description={
          q.data && !q.data.is_default
            ? `最後更新：${fmtDateTime(q.data.updated_at)}（${q.data.updated_by}）`
            : '從申請帳號到開始跑實驗。'
        }
        actions={
          a.isAdmin && (
            <Button asChild size="sm" variant="outline">
              <Link to="/admin/ops?tab=guide">
                <Pencil /> 編輯
              </Link>
            </Button>
          )
        }
      />
      {/* min-w-0 below: a grid item is as wide as its widest <pre> line otherwise, and phones scroll sideways */}
      <QueryState query={q} skeleton={<SkeletonRows rows={10} />}>
        {(g) => (
          <div className="grid min-w-0 grid-cols-1 gap-4">
            <article className="min-w-0 rounded-xl border bg-card px-4 py-5 sm:px-8 sm:py-7" data-testid="guide">
              <Markdown source={g.markdown} />
            </article>
            {g.members_markdown && (
              <section
                aria-labelledby="guide-members"
                className="min-w-0 rounded-xl border bg-card px-4 py-5 sm:px-8 sm:py-7"
                data-testid="guide-members"
              >
                <h2 id="guide-members" className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Lock className="size-4" aria-hidden="true" /> 僅限實驗室成員
                </h2>
                <Markdown source={g.members_markdown} />
              </section>
            )}
          </div>
        )}
      </QueryState>
    </div>
  )
}
