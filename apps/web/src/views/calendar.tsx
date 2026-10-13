import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { CalendarPlus, ChevronLeft, ChevronRight, Download, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from '@/lib/router'

import { CopyBlock } from '@/components/copy-button'
import { PageHeader, Section } from '@/components/page'
import { EmptyState, QueryState, SkeletonRows } from '@/components/states'
import { Pill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { api, qs } from '@/lib/api'
import { fmtDateTime } from '@/lib/format'
import { useAccess } from '@/lib/session'
import type { Announcement, CalendarData } from '@/lib/types'
import { cn } from '@/lib/utils'

// Month grid (sm and up) or a day-grouped list (phones) of announcements and maintenance windows (announcements
// that name hosts). Plain Date math in the browser's time zone; weeks start on Sunday.

type Kind = 'announcement' | 'maintenance'
type CalEvent = { key: string; kind: Kind; title: string; start: Date; end: Date; ann: Announcement }

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const dayLabel = (d: Date) => `${d.getMonth() + 1} 月 ${d.getDate()} 日（週${WEEKDAYS[d.getDay()]}）`

function parseMonth(s: string | null): Date {
  const m = s?.match(/^(\d{4})-(\d{2})$/)
  const now = new Date()
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : new Date(now.getFullYear(), now.getMonth(), 1)
}

/** Whole weeks covering the month. */
function gridDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay())
  const inMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const weeks = Math.ceil((month.getDay() + inMonth) / 7)
  return Array.from({ length: weeks * 7 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i))
}

function toEvents(items: Announcement[]): CalEvent[] {
  const out: CalEvent[] = []
  for (const a of items) {
    if (a.starts_at) {
      const start = new Date(a.starts_at)
      // an end at exactly midnight doesn't reach into that day; no end = the start moment only
      const end = a.ends_at ? new Date(Math.max(start.getTime(), new Date(a.ends_at).getTime() - 1)) : start
      out.push({ key: `a${a.id}`, kind: a.hosts.length ? 'maintenance' : 'announcement', title: a.title, start, end, ann: a })
    }
  }
  return out.sort((x, y) => x.start.getTime() - y.start.getTime())
}

const on = (day: string, e: CalEvent) => dayKey(e.start) <= day && day <= dayKey(e.end)

const CHIP: Record<Kind, string> = {
  announcement: 'bg-secondary text-secondary-foreground',
  maintenance: 'bg-primary/12 text-primary',
}

function Chip({ e, day }: { e: CalEvent; day: string }) {
  const Icon = e.kind === 'maintenance' ? Wrench : null
  const first = dayKey(e.start) === day
  return (
    <span
      className={cn('flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] leading-4', CHIP[e.kind])}
      title={e.title}
    >
      {Icon && <Icon className="size-3 shrink-0" aria-hidden="true" />}
      {first && (e.start.getHours() > 0 || e.start.getMinutes() > 0) && (
        <span className="num shrink-0 opacity-75">{hhmm(e.start)}</span>
      )}
      <span className="truncate">{first ? e.title : `↳ ${e.title}`}</span>
    </span>
  )
}

function span(e: CalEvent) {
  if (e.end.getTime() === e.start.getTime()) return fmtDateTime(e.start.toISOString())
  return dayKey(e.start) === dayKey(e.end)
    ? `${fmtDateTime(e.start.toISOString())} – ${hhmm(e.end)}`
    : `${fmtDateTime(e.start.toISOString())} – ${fmtDateTime(e.ann.ends_at)}`
}

function EventCard({ e }: { e: CalEvent }) {
  const a = e.ann
  return (
    <li className="rounded-lg border bg-card p-3" data-testid={`cal-event-${e.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        {e.kind === 'maintenance' ? (
          <Pill tone="info">
            <Wrench className="size-3" aria-hidden="true" /> 維護
          </Pill>
        ) : (
          <Pill tone="neutral">公告</Pill>
        )}
        <span className="font-medium">{e.title}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{span(e)}</p>
      {a.hosts.length > 0 && <p className="mt-1.5 text-sm">影響主機：{a.hosts.join('、')}</p>}
      <p className="mt-1.5 line-clamp-4 text-sm whitespace-pre-wrap text-foreground/85">{a.body}</p>
    </li>
  )
}

function AddLink({ day, className, label = true }: { day: string; className?: string; label?: boolean }) {
  return (
    <Button asChild size="sm" variant="outline" className={className}>
      <Link to={`/admin/ops?tab=announcements&date=${day}`} aria-label={`在 ${day} 新增維護公告`}>
        <CalendarPlus /> {label && '新增維護公告'}
      </Link>
    </Button>
  )
}

function MonthGrid({ days, month, events, selected, onSelect, today, isAdmin }: {
  days: Date[]
  month: Date
  events: CalEvent[]
  selected: string
  onSelect: (day: string) => void
  today: string
  isAdmin: boolean
}) {
  return (
    <div className="hidden overflow-hidden rounded-xl border bg-card sm:block" role="grid" aria-label="月曆">
      <div role="row" className="grid grid-cols-7 border-b bg-muted/40 text-center text-xs text-muted-foreground">
        {WEEKDAYS.map((w) => (
          <div role="columnheader" key={w} className="py-2">
            週{w}
          </div>
        ))}
      </div>
      {Array.from({ length: days.length / 7 }, (_, w) => (
        <div role="row" key={w} className="grid grid-cols-7 border-b last:border-b-0">
          {days.slice(w * 7, w * 7 + 7).map((d) => {
            const k = dayKey(d)
            const list = events.filter((e) => on(k, e))
            const out = d.getMonth() !== month.getMonth()
            return (
              <div
                role="gridcell"
                key={k}
                aria-selected={k === selected}
                className={cn('group relative min-h-28 border-r p-1.5 last:border-r-0', out && 'bg-muted/30', k === selected && 'bg-primary/5')}
                data-testid={`cal-day-${k}`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(k)}
                  className="absolute inset-0 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  aria-label={`${dayLabel(d)}，${list.length ? `${list.length} 個事件` : '沒有事件'}`}
                />
                <div className="pointer-events-none relative flex items-center justify-between">
                  <span
                    className={cn(
                      'num flex size-6 items-center justify-center rounded-full text-xs',
                      out && 'text-muted-foreground',
                      k === today && 'bg-primary font-semibold text-primary-foreground',
                    )}
                  >
                    {d.getDate()}
                  </span>
                </div>
                {isAdmin && (
                  <Link
                    to={`/admin/ops?tab=announcements&date=${k}`}
                    aria-label={`在 ${k} 新增維護公告`}
                    title="新增維護公告"
                    className="absolute top-1 right-1 z-10 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100"
                  >
                    <CalendarPlus className="size-3.5" aria-hidden="true" />
                  </Link>
                )}
                <div className="pointer-events-none relative mt-1 flex flex-col gap-0.5">
                  {list.slice(0, 3).map((e) => (
                    <Chip key={e.key} e={e} day={k} />
                  ))}
                  {list.length > 3 && <span className="px-1 text-[11px] text-muted-foreground">另 {list.length - 3} 項</span>}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function MonthList({ month, events, isAdmin }: { month: Date; events: CalEvent[]; isAdmin: boolean }) {
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const rows = Array.from({ length: days }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))
    .map((d) => ({ d, list: events.filter((e) => on(dayKey(d), e)) }))
    .filter((r) => r.list.length)
  return (
    <div className="sm:hidden" data-testid="cal-list">
      {rows.length === 0 ? (
        <EmptyState title="這個月沒有維護或公告" className="py-8">
          {isAdmin && <AddLink day={dayKey(new Date())} className="mt-3" />}
        </EmptyState>
      ) : (
        <ol className="grid gap-4">
          {rows.map(({ d, list }) => (
            <li key={dayKey(d)}>
              <h3 className="mb-2 text-sm font-medium">{dayLabel(d)}</h3>
              <ul className="grid gap-2">
                {list.map((e) => (
                  <EventCard key={e.key} e={e} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function Legend() {
  const item = (cls: string, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-2.5 rounded-sm', cls)} aria-hidden="true" />
      {label}
    </span>
  )
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {item('bg-muted-foreground/45', '公告')}
      {item('bg-primary', '維護（標示影響主機）')}
    </p>
  )
}

export default function CalendarPage() {
  const a = useAccess()
  const [params, setParams] = useSearchParams()
  const month = parseMonth(params.get('month'))
  const days = gridDays(month)
  const start = dayKey(days[0])
  const end = dayKey(days[days.length - 1])
  const today = dayKey(new Date())
  const [picked, setPicked] = useState<string | null>(null)
  const selected = picked && picked >= start && picked <= end ? picked : monthKey(new Date()) === monthKey(month) ? today : dayKey(month)
  const q = useQuery({
    queryKey: ['calendar', start, end],
    queryFn: () => api.get<CalendarData>(`/api/calendar${qs({ start, end })}`),
    placeholderData: keepPreviousData,
  })
  const events = useMemo(() => toEvents(q.data?.events ?? []), [q.data])
  const go = (delta: number | null) => {
    const m = delta === null ? new Date() : new Date(month.getFullYear(), month.getMonth() + delta, 1)
    setPicked(null)
    setParams(monthKey(m) === monthKey(new Date()) ? {} : { month: monthKey(m) }, { replace: true })
  }
  const dayEvents = events.filter((e) => on(selected, e))

  return (
    <>
      <PageHeader
        title="維護日曆"
        description="公告與主機維護。"
        actions={
          <>
            <div className="flex items-center gap-1">
              <Button size="icon" variant="outline" className="size-8" onClick={() => go(-1)} aria-label="上個月">
                <ChevronLeft />
              </Button>
              <span className="num min-w-28 text-center font-medium" aria-live="polite" data-testid="cal-month">
                {month.getFullYear()} 年 {month.getMonth() + 1} 月
              </span>
              <Button size="icon" variant="outline" className="size-8" onClick={() => go(1)} aria-label="下個月">
                <ChevronRight />
              </Button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => go(null)}>
              今天
            </Button>
          </>
        }
      >
        <Legend />
      </PageHeader>

      <QueryState query={q} skeleton={<SkeletonRows rows={8} />}>
        {() => (
          <>
            <MonthGrid days={days} month={month} events={events} selected={selected} onSelect={setPicked} today={today} isAdmin={a.isAdmin} />
            <MonthList month={month} events={events} isAdmin={a.isAdmin} />
            <Section
              className="hidden sm:block"
              title={dayLabel(new Date(`${selected}T00:00`))}
              actions={a.isAdmin && <AddLink day={selected} />}
            >
              {dayEvents.length === 0 ? (
                <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">這天沒有維護或公告。</p>
              ) : (
                <ul className="grid gap-2 lg:grid-cols-2" data-testid="cal-day-events">
                  {dayEvents.map((e) => (
                    <EventCard key={e.key} e={e} />
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </QueryState>

      <Section title="訂閱到行事曆" description="Google 日曆、Apple 行事曆、Outlook 以「從網址新增／訂閱」加入，約每小時更新。">
        <div className="grid max-w-3xl gap-2">
          {q.data && <CopyBlock text={q.data.subscribe_url} label="複製訂閱網址" />}
          <p className="text-xs text-muted-foreground">
            這個網址含有你的個人金鑰，請勿公開分享；帳號停用或到期後即失效。
            <a href="/api/calendar.ics" className="ml-2 inline-flex items-center gap-1 text-primary hover:underline" download>
              <Download className="size-3" aria-hidden="true" /> 下載 .ics
            </a>
          </p>
        </div>
      </Section>
    </>
  )
}
