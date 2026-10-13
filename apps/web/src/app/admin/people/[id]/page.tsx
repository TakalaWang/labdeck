'use client'

import { RequireAdmin } from '@/components/layout/guards'
import View from '@/views/admin/person'

export default function Page() {
  return (
    <RequireAdmin>
      <View />
    </RequireAdmin>
  )
}
