import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from '@/lib/router'

import { PageHeader } from '@/components/page'
import { EmptyState, ErrorState, SkeletonCards } from '@/components/states'
import { HostLoadCard } from '@/components/user-load'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { fmtDateTime, fmtRelative } from '@/lib/format'
import { isHeavy } from '@/lib/load'
import type { HostLoad, UserLoad, UserLoadBoard } from '@/lib/types'

const TOP = 5

/** A host card showing its heaviest users, or every matching user while searching. */
function Host({ h, users, searching }: { h: HostLoad; users: UserLoad[]; searching: boolean }) {
  const [all, setAll] = useState(false)
  const shown = searching || all ? users : users.slice(0, TOP)
  const more = users.length - shown.length
  return (
    <HostLoadCard
      h={h}
      users={shown}
      footer={
        (more > 0 || all) && (
          <Button variant="ghost" size="sm" className="self-start" onClick={() => setAll(!all)}>
            {all ? '只看前 5 位' : `顯示全部 ${users.length} 位`}
          </Button>
        )
      }
    />
  )
}

export default function Usage() {
  const [params] = useSearchParams()
  const [q, setQ] = useState(() => params.get('q') ?? '')
  const query = useQuery({
    queryKey: ['users-load'],
    queryFn: () => api.get<UserLoadBoard>('/api/metrics/users'),
    refetchInterval: 30_000,
  })
  const board = query.data
  const needle = q.trim().toLowerCase()

  const view = useMemo(() => {
    if (!board) return []
    return board.hosts.flatMap((h) => {
      if (!needle || h.host.toLowerCase().includes(needle)) return [{ h, users: h.users }]
      const users = h.users.filter((u) => u.user.toLowerCase().includes(needle))
      return users.length ? [{ h, users }] : []
    })
  }, [board, needle])
  const heavy = new Set(board?.hosts.flatMap((h) => h.users.filter((u) => isHeavy(h, u)).map((u) => u.user))).size

  return (
    <>
      <PageHeader
        title="CPU / 記憶體"
        description={
          board ? (
            <>
              各主機上誰在用 CPU、記憶體與 GPU
              {heavy > 0 && (
                <>
                  {' · '}
                  <span className="font-medium text-warn-ink">{heavy} 位使用者佔用主機過半資源</span>
                </>
              )}
              {' · '}更新於{' '}
              <time dateTime={board.updated_at} title={fmtDateTime(board.updated_at)}>
                {fmtRelative(board.updated_at)}
              </time>
              ，每 30 秒自動更新
            </>
          ) : (
            '各主機上誰在用 CPU、記憶體與 GPU，每 30 秒自動更新'
          )
        }
      >
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="搜尋主機或使用者"
            placeholder="搜尋主機或使用者"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-8 pl-8"
          />
        </div>
      </PageHeader>

      {query.isError && board && <ErrorState error={query.error} className="mb-4" />}
      {!board ? (
        query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <SkeletonCards count={4} />
        )
      ) : view.length === 0 ? (
        <EmptyState title={board.hosts.length === 0 ? '沒有監控中的主機' : '沒有符合條件的主機或使用者'}>
          {board.hosts.length === 0 ? '管理員安裝監控後，這裡會列出各主機的使用者用量。' : '試著清除搜尋字詞。'}
        </EmptyState>
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {view.map(({ h, users }) => (
            <Host key={h.host} h={h} users={users} searching={needle !== ''} />
          ))}
        </div>
      )}

      <p className="mt-6 max-w-prose text-xs text-muted-foreground">
        CPU 為取樣 5 秒內平均使用的核心數；記憶體為各程序 RSS 加總，共用的記憶體（例如 fork 出來的 DataLoader
        worker）會重複計算，可能高於實際用量。<span className="font-mono">system</span> 是 UID 小於 1000 的系統帳號合計。
        標示「佔用過半」的是使用超過該主機一半 CPU 或記憶體的使用者。
      </p>
    </>
  )
}
