import { BookOpen, History, ListChecks, Megaphone } from 'lucide-react'

import { TabbedPage, type TabDef } from '@/components/route-tabs'
import AdminAnnouncements from '@/views/admin/announcements'
import Audit from '@/views/admin/audit'
import AdminGuide from '@/views/admin/guide'
import Jobs from '@/views/admin/jobs'

const TABS: TabDef[] = [
  { id: 'jobs', label: '工作', icon: ListChecks },
  { id: 'announcements', label: '公告管理', icon: Megaphone },
  { id: 'guide', label: '指南編輯', icon: BookOpen },
  { id: 'audit', label: '稽核紀錄', icon: History },
]

/** 維運: jobs, announcements, the new-member guide and the audit log. */
export default function OpsSection() {
  return (
    <TabbedPage
      title="維運"
      tabs={TABS}
      render={(tab) =>
        tab === 'announcements' ? <AdminAnnouncements /> : tab === 'guide' ? <AdminGuide /> : tab === 'audit' ? <Audit /> : <Jobs />
      }
    />
  )
}
