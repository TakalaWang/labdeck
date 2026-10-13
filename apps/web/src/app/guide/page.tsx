'use client'

import { RequireIdentity } from '@/components/layout/guards'
import View from '@/views/guide'

export default function Page() {
  return (
    <RequireIdentity>
      <View />
    </RequireIdentity>
  )
}
