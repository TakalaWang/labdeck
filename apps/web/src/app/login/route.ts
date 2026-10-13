import { handle } from '@/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// No HEAD export: Next.js then routes HEAD to GET, and handle() answers HEAD with 405.

/** GET /login?next=/path → 302 to the OAuth provider (dev fixture mode: straight back as the mock admin). */
export async function GET(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_MOCK === '1') {
    const url = new URL(req.url)
    const next = url.searchParams.get('next') ?? '/'
    const target = new URL(next.startsWith('/') && !next.startsWith('//') ? next : '/', url)
    target.searchParams.set('mock_role', 'admin')
    return new Response(null, { status: 302, headers: { location: target.pathname + target.search } })
  }
  return handle(req)
}

export { handle as POST, handle as PUT, handle as DELETE, handle as PATCH, handle as OPTIONS }
