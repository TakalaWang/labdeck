// Recharts via the shadcn `chart` component. Only imported by lazily-loaded routes,
// so recharts stays out of the initial bundle.
import { useMemo } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, XAxis, YAxis } from 'recharts'

import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { fmtAxisTime, fmtDateTime } from '@/lib/format'
import type { Grid, Point, Values } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Series color i: the five theme chart tokens, then evenly rotated hues. */
function seriesColor(i: number): string {
  if (i < 5) return `var(--chart-${i + 1})`
  return `oklch(0.66 0.13 ${(245 + i * 67) % 360})`
}

export type Series = { name: string; points: Point[] }

export function TimeSeriesChart({
  series,
  format,
  tickFormat = format,
  yMax,
  className,
  ariaLabel,
  sparse = false,
  xDomain,
}: {
  series: Series[]
  format: (v: number) => string
  /** Y-axis tick label; defaults to `format` */
  tickFormat?: (v: number) => string
  yMax?: number
  className?: string
  ariaLabel: string
  /** few, irregular points (e.g. nightly scans): draw every point and bridge missing ones */
  sparse?: boolean
  /** fixed time axis (epoch s) instead of the data's extent — keeps a one-point series readable */
  xDomain?: [number, number]
}) {
  const { rows, config, span } = useMemo(() => {
    const byT = new Map<number, Record<string, number>>()
    series.forEach((s, i) => {
      for (const [t, v] of s.points) {
        const row = byT.get(t) ?? { t }
        row[`s${i}`] = v
        byT.set(t, row)
      }
    })
    const rows = [...byT.values()].sort((a, b) => a.t - b.t)
    const config: ChartConfig = {}
    series.forEach((s, i) => {
      config[`s${i}`] = { label: s.name, color: seriesColor(i) }
    })
    const span = xDomain ? xDomain[1] - xDomain[0] : rows.length > 1 ? rows[rows.length - 1].t - rows[0].t : 0
    return { rows, config, span }
  }, [series, xDomain])

  if (rows.length === 0) {
    return (
      <div className={cn('flex h-48 items-center justify-center rounded-md bg-muted/40 text-sm text-muted-foreground', className)}>
        此區間沒有資料
      </div>
    )
  }

  return (
    <ChartContainer config={config} className={cn('aspect-auto h-48 w-full', className)} role="img" aria-label={ariaLabel}>
      <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="t"
          type="number"
          domain={xDomain ?? ['dataMin', 'dataMax']}
          scale="time"
          tickLine={false}
          axisLine={false}
          minTickGap={40}
          tickMargin={6}
          tickFormatter={(t: number) => fmtAxisTime(t, span)}
        />
        <YAxis
          width={44}
          tickLine={false}
          axisLine={false}
          domain={[0, yMax ?? 'auto']}
          tickFormatter={(v: number) => tickFormat(v)}
          tickCount={4}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="line"
              valueFormatter={format}
              labelFormatter={(_, payload) => {
                const t = payload?.[0]?.payload?.t as number | undefined
                return t ? fmtDateTime(new Date(t * 1000).toISOString()) : ''
              }}
            />
          }
        />
        {series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        {series.map((_, i) => (
          <Line
            key={i}
            dataKey={`s${i}`}
            type="monotone"
            stroke={`var(--color-s${i})`}
            strokeWidth={1.5}
            dot={sparse ? { r: 2.5, fill: `var(--color-s${i})`, strokeWidth: 0 } : false}
            connectNulls={sparse}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  )
}

/** Horizontal bar chart for rankings (top owners, GPU hours by user/host). */
export function RankBarChart({
  data,
  labelKey,
  valueKey,
  format,
  ariaLabel,
  color = 'var(--chart-1)',
  className,
  valueLabel,
}: {
  data: Record<string, string | number>[]
  labelKey: string
  valueKey: string
  format: (v: number) => string
  ariaLabel: string
  color?: string
  className?: string
  /** bar-end label from the whole row (e.g. a secondary figure); defaults to `format(value)` */
  valueLabel?: (row: Record<string, string | number>) => string
}) {
  const config: ChartConfig = { [valueKey]: { label: ariaLabel, color } }
  const rows = valueLabel ? data.map((r) => ({ ...r, _label: valueLabel(r) })) : data
  const height = Math.max(120, data.length * 26 + 16)
  return (
    <ChartContainer config={config} className={cn('aspect-auto w-full', className)} style={{ height }} role="img" aria-label={ariaLabel}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: valueLabel ? 104 : 56, bottom: 0, left: 0 }} barCategoryGap={4} accessibilityLayer>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <XAxis type="number" hide />
        <YAxis type="category" dataKey={labelKey} width={84} tickLine={false} axisLine={false} interval={0} />
        <ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent hideLabel={false} valueFormatter={format} />} />
        <Bar
          dataKey={valueKey}
          fill={`var(--color-${valueKey})`}
          radius={3}
          isAnimationActive={false}
          label={
            valueLabel ? undefined : { position: 'right', formatter: (v: unknown) => (typeof v === 'number' ? format(v) : ''), className: 'fill-muted-foreground text-[11px]' }
          }
        >
          {valueLabel && <LabelList dataKey="_label" position="right" className="fill-muted-foreground text-[11px]" />}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

export type StackSeries = { name: string; values: Values; color: string }

/** Stacked areas on one time grid (e.g. GPUs in use + idle); a null value leaves a gap. */
export function StackedAreaChart({
  grid,
  series,
  format,
  ariaLabel,
  className,
}: {
  grid: Grid
  series: StackSeries[]
  format: (v: number) => string
  ariaLabel: string
  className?: string
}) {
  const { rows, config, span } = useMemo(() => {
    const n = Math.max(0, ...series.map((s) => s.values.length))
    const rows = Array.from({ length: n }, (_, i) => {
      const row: Record<string, number | null> = { t: grid.start + i * grid.step }
      series.forEach((s, k) => {
        row[`s${k}`] = s.values[i] ?? null
      })
      return row
    })
    const config: ChartConfig = {}
    series.forEach((s, k) => {
      config[`s${k}`] = { label: s.name, color: s.color }
    })
    return { rows, config, span: grid.end - grid.start }
  }, [grid.start, grid.step, grid.end, series])

  if (!series.some((s) => s.values.some((v) => v !== null))) {
    return (
      <div className={cn('flex h-48 items-center justify-center rounded-md bg-muted/40 text-sm text-muted-foreground', className)}>
        此區間沒有資料
      </div>
    )
  }
  return (
    <ChartContainer config={config} className={cn('aspect-auto h-48 w-full', className)} role="img" aria-label={ariaLabel}>
      <AreaChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          scale="time"
          tickLine={false}
          axisLine={false}
          minTickGap={40}
          tickMargin={6}
          tickFormatter={(t: number) => fmtAxisTime(t, span)}
        />
        <YAxis width={36} tickLine={false} axisLine={false} allowDecimals={false} tickCount={4} tickFormatter={(v: number) => format(v)} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="line"
              valueFormatter={format}
              labelFormatter={(_, payload) => {
                const t = payload?.[0]?.payload?.t as number | undefined
                return t ? fmtDateTime(new Date(t * 1000).toISOString()) : ''
              }}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {series.map((_, k) => (
          <Area
            key={k}
            dataKey={`s${k}`}
            stackId="a"
            type="linear"
            stroke={`var(--color-s${k})`}
            fill={`var(--color-s${k})`}
            fillOpacity={0.35}
            strokeWidth={1.25}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  )
}
