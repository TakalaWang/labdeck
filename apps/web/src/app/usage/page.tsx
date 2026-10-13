'use client'

import { RequireMember } from '@/components/layout/guards'
import View from '@/views/sections/usage'

export default function Page() {
  return (
    <RequireMember>
      <View />
    </RequireMember>
  )
}
