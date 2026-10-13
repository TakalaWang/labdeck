import type { ReactNode } from 'react'

import AnimatedProgressBar from '@/components/smoothui/animated-progress-bar'
import { fmtPct } from '@/lib/format'
import { JOB_STATUS, levelTone, TONE_COLOR, type Tone } from '@/lib/labels'
import type { JobStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

const PILL: Record<Tone, string> = {
  neutral: 'bg-secondary text-secondary-foreground border-border',
  info: 'bg-accent text-accent-foreground border-transparent',
  ok: 'bg-ok-soft text-ok-ink border-transparent',
  warn: 'bg-warn-soft text-warn-ink border-transparent',
  crit: 'bg-crit-soft text-destructive border-transparent',
  muted: 'bg-muted text-muted-foreground border-transparent',
}

export function Pill({
  tone = 'neutral',
  className,
  children,
  ...rest
}: { tone?: Tone; className?: string; children: ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-xs font-medium whitespace-nowrap',
        PILL[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  )
}

export function JobStatusBadge({ status, className, testId }: { status: JobStatus; className?: string; testId?: string }) {
  const s = JOB_STATUS[status] ?? { label: status, tone: 'neutral' as Tone }
  const live = status === 'running' || status === 'queued' || status === 'confirmed'
  return (
    <Pill tone={s.tone} className={className} data-testid={testId} data-status={status}>
      {live && (
        <span aria-hidden="true" className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      )}
      {s.label}
    </Pill>
  )
}

export type DotState = 'up' | 'down' | 'unknown'

export function StatusDot({ state, className }: { state: DotState; className?: string }) {
  const label = state === 'up' ? '在線' : state === 'down' ? '離線' : '無監控資料'
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        state === 'up' && 'bg-ok',
        state === 'down' && 'bg-destructive',
        state === 'unknown' && 'bg-muted-foreground/40',
        className,
      )}
    />
  )
}

/** Compact labelled usage bar; color follows usage level unless `tone` is given. */
export function Meter({
  label,
  value,
  tone,
  showValue = true,
  className,
  barClassName,
  valueText,
}: {
  label: string
  value: number | null | undefined
  tone?: Tone
  showValue?: boolean
  className?: string
  barClassName?: string
  valueText?: string
}) {
  const t = tone ?? levelTone(value)
  const text = valueText ?? fmtPct(value)
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <AnimatedProgressBar
        value={value ?? 0}
        label={label}
        valueText={text}
        color={TONE_COLOR[t]}
        className="min-w-8 flex-1"
        barClassName={barClassName}
      />
      {showValue && (
        <span className={cn('num w-10 shrink-0 text-right text-xs', value == null ? 'text-muted-foreground' : 'text-foreground')}>
          {text}
        </span>
      )}
    </div>
  )
}
