'use client'

import { RequireMember } from '@/components/layout/guards'
import View from '@/views/hosts'

export default function Page() {
  return (
    <RequireMember>
      <View />
    </RequireMember>
  )
}
