import { useQuery } from '@tanstack/react-query'

import { getSession } from '@/lib/api'
import { daysUntil } from '@/lib/format'

export function useSession() {
  return useQuery({ queryKey: ['session'], queryFn: getSession, staleTime: 60_000 })
}

/** Derived access level: anon → identity (SSO only) → member → admin. */
export function useAccess() {
  const q = useSession()
  const s = q.data
  const user = s?.user ?? null
  // Same rule as the API's `member`: active, and not past expires_at (usable through that day).
  const isMember = !!user && user.status === 'active' && (daysUntil(user.expires_at) ?? 0) >= 0
  return {
    ...q,
    session: s,
    user,
    siteName: s?.site.name ?? 'LabDeck',
    oauthName: s?.site.oauth_name ?? 'SSO',
    loggedIn: !!s?.identity || !!user,
    isMember,
    isAdmin: isMember && user?.role === 'admin',
  }
}
