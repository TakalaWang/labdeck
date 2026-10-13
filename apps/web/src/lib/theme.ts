import { useSyncExternalStore } from 'react'

// Theme store (light / dark / follow system). Runs inside the bundle — the site CSP
// forbids inline scripts, so there is no pre-paint <script> in index.html.

export type ThemeSetting = 'light' | 'dark' | 'system'
type Resolved = 'light' | 'dark'

const KEY = 'theme'
// Client-only module (the app shell is never server-rendered); guarded so a stray server import can't crash.
const mql = typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

function read(): ThemeSetting {
  try {
    if (typeof window === 'undefined') return 'system'
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

let setting: ThemeSetting = read()

const resolve = (): Resolved => (setting === 'system' ? (mql?.matches ? 'dark' : 'light') : setting)

function apply() {
  const r = resolve()
  const root = document.documentElement
  root.classList.toggle('dark', r === 'dark')
  root.style.colorScheme = r
}

function emit() {
  apply()
  for (const l of listeners) l()
}

mql?.addEventListener('change', () => {
  if (setting === 'system') emit()
})

/** Apply the stored theme; call once before the first render. */
export const initTheme = apply

export function setTheme(t: ThemeSetting) {
  setting = t
  try {
    if (t === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, t)
  } catch {
    // storage unavailable (private mode) — keep in memory only
  }
  emit()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useTheme(): { theme: ThemeSetting; resolvedTheme: Resolved; setTheme: typeof setTheme } {
  const snap = useSyncExternalStore(subscribe, () => `${setting}:${resolve()}`)
  const [theme, resolvedTheme] = snap.split(':') as [ThemeSetting, Resolved]
  return { theme, resolvedTheme, setTheme }
}
