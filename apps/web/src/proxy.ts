import { type NextRequest, NextResponse } from 'next/server'

// Content-Security-Policy for the pages (docs/design.md 約定 G): the former SPA's policy, plus a per-request nonce
// for Next.js's own inline bootstrap scripts ('strict-dynamic' lets them load the page chunks). No inline script
// of ours, no external origins. Caddy keeps the same policy as a fallback for responses that don't set one.
/**
 * Pages that moved into a tabbed section (docs/design.md, navigation): old path → [new path, ?tab=]. Their own
 * query parameters come along (/reports/gpu-monthly?month= → /usage?tab=monthly&month=), so bookmarks and the
 * links in notifications and the guide keep working.
 */
export const MOVED: Record<string, [string, string]> = {
  '/gpus': ['/usage', 'gpu'],
  '/disk': ['/usage', 'disk'],
  '/reports/gpu-monthly': ['/usage', 'monthly'],
  '/calendar': ['/announcements', 'calendar'],
  '/health': ['/admin/hosts', 'health'],
  '/admin/accounts': ['/admin/people', 'accounts'],
  '/admin/jobs': ['/admin/ops', 'jobs'],
  '/admin/announcements': ['/admin/ops', 'announcements'],
  '/admin/guide': ['/admin/ops', 'guide'],
  '/admin/audit': ['/admin/ops', 'audit'],
  '/admin/power': ['/admin/hosts', 'hosts'], // remote power control was removed
}

/** Where an old URL lives now; null when it didn't move. */
export function movedTo(pathname: string, search: URLSearchParams): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const target = MOVED[path]
  if (!target) return null
  const q = new URLSearchParams(search)
  if (path === '/admin/accounts' && q.has('tab')) {
    q.set('view', q.get('tab')!) // the old sub-tab (all, drift, uid…) is ?view= under 人員與帳號
  }
  q.set('tab', target[1])
  return `${target[0]}?${q}`
}

export function proxy(request: NextRequest) {
  const moved = movedTo(request.nextUrl.pathname, request.nextUrl.searchParams)
  if (moved) return NextResponse.redirect(new URL(moved, request.url), 307)
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const dev = process.env.NODE_ENV === 'development'
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('content-security-policy', csp)
  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('content-security-policy', csp)
  return response
}

export const config = {
  // pages only: the API, the auth redirects and static files set their own headers
  matcher: [
    {
      source: '/((?!api/|login$|auth/|_next/static|_next/image|favicon\\.svg|apple-touch-icon\\.png|icon-|manifest\\.webmanifest).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
