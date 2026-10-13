'use client'

import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'

// The app is rendered in the browser only, as the former SPA was: pages read the session, theme and
// window size on first render, and every page loads its data from /api/* with TanStack Query.
const Providers = dynamic(() => import('./providers'), { ssr: false })

export function ClientRoot({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>
}
