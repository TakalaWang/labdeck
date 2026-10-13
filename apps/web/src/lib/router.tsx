'use client'

// The few react-router APIs the pages used, on top of next/navigation (a mechanical port of the former SPA).
import NextLink from 'next/link'
import { useParams as useNextParams, usePathname, useRouter, useSearchParams as useNextSearchParams } from 'next/navigation'
import { type ComponentProps, useCallback, useEffect, useState } from 'react'

type LinkProps = Omit<ComponentProps<typeof NextLink>, 'href'> & { to: string; end?: boolean }

export function Link({ to, end: _end, ...props }: LinkProps) {
  void _end
  return <NextLink href={to} {...props} />
}

/** Active-state styling is done by the caller (SidebarMenuButton isActive). */
export const NavLink = Link

export function useNavigate() {
  const router = useRouter()
  return useCallback((to: string, opts?: { replace?: boolean }) => (opts?.replace ? router.replace(to) : router.push(to)), [router])
}

type ParamsInit = URLSearchParams | Record<string, string>

export function useSearchParams(): [URLSearchParams, (next: ParamsInit, opts?: { replace?: boolean }) => void] {
  const params = useNextSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const set = useCallback(
    (next: ParamsInit, opts?: { replace?: boolean }) => {
      const merged = new URLSearchParams(next as Record<string, string>)
      // ?tab= belongs to the section page (components/route-tabs): a view updating its own filters keeps it
      const tab = params?.get('tab')
      if (tab && !merged.has('tab')) merged.set('tab', tab)
      const qs = merged.toString()
      const url = qs ? `${pathname}?${qs}` : pathname
      if (opts?.replace) router.replace(url, { scroll: false })
      else router.push(url, { scroll: false })
    },
    [router, pathname, params],
  )
  return [new URLSearchParams(params?.toString() ?? ''), set]
}

export function useParams<T extends Record<string, string>>(): Partial<T> {
  const p = useNextParams() ?? {}
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, decode(Array.isArray(v) ? v.join('/') : (v ?? ''))])) as Partial<T>
}

/** pathname, search and hash (Next's hooks have no hash: read it from the window and follow hashchange). */
export function useLocation() {
  const pathname = usePathname() ?? '/'
  const search = useNextSearchParams()?.toString() ?? ''
  const [hash, setHash] = useState(() => (typeof window === 'undefined' ? '' : window.location.hash))
  useEffect(() => {
    const update = () => setHash(window.location.hash)
    update()
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [pathname])
  return { pathname, search: search ? `?${search}` : '', hash }
}
