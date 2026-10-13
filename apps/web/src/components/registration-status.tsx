import { useQuery } from '@tanstack/react-query'
import { Hourglass, Undo2 } from 'lucide-react'
import type { ReactNode } from 'react'

import { api } from '@/lib/api'
import { fmtDate } from '@/lib/format'
import { Link } from '@/lib/router'
import type { RegisterPage } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Where an SSO identity without a lab account stands: registered and waiting, sent back (with the reason), or not
 * registered yet (`fallback`). Home page and the 「尚未開通」 page of member-only routes.
 */
export function RegistrationStatus({ fallback, className }: { fallback: ReactNode; className?: string }) {
  const q = useQuery({ queryKey: ['register'], queryFn: () => api.get<RegisterPage>('/api/register') })
  const r = q.data?.registration
  if (!q.data) return <p className={cn('text-sm text-muted-foreground', className)}>…</p>
  if (r?.status === 'pending') {
    return (
      <p data-testid="registration-status" data-state="pending" className={cn('flex items-start gap-2 text-sm', className)}>
        <Hourglass className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <span>
          已收到你的登記（{fmtDate(r.created_at)} 送出），等待助教指派。助教指派後會通知你，也可以隨時回來看。
          <Link to="/request" className="ml-1 font-medium text-primary hover:underline">
            查看或修改登記
          </Link>
        </span>
      </p>
    )
  }
  if (r?.status === 'rejected' && q.data.can_register) {
    return (
      <p data-testid="registration-status" data-state="rejected" className={cn('flex items-start gap-2 text-sm', className)}>
        <Undo2 className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <span>
          你的登記已被退回（{fmtDate(r.decided_at)}）{r.reject_reason ? `：${r.reject_reason}` : ''}。可修改後重新送出。
          <Link to="/request" className="ml-1 font-medium text-primary hover:underline">
            修改後重新送出
          </Link>
        </span>
      </p>
    )
  }
  return <>{fallback}</>
}
