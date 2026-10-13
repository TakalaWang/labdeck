import { CircleUserRound, Users } from 'lucide-react'

import { TabbedPage, type TabDef } from '@/components/route-tabs'
import Accounts from '@/views/admin/accounts'
import People from '@/views/admin/people'

const TABS: TabDef[] = [
  { id: 'people', label: '人員', icon: Users },
  { id: 'accounts', label: '主機帳號', icon: CircleUserRound },
]

/** 人員與帳號: people (portal identities) and the accounts seen on the hosts, with adoption. */
export default function PeopleSection() {
  return <TabbedPage title="人員與帳號" tabs={TABS} render={(tab) => (tab === 'accounts' ? <Accounts /> : <People />)} />
}
