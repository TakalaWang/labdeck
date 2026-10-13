'use client'

import { RequireAdmin } from '@/components/layout/guards'
import View from '@/views/sections/people'

export default function Page() {
  return (
    <RequireAdmin>
      <View />
    </RequireAdmin>
  )
}
