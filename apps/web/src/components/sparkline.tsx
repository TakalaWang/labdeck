// Plain-SVG sparkline: no Recharts, no animation — cheap enough for ~150 GPU cards and a row per host.
import { memo, useMemo } from 'react'

import { fmtPct } from '@/lib/format'
import { summarize } from '@/lib/series'
import type { Values } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Line (+ faint area) of `values` on a 0…max scale. A null breaks the line (offline / no sample);
 * a lone point between gaps is drawn as a dot. `label` names the series for screen readers and the tooltip.
 */
export const Sparkline = memo(function Sparkline({
  values,
  label,
  period,
  max = 100,
  color = 'var(--chart-1)',
  format = (v: number) => fmtPct(v),
  className,
}: {
  values: Values | null | undefined
  label: string
  /** e.g. "過去 1 小時" */
  period: string
  max?: number
  color?: string
  format?: (v: number) => string
  className?: string
}) {
  const { line, area, dots, stats } = useMemo(() => {
    const vs = values ?? []
    const n = Math.max(vs.length - 1, 1)
    const y = (v: number) => (100 - (Math.min(Math.max(v, 0), max) / max) * 100).toFixed(1)
    const x = (i: number) => ((i / n) * 100).toFixed(2)
    let line = ''
    let area = ''
    const dots: [string, string][] = []
    let seg: number[] = []
    const flush = () => {
      if (seg.length === 1) dots.push([x(seg[0]), y(vs[seg[0]]!)])
      else if (seg.length > 1) {
        const pts = seg.map((i) => `${x(i)},${y(vs[i]!)}`).join(' L')
        line += `M${pts}`
        area += `M${x(seg[0])},100 L${pts} L${x(seg[seg.length - 1])},100 Z`
      }
      seg = []
    }
    vs.forEach((v, i) => (v === null ? flush() : seg.push(i)))
    flush()
    return { line, area, dots, stats: summarize(vs) }
  }, [values, max])

  const text = stats
    ? `${label}，${period}：平均 ${format(stats.mean)}，最高 ${format(stats.max)}，最新 ${format(stats.last)}`
    : `${label}，${period}：沒有資料`
  if (!stats) {
    return (
      <span role="img" aria-label={text} title={text} className={cn('flex items-center text-[11px] text-muted-foreground', className)}>
        <span className="block h-px w-full bg-border" aria-hidden="true" />
      </span>
    )
  }
  return (
    <svg
      role="img"
      aria-label={text}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className={cn('block overflow-visible', className)}
    >
      <title>{text}</title>
      <path d={area} fill={color} fillOpacity={0.14} stroke="none" />
      <path d={line} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {dots.map(([cx, cy], i) => (
        <path key={i} d={`M${cx},${cy} L${cx},${cy}`} stroke={color} strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  )
})
