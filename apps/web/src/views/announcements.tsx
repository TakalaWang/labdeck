import { useQuery } from '@tanstack/react-query'

import { AnnouncementList } from '@/components/announcement-list'
import { PageHeader } from '@/components/page'
import { QueryState, SkeletonRows } from '@/components/states'
import { api } from '@/lib/api'
import type { Announcement } from '@/lib/types'

export default function Announcements() {
  const q = useQuery({ queryKey: ['announcements'], queryFn: () => api.get<Announcement[]>('/api/announcements') })
  return (
    <div className="max-w-3xl">
      <PageHeader title="公告" description="進行中與即將開始的公告，新到舊排列。" />
      <QueryState query={q} skeleton={<SkeletonRows rows={3} />}>
        {(items) => <AnnouncementList items={items} />}
      </QueryState>
    </div>
  )
}
