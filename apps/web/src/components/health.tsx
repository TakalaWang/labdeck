import { Pill } from '@/components/status'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HEALTH_STATUS } from '@/lib/labels'
import type { HealthCheck } from '@/lib/types'

/** One check as a colored status pill; the detail is in a tooltip and in screen-reader text. */
export function HealthCell({ check }: { check: HealthCheck }) {
  const s = HEALTH_STATUS[check.status]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          data-testid={`health-${check.key}`}
          data-status={check.status}
        >
          <Pill tone={s.tone} className="min-w-10 justify-center">
            {s.label}
            <span className="sr-only">
              ：{check.label}，{check.detail}
            </span>
          </Pill>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <div>
          <p className="font-medium">{check.label}</p>
          <p>{check.detail}</p>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/** A host's checks in one pill: the worst status and how many need attention; the problems in a tooltip. */
export function HealthSummary({ host, checks }: { host: string; checks: HealthCheck[] }) {
  const bad = checks.filter((c) => c.status === 'bad')
  const warn = checks.filter((c) => c.status === 'warn')
  const problems = [...bad, ...warn]
  const [tone, label] = bad.length
    ? (['crit', `${bad.length} 項異常`] as const)
    : warn.length
      ? (['warn', `${warn.length} 項注意`] as const)
      : checks.every((c) => c.status === 'unknown')
        ? (['muted', '未知'] as const)
        : (['ok', '正常'] as const)
  const pill = (
    <Pill tone={tone} data-testid={`host-health-${host}`} data-status={bad.length ? 'bad' : warn.length ? 'warn' : tone === 'muted' ? 'unknown' : 'ok'}>
      {label}
    </Pill>
  )
  if (!problems.length) return pill
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {pill}
          <span className="sr-only">：{problems.map((c) => `${c.label} ${c.detail}`).join('；')}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <ul className="grid gap-1">
          {problems.map((c) => (
            <li key={c.key}>
              <span className="font-medium">{c.label}</span>：{c.detail}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

/** Every check of one host, one per line (host detail page). */
export function HealthList({ checks }: { checks: HealthCheck[] }) {
  return (
    <ul className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-2">
      {checks.map((c) => {
        const s = HEALTH_STATUS[c.status]
        return (
          <li key={c.key} className="flex min-w-0 items-start gap-2" data-testid={`health-${c.key}`} data-status={c.status}>
            <Pill tone={s.tone} className="mt-px min-w-10 justify-center">
              {s.label}
            </Pill>
            <span className="min-w-0">
              <span className="font-medium">{c.label}</span>
              <span className="text-muted-foreground"> · {c.detail}</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
