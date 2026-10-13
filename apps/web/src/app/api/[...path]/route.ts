import { handle } from '@/server'

// The whole JSON API (docs/api.md) goes through one dispatcher, so unknown paths and methods answer with the
// API's own JSON 404 / 405 and every route shares the CSRF check, session cookie and security headers.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// No HEAD export: Next.js then routes HEAD to GET, and handle() answers HEAD with 405.

export { handle as GET, handle as POST, handle as PUT, handle as DELETE, handle as PATCH, handle as OPTIONS }
