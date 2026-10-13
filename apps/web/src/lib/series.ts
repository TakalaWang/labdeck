import type { Grid, Point, Values } from '@/lib/types'

/** Min / mean / max / last of the non-null values, or null when there are none. */
export function summarize(values: Values | null | undefined) {
  const vs = (values ?? []).filter((v): v is number => v !== null)
  if (vs.length === 0) return null
  return {
    min: Math.min(...vs),
    max: Math.max(...vs),
    mean: vs.reduce((a, b) => a + b, 0) / vs.length,
    last: vs[vs.length - 1],
  }
}

/** Grid values → chart points, dropping the gaps. */
export function toPoints(g: Grid, values: Values): Point[] {
  const out: Point[] = []
  values.forEach((v, i) => {
    if (v !== null) out.push([g.start + i * g.step, v])
  })
  return out
}
