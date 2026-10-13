'use client'

import type { LucideIcon } from 'lucide-react'
import { type ReactNode } from 'react'

import { PageHeader, TabContext } from '@/components/page'
import { Link, useLocation, useSearchParams } from '@/lib/router'
import { cn } from '@/lib/utils'

// URL-driven tabs: the active tab is ?tab=<id>, so every tab is linkable and survives a reload. A tab's own
// query parameters (filters, month, page…) live next to it; switching tabs drops them.

export type TabDef = { id: string; label: string; icon?: LucideIcon; hidden?: boolean }

/** The ?tab= of the URL when it names one of `tabs`, else the first visible tab. */
export function useTab(tabs: TabDef[]): string {
  const [params] = useSearchParams()
  const visible = tabs.filter((t) => !t.hidden)
  const want = params.get('tab')
  return visible.find((t) => t.id === want)?.id ?? visible[0]?.id ?? ''
}

/** A row of links, one per tab (aria-current marks the active one); scrolls sideways on phones instead of wrapping. */
export function RouteTabs({ tabs, active, label, className }: { tabs: TabDef[]; active: string; label: string; className?: string }) {
  const { pathname } = useLocation()
  return (
    <nav aria-label={label} className={cn('-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden', className)}>
      <ul className="flex min-w-max gap-1 border-b">
        {tabs
          .filter((t) => !t.hidden)
          .map((t) => {
            const on = t.id === active
            return (
              <li key={t.id}>
                <Link
                  to={`${pathname}?tab=${t.id}`}
                  scroll={false}
                  aria-current={on ? 'page' : undefined}
                  data-testid={`tab-${t.id}`}
                  className={cn(
                    'relative flex items-center gap-1.5 rounded-t-md px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors duration-150',
                    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    on ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t.icon && <t.icon className="size-4" aria-hidden="true" />}
                  {t.label}
                  {on && <span aria-hidden="true" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand" />}
                </Link>
              </li>
            )
          })}
      </ul>
    </nav>
  )
}

/**
 * A section page: one header (title, description, actions), the tab row, then the active tab's view. The views
 * keep their own <PageHeader>; inside a tab it renders as a compact toolbar (TabContext) instead of a second h1.
 */
export function TabbedPage({
  title,
  description,
  actions,
  tabs,
  render,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  tabs: TabDef[]
  render: (tab: string) => ReactNode
}) {
  const active = useTab(tabs)
  const current = tabs.find((t) => t.id === active)
  return (
    <>
      <PageHeader title={title} docTitle={current ? `${current.label} · ${title}` : title} description={description} actions={actions}>
        <RouteTabs tabs={tabs} active={active} label={`${title}分頁`} />
      </PageHeader>
      <TabContext.Provider value={true}>
        <div key={active}>{render(active)}</div>
      </TabContext.Provider>
    </>
  )
}
