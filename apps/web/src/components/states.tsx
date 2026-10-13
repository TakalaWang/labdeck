import type { UseQueryResult } from '@tanstack/react-query'
import { CloudOff, Inbox, RotateCw, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

import Skeleton from '@/components/smoothui/skeleton-loader'
import { Button } from '@/components/ui/button'
import { ApiError, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'

export function EmptyState({
  title,
  children,
  icon,
  className,
  heading: Heading = 'p',
}: {
  title: string
  children?: ReactNode
  icon?: ReactNode
  className?: string
  /** Use 'h1' when the empty state is the whole page (404, access denied). */
  heading?: 'h1' | 'h2' | 'p'
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center', className)}>
      <span className="text-muted-foreground" aria-hidden="true">
        {icon ?? <Inbox className="size-6" />}
      </span>
      <Heading className="font-medium">{title}</Heading>
      {children && <div className="max-w-prose text-sm text-muted-foreground">{children}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const metricsDown = error instanceof ApiError && error.status === 502
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-start gap-3 rounded-lg border px-4 py-4 sm:flex-row sm:items-center',
        metricsDown ? 'border-warn/40 bg-warn-soft' : 'border-destructive/30 bg-crit-soft',
        className,
      )}
    >
      {metricsDown ? (
        <CloudOff className="size-5 shrink-0 text-warn-ink" aria-hidden="true" />
      ) : (
        <TriangleAlert className="size-5 shrink-0 text-destructive" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className={cn('font-medium', metricsDown ? 'text-warn-ink' : 'text-destructive')}>
          {metricsDown ? '監控資料暫時無法取得' : '載入失敗'}
        </p>
        <p className="text-sm text-muted-foreground">
          {metricsDown ? 'Prometheus 目前無法連線，稍後會自動重試。' : errorMessage(error)}
        </p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw /> 重試
        </Button>
      )}
    </div>
  )
}

export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-label="載入中" role="status">
      <Skeleton className="h-8 w-full" />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-7 w-full opacity-70" />
      ))}
    </div>
  )
}

export function SkeletonCards({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-4', className)} aria-label="載入中" role="status">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-24 w-full rounded-lg" />
      ))}
    </div>
  )
}

/** Renders loading skeleton / error / data for a query. Keeps showing stale data while refetching. */
export function QueryState<T>({
  query,
  skeleton,
  children,
}: {
  query: UseQueryResult<T>
  skeleton?: ReactNode
  children: (data: T) => ReactNode
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  return <>{skeleton ?? <SkeletonRows />}</>
}
