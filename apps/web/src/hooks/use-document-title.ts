import { useEffect } from 'react'

import { useSession } from '@/lib/session'

/** Sets document.title as "<title> · <site name>" (unless `enabled` is false). */
export function useDocumentTitle(title: string | undefined, enabled = true) {
  const { data } = useSession()
  const site = data?.site.name
  useEffect(() => {
    if (enabled) document.title = [title, site].filter(Boolean).join(' · ')
  }, [title, site, enabled])
}
