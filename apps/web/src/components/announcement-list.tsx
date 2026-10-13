import { CalendarClock, Megaphone } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

import { EmptyState } from '@/components/states'
import { fmtDateTime } from '@/lib/format'
import type { Announcement } from '@/lib/types'

function period(a: Announcement) {
  if (!a.starts_at && !a.ends_at) return null
  return `${a.starts_at ? fmtDateTime(a.starts_at) : '即日起'} – ${a.ends_at ? fmtDateTime(a.ends_at) : '不限'}`
}

export function AnnouncementList({ items, empty = '目前沒有公告。' }: { items: Announcement[]; empty?: string }) {
  const reduce = useReducedMotion()
  if (items.length === 0) return <EmptyState title={empty} icon={<Megaphone className="size-6" />} className="py-8" />
  return (
    <ul className="flex flex-col gap-3">
      <AnimatePresence initial={false}>
        {items.map((a) => {
          return (
            <motion.li
              key={a.id}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
              className="rounded-lg border bg-card p-4"
            >
              <h3 className="font-medium">{a.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">{a.body}</p>
              {a.hosts.length > 0 && <p className="mt-2 text-sm">影響主機：{a.hosts.join('、')}</p>}
              <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {period(a) && (
                  <span className="inline-flex items-center gap-1">
                    <CalendarClock className="size-3" aria-hidden="true" />
                    {period(a)}
                  </span>
                )}
                <span>發布：{a.created_by}</span>
              </p>
            </motion.li>
          )
        })}
      </AnimatePresence>
    </ul>
  )
}
