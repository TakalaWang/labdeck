'use client'

import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'

import { AppShell } from '@/components/layout/app-shell'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiError, errorMessage } from '@/lib/api'
import { initTheme } from '@/lib/theme'

initTheme()
// Dev-only fixture API (NEXT_PUBLIC_MOCK=1 next dev): patches window.fetch for /api/*. The condition is
// replaced at build time, so production builds drop the mocks chunk.
if (process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_MOCK === '1') {
  void import('@/mocks').then((m) => m.installMocks())
}

const MUTATION_ERROR = 'mutation-error'

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        retry: (count, err) => !(err instanceof ApiError && [400, 401, 403, 404, 502].includes(err.status)) && count < 2,
      },
    },
    // Every failed mutation surfaces the backend's {error} message as a toast — one at a time (a new error replaces
    // the last one), and a later success clears it so a stale error doesn't linger next to the success.
    mutationCache: new MutationCache({
      onError: (err) => {
        if (!(err instanceof ApiError && err.status === 401)) toast.error(errorMessage(err), { id: MUTATION_ERROR })
      },
      onSuccess: () => {
        toast.dismiss(MUTATION_ERROR)
      },
    }),
  })
}

export default function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeClient)
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={300}>
        {/* Before the pages: React runs sibling effects in order, so the Toaster subscribes before a page's
            mount effect fires a toast (e.g. /me?discord=linked); after them, that toast could be dropped. */}
        <Toaster position="top-center" richColors closeButton />
        <AppShell>{children}</AppShell>
      </TooltipProvider>
    </QueryClientProvider>
  )
}
