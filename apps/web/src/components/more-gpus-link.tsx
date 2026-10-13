import { ArrowRight } from 'lucide-react'

import { Link } from '@/lib/router'
import { useAccess } from '@/lib/session'
import { cn } from '@/lib/utils'

/** Members (not admins, who assign hosts themselves): the way to ask for hosts they don't have yet. */
export function MoreGpusLink({ className }: { className?: string }) {
  const a = useAccess()
  if (!a.isMember || a.isAdmin) return null
  return (
    <Link
      to="/me#host-request"
      data-testid="more-gpus"
      className={cn('inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline', className)}
    >
      需要更多 GPU？申請使用其他主機 <ArrowRight className="size-3.5" aria-hidden="true" />
    </Link>
  )
}
