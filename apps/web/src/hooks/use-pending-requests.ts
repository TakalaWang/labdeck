import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { useAccess } from '@/lib/session'
import type { AccountRequest } from '@/lib/types'

/** Registrations and host requests waiting for an admin (待指派); null for non-admins or while loading. */
export function usePendingRequests(): number | null {
  const { isAdmin } = useAccess()
  // the same query (key and data) as the 待指派 page, so both stay in step
  const q = useQuery({
    queryKey: ['admin-requests'],
    queryFn: () => api.get<AccountRequest[]>('/api/admin/requests'),
    enabled: isAdmin,
    refetchInterval: 60_000,
  })
  return isAdmin && q.data ? q.data.filter((r) => r.status === 'pending').length : null
}
