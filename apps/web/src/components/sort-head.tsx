import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import type { ReactNode } from 'react'

import { TableHead } from '@/components/ui/table'
import type { SortDir } from '@/hooks/use-sort'
import { cn } from '@/lib/utils'

/** Table header cell with a sort toggle button and aria-sort. */
export function SortHead({
  active,
  dir,
  onClick,
  children,
  align = 'left',
  className,
}: {
  active: boolean
  dir: SortDir
  onClick: () => void
  children: ReactNode
  align?: 'left' | 'right'
  className?: string
}) {
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <TableHead aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={cn(align === 'right' && 'text-right', className)}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          active && 'text-foreground',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {children}
        <Icon className={cn('size-3', !active && 'opacity-40')} aria-hidden="true" />
      </button>
    </TableHead>
  )
}
