import { HeartPulse, ServerCog } from 'lucide-react'

import { TabbedPage, type TabDef } from '@/components/route-tabs'
import AdminHosts from '@/views/admin/hosts'
import Health from '@/views/health'

const TABS: TabDef[] = [
  { id: 'hosts', label: '主機', icon: ServerCog },
  { id: 'health', label: '健康', icon: HeartPulse },
]

/** 主機管理: the inventory (add, import, jobs) and the routine health checks of every host. */
export default function AdminHostsSection() {
  return <TabbedPage title="主機管理" tabs={TABS} render={(tab) => (tab === 'health' ? <Health /> : <AdminHosts />)} />
}
