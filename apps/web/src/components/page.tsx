import { createContext, useContext, type ReactNode } from 'react'

import { useDocumentTitle } from '@/hooks/use-document-title'
import { cn } from '@/lib/utils'

/** True inside a TabbedPage tab: the section owns the h1 and the document title. */
export const TabContext = createContext(false)

export function PageHeader({
  title,
  docTitle,
  description,
  actions,
  children,
}: {
  title: ReactNode
  /** document.title when `title` is not plain text */
  docTitle?: string
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  const inTab = useContext(TabContext)
  useDocumentTitle(inTab ? undefined : (docTitle ?? (typeof title === 'string' ? title : undefined)), !inTab)
  if (inTab) {
    // a view shown as a tab: its title is the tab's label; keep the description, actions and filters as a toolbar
    return (
      <div className="mt-4 mb-4 flex flex-col gap-3">
        <h2 className="sr-only">{title}</h2>
        {(description || actions) && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            {description ? <p className="min-w-0 text-sm text-muted-foreground">{description}</p> : <span />}
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
        )}
        {children}
      </div>
    )
  }
  return (
    <div className="mb-5 flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
  id,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  const headingId = id ? `${id}-title` : undefined
  return (
    <section className={cn('mt-8 first:mt-0', className)} aria-labelledby={headingId} id={id}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id={headingId} className="text-base font-semibold">
            {title}
          </h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** Definition list for facts panels. */
export function Facts({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Horizontal scroll wrapper so wide tables never cause page-level horizontal scroll. */
export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('overflow-hidden rounded-lg border bg-card', className)}>{children}</div>
}
