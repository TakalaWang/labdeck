import { Search } from 'lucide-react'
import { useId, useMemo, useState, type ReactNode } from 'react'

import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export type PickableHost = { name: string; group: string; hint?: ReactNode; disabled?: boolean }

/** Multi-select of hosts grouped by inventory group, with per-group select-all and a filter. */
export function HostPicker({
  hosts,
  value,
  onChange,
  legend,
  description,
  className,
}: {
  hosts: PickableHost[]
  value: string[]
  onChange: (next: string[]) => void
  legend: string
  description?: ReactNode
  className?: string
}) {
  const id = useId()
  const [q, setQ] = useState('')
  const selected = useMemo(() => new Set(value), [value])
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const m = new Map<string, PickableHost[]>()
    for (const h of hosts) {
      if (needle && !h.name.toLowerCase().includes(needle) && !h.group.toLowerCase().includes(needle)) continue
      const list = m.get(h.group) ?? []
      list.push(h)
      m.set(h.group, list)
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [hosts, q])

  const toggle = (name: string, on: boolean) => {
    const next = new Set(selected)
    if (on) next.add(name)
    else next.delete(name)
    onChange(hosts.filter((h) => next.has(h.name)).map((h) => h.name))
  }
  const toggleGroup = (list: PickableHost[], on: boolean) => {
    const next = new Set(selected)
    for (const h of list) {
      if (h.disabled) continue
      if (on) next.add(h.name)
      else next.delete(h.name)
    }
    onChange(hosts.filter((h) => next.has(h.name)).map((h) => h.name))
  }

  return (
    <fieldset className={cn('min-w-0 rounded-lg border p-3', className)}>
      <legend className="px-1 text-sm font-medium">
        {legend}
        <span className="ml-2 font-normal text-muted-foreground">已選 {value.length} 台</span>
      </legend>
      {description && <p className="mb-2 text-xs text-muted-foreground">{description}</p>}
      {hosts.length > 12 && (
        <div className="relative mb-3 max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            aria-label="篩選主機"
            placeholder="篩選主機或群組"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-8 pl-8"
          />
        </div>
      )}
      {groups.length === 0 && <p className="text-sm text-muted-foreground">沒有符合的主機。</p>}
      <div className="flex max-h-80 flex-col gap-3 overflow-y-auto pr-1 pb-2">
        {groups.map(([group, list]) => {
          const enabled = list.filter((h) => !h.disabled)
          const all = enabled.length > 0 && enabled.every((h) => selected.has(h.name))
          const some = enabled.some((h) => selected.has(h.name))
          const gid = `${id}-g-${group}`
          return (
            <div key={group}>
              <div className="mb-1.5 flex items-center gap-2">
                <Checkbox
                  id={gid}
                  checked={all ? true : some ? 'indeterminate' : false}
                  disabled={enabled.length === 0}
                  onCheckedChange={(c) => toggleGroup(list, c === true)}
                />
                <label htmlFor={gid} className="text-xs font-medium text-muted-foreground">
                  {group}（全選 {enabled.length}）
                </label>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-x-3 gap-y-1.5 pl-1">
                {list.map((h) => {
                  const hid = `${id}-h-${h.name}`
                  return (
                    <div key={h.name} className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        id={hid}
                        checked={selected.has(h.name)}
                        disabled={h.disabled}
                        onCheckedChange={(c) => toggle(h.name, c === true)}
                      />
                      <label htmlFor={hid} className={cn('min-w-0 truncate text-sm', h.disabled && 'text-muted-foreground')}>
                        {h.name}
                        {h.hint && <span className="ml-1 text-xs text-muted-foreground">{h.hint}</span>}
                      </label>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}
