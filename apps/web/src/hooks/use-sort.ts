import { useMemo, useState } from 'react'

export type SortDir = 'asc' | 'desc'

/** Client-side sort state for tables. `null`/undefined values always sort last. */
export function useSort<T>(rows: T[], initialKey: keyof T & string, initialDir: SortDir = 'desc') {
  type K = keyof T & string
  const [key, setKey] = useState<K>(initialKey)
  const [dir, setDir] = useState<SortDir>(initialDir)
  const sorted = useMemo(() => {
    const out = [...rows]
    out.sort((a, b) => {
      const va = a[key]
      const vb = b[key]
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'zh-TW', { numeric: true })
      return dir === 'asc' ? c : -c
    })
    return out
  }, [rows, key, dir])
  const toggle = (k: K) => {
    if (k === key) setDir(dir === 'asc' ? 'desc' : 'asc')
    else {
      setKey(k)
      setDir(typeof rows[0]?.[k] === 'number' ? 'desc' : 'asc')
    }
  }
  return { sorted, key, dir, toggle }
}
