'use client'

import { RequireMember } from '@/components/layout/guards'
import View from '@/views/host-detail'

export default function Page() {
  return (
    <RequireMember>
      <View />
    </RequireMember>
  )
}
