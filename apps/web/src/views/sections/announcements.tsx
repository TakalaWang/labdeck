import { CalendarDays, Megaphone } from 'lucide-react'

import { TabbedPage, type TabDef } from '@/components/route-tabs'
import { useAccess } from '@/lib/session'
import Announcements from '@/views/announcements'
import Calendar from '@/views/calendar'

/** 公告與維護: the current announcements (public) and the maintenance calendar (members). */
export default function AnnouncementsSection() {
  const a = useAccess()
  const tabs: TabDef[] = [
    { id: 'list', label: '公告', icon: Megaphone },
    { id: 'calendar', label: '維護日曆', icon: CalendarDays, hidden: !a.isMember },
  ]
  return <TabbedPage title="公告與維護" tabs={tabs} render={(tab) => (tab === 'calendar' ? <Calendar /> : <Announcements />)} />
}
